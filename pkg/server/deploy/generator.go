// Package deploy generates Kubernetes manifests for inference
// deployments derived from rows in the model catalog (P16-A).
//
// The catalog row (store.Model) is the template — name, image,
// runtime, default args, recommended GPU shape. This package
// applies user-supplied DeployOptions on top and emits a fully
// specified set of unstructured manifests ready to send through
// the worker tunnel's apply path (handler.ApplyOneDoc).
//
// Outputs (in apply order):
//   - Namespace          (only if opts.CreateNamespace)
//   - PVC                (only if opts.PVC.Enabled, RWO + Retain)
//   - Secret             (only if opts.HFToken non-empty)
//   - Deployment         (always)
//   - Service            (always, ClusterIP, port 8000)
//
// Identity scheme is the same one [[doc:models.md]] describes:
//   - Deployment / Service / PVC / Secret all share the same name
//     `{model.name}` (when opts.Instance is empty) or
//     `{model.name}-{opts.Instance}` (when set). That name is a
//     DNS-1123 label since model.Name already is.
//   - All resources carry kpilot labels so the catalog UI can
//     fan out a list across clusters to find "what's deployed
//     where" without persisting deployment state server-side.
package deploy

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	runtime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	sigsyaml "sigs.k8s.io/yaml"

	"github.com/togettoyou/kpilot/pkg/server/store"
)

// GPUType identifies which K8s resource key the Deployment will
// request its GPUs against. NVIDIA's vanilla device plugin uses
// nvidia.com/gpu; KPilot's bundled volcano-vgpu-device-plugin
// uses the volcano.sh/vgpu-* triplet (slot, memory, cores) for
// fractional sharing.
type GPUType string

const (
	GPUTypeNvidia  GPUType = "nvidia"  // nvidia.com/gpu: N
	GPUTypeVolcano GPUType = "volcano" // volcano.sh/vgpu-number: N (+ vgpu-memory if known)
)

// PVCSpec sub-options for the model-weights cache PVC. When
// Enabled=false the Deployment uses emptyDir and re-downloads
// weights every cold start — fine for the smallest test models,
// painful for anything north of 10 GB.
type PVCSpec struct {
	Enabled          bool
	SizeGiB          int
	StorageClassName string // empty = cluster default
}

// DeployOptions is everything the handler layer collects from the
// drawer form plus a few helpers. The generator treats them as
// already-validated; the handler is responsible for length checks
// and DNS-label safety on Instance / Namespace.
type DeployOptions struct {
	ClusterID       string // for the Deployment label only — not used in manifest naming
	Namespace       string // target namespace; auto-created when CreateNamespace=true
	CreateNamespace bool

	Instance  string // optional suffix, see deployName(); empty = singleton
	Replicas  int32
	GPUCount  int
	GPUType   GPUType

	// CPU + memory request/limit as K8s quantity strings ("2", "4Gi",
	// "500m"). Empty = don't set that resource. Request defaults
	// can differ from limit so users can size for burst headroom;
	// the JobForm in /compute uses the same pair-of-strings shape.
	CPURequest    string
	CPULimit      string
	MemoryRequest string
	MemoryLimit   string

	// vGPU sub-resources for the Volcano vgpu device plugin. Only
	// honored when GPUType=Volcano. vgpu-memory is per-slot in MiB
	// (the volcano-vgpu-device-plugin's unit), vgpu-cores is per-slot
	// SM percentage (0..100). Both zero/unset = don't emit, kubelet
	// gives the requesting Pod whole-slot defaults.
	VGPUMemoryMiB int
	VGPUCores     int

	// HFToken, when non-empty, becomes a Secret + envFrom on the
	// container so gated models (Llama 4, Mistral 7B etc) can pull
	// from HuggingFace at startup.
	HFToken string

	// ExtraArgs append to the model's default_args list. Useful for
	// per-deployment tweaks ("this instance gets --max-model-len
	// 131072 because it's the long-context one") without forking the
	// catalog row.
	ExtraArgs []string

	PVC PVCSpec
}

// DeploymentBundle is the result of BuildManifests — both the
// unstructured docs (ready for applyOneDoc) and a YAML preview
// string the drawer's preview tab renders verbatim.
type DeploymentBundle struct {
	Manifests []*unstructured.Unstructured
	YAMLPreview string
	// DeploymentName + Namespace are echoed back so the handler
	// can put them in the response without re-deriving from opts.
	DeploymentName string
	Namespace      string
}

const (
	// containerPort is what vLLM / SGLang / TGI all listen on by
	// default in their official images. If a future runtime breaks
	// this convention we can fold it into a per-runtime constant.
	containerPort = 8000

	// hfCacheMount is where vLLM expects HuggingFace weights cached.
	// $HF_HOME overrides this but the PVC + Deployment env do the
	// same thing more transparently.
	hfCacheMount = "/root/.cache/huggingface"
)

// dnsLabel matches DNS-1123 label rules (lower / digits / hyphen,
// alphanumeric ends). Used for the optional Instance check inside
// the generator — the handler also validates upstream.
var dnsLabel = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// BuildManifests is the package entry point. Returns the unstructured
// docs in apply order + a YAML preview text suitable for the drawer.
func BuildManifests(model *store.Model, opts DeployOptions) (*DeploymentBundle, error) {
	if model == nil {
		return nil, errors.New("model is nil")
	}
	if opts.Replicas <= 0 {
		opts.Replicas = 1
	}
	if opts.GPUCount <= 0 {
		opts.GPUCount = 1
	}
	if opts.GPUType == "" {
		opts.GPUType = GPUTypeNvidia
	}
	if opts.Namespace == "" {
		opts.Namespace = "kpilot-inference"
	}
	if opts.Instance != "" && !dnsLabel.MatchString(opts.Instance) {
		return nil, fmt.Errorf("instance name must be a DNS-1123 label: %q", opts.Instance)
	}

	name := deployName(model.Name, opts.Instance)
	labels := buildLabels(model, opts.Instance, name)

	// Container args = model.DefaultArgs (already JSON array of
	// strings) merged with ExtraArgs + the runtime-specific model
	// flag built from HuggingFaceID. The model-path flag is
	// runtime-dependent (vLLM --model, SGLang --model-path, TGI
	// --model-id); we inject it here so custom rows pointing at a
	// local path can skip it (HuggingFaceID empty → no injection,
	// user must encode the path themselves in default_args).
	args, err := buildArgs(model, opts.ExtraArgs)
	if err != nil {
		return nil, fmt.Errorf("build args: %w", err)
	}

	out := make([]*unstructured.Unstructured, 0, 5)

	if opts.CreateNamespace {
		ns := buildNamespace(opts.Namespace)
		u, err := toUnstructured(ns)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}

	if opts.PVC.Enabled {
		pvc := buildPVC(name, opts.Namespace, labels, opts.PVC)
		u, err := toUnstructured(pvc)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}

	if opts.HFToken != "" {
		secret := buildHFSecret(name, opts.Namespace, labels, opts.HFToken)
		u, err := toUnstructured(secret)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}

	dep := buildDeployment(model, opts, name, labels, args)
	u, err := toUnstructured(dep)
	if err != nil {
		return nil, err
	}
	out = append(out, u)

	svc := buildService(name, opts.Namespace, labels)
	u, err = toUnstructured(svc)
	if err != nil {
		return nil, err
	}
	out = append(out, u)

	yamlText, err := marshalYAML(out)
	if err != nil {
		return nil, fmt.Errorf("marshal yaml: %w", err)
	}

	return &DeploymentBundle{
		Manifests:      out,
		YAMLPreview:    yamlText,
		DeploymentName: name,
		Namespace:      opts.Namespace,
	}, nil
}

// deployName joins model + optional instance into a single
// DNS-1123 safe name. Singleton = bare model name; instanced =
// `{model}-{instance}`. Both inputs are pre-validated DNS labels
// by the handler so the result fits the K8s 253-char total limit
// trivially.
func deployName(model, instance string) string {
	if instance == "" {
		return model
	}
	return model + "-" + instance
}

// buildLabels returns the canonical KPilot label set applied to
// every resource the generator emits. The docs/models.md table
// lists these:
//   - managed-by: kpilot
//   - name:       model.name
//   - instance:   the resource name (model OR model-instance)
//   - model-id:   numeric link back to the catalog row
//   - model-family: catalog grouping for filtered list queries
//
// Selector labels (the ones the Service matches against and the
// Deployment uses for podTemplate) intentionally use only
// app.kubernetes.io/name + instance so changing model-id (via
// edit) doesn't orphan running pods.
func buildLabels(model *store.Model, instance, fullName string) map[string]string {
	return map[string]string{
		"app.kubernetes.io/managed-by": "kpilot",
		"app.kubernetes.io/name":       model.Name,
		"app.kubernetes.io/instance":   fullName,
		"app.kubernetes.io/component":  "inference",
		"kpilot.io/model-id":           fmt.Sprintf("%d", model.ID),
		"kpilot.io/model-family":       string(model.Family),
		"kpilot.io/model-runtime":      string(model.Runtime),
		"kpilot.io/instance-suffix":    instance, // empty for singletons; helpful for queries
	}
}

func selectorLabels(modelName, fullName string) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":     modelName,
		"app.kubernetes.io/instance": fullName,
	}
}

// buildArgs joins default_args (JSON array string in the row) +
// the runtime-specific model-path flag + the user's ExtraArgs.
// Order: default first, then model-path, then user extras —
// later args win on flag conflicts (vLLM late-wins) so
// ExtraArgs can override defaults.
func buildArgs(model *store.Model, extra []string) ([]string, error) {
	out := []string{}
	if model.DefaultArgs != "" {
		var def []string
		if err := json.Unmarshal([]byte(model.DefaultArgs), &def); err != nil {
			return nil, fmt.Errorf("model.default_args is not a JSON string array: %w", err)
		}
		out = append(out, def...)
	}
	if model.HuggingFaceID != "" {
		modelFlag := ""
		switch model.Runtime {
		case store.ModelRuntimeVLLM:
			modelFlag = "--model"
		case store.ModelRuntimeSGLang:
			modelFlag = "--model-path"
		case store.ModelRuntimeTGI:
			modelFlag = "--model-id"
		default:
			return nil, fmt.Errorf("unknown runtime: %s", model.Runtime)
		}
		out = append(out, modelFlag, model.HuggingFaceID)
	}
	out = append(out, extra...)
	return out, nil
}

func buildNamespace(ns string) *corev1.Namespace {
	return &corev1.Namespace{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Namespace"},
		ObjectMeta: metav1.ObjectMeta{
			Name: ns,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "kpilot",
			},
		},
	}
}

func buildPVC(name, ns string, labels map[string]string, spec PVCSpec) *corev1.PersistentVolumeClaim {
	pvc := &corev1.PersistentVolumeClaim{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "PersistentVolumeClaim"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name + "-hf-cache",
			Namespace: ns,
			Labels:    labels,
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{
					corev1.ResourceStorage: resource.MustParse(fmt.Sprintf("%dGi", spec.SizeGiB)),
				},
			},
		},
	}
	if spec.StorageClassName != "" {
		s := spec.StorageClassName
		pvc.Spec.StorageClassName = &s
	}
	return pvc
}

func buildHFSecret(name, ns string, labels map[string]string, token string) *corev1.Secret {
	return &corev1.Secret{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Secret"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name + "-hf",
			Namespace: ns,
			Labels:    labels,
		},
		Type: corev1.SecretTypeOpaque,
		StringData: map[string]string{
			"HF_TOKEN": token,
		},
	}
}

func buildDeployment(
	model *store.Model,
	opts DeployOptions,
	name string,
	labels map[string]string,
	args []string,
) *appsv1.Deployment {
	selector := selectorLabels(model.Name, name)

	// Resources built up from three layers:
	//   1. CPU + memory: request + limit can differ (burst headroom)
	//   2. GPU count: extended resource, must be requests == limits
	//      (kubelet mirrors limit→request automatically — we set both
	//      so the manifest reads consistently in YAML preview)
	//   3. vGPU sub-resources (memory MiB / cores %): only when
	//      GPUType=Volcano, limit-only since they're extended resources
	requests := corev1.ResourceList{}
	limits := corev1.ResourceList{}
	// parseQty returns (zero, ok=false) on invalid input — we skip
	// the resource in that case rather than panic via MustParse.
	// The handler validates upstream too, but defensive coding here
	// means a future direct caller can't bring the server down with
	// a bad string.
	parseQty := func(s string) (resource.Quantity, bool) {
		if s == "" {
			return resource.Quantity{}, false
		}
		q, err := resource.ParseQuantity(s)
		if err != nil {
			return resource.Quantity{}, false
		}
		return q, true
	}
	if q, ok := parseQty(opts.CPURequest); ok {
		requests[corev1.ResourceCPU] = q
	}
	if q, ok := parseQty(opts.CPULimit); ok {
		limits[corev1.ResourceCPU] = q
	}
	if q, ok := parseQty(opts.MemoryRequest); ok {
		requests[corev1.ResourceMemory] = q
	}
	if q, ok := parseQty(opts.MemoryLimit); ok {
		limits[corev1.ResourceMemory] = q
	}
	switch opts.GPUType {
	case GPUTypeVolcano:
		gpu := *resource.NewQuantity(int64(opts.GPUCount), resource.DecimalSI)
		requests[corev1.ResourceName("volcano.sh/vgpu-number")] = gpu
		limits[corev1.ResourceName("volcano.sh/vgpu-number")] = gpu
		if opts.VGPUMemoryMiB > 0 {
			limits[corev1.ResourceName("volcano.sh/vgpu-memory")] = *resource.NewQuantity(int64(opts.VGPUMemoryMiB), resource.DecimalSI)
		}
		if opts.VGPUCores > 0 {
			limits[corev1.ResourceName("volcano.sh/vgpu-cores")] = *resource.NewQuantity(int64(opts.VGPUCores), resource.DecimalSI)
		}
	default:
		gpu := *resource.NewQuantity(int64(opts.GPUCount), resource.DecimalSI)
		requests[corev1.ResourceName("nvidia.com/gpu")] = gpu
		limits[corev1.ResourceName("nvidia.com/gpu")] = gpu
	}

	container := corev1.Container{
		Name:            "inference",
		Image:           model.Image,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Args:            args,
		Ports: []corev1.ContainerPort{
			{Name: "http", ContainerPort: containerPort, Protocol: corev1.ProtocolTCP},
		},
		Env: []corev1.EnvVar{
			{Name: "HF_HOME", Value: hfCacheMount},
		},
		Resources: corev1.ResourceRequirements{
			Limits:   limits,
			Requests: requests,
		},
		// Cold start can be many minutes (HF download for big
		// models). Readiness probe targets /health which vLLM /
		// SGLang both expose; TGI uses /health too. 5-minute
		// failureThreshold gives 10×30s = 5min before marking
		// not-ready, which is the floor for medium model
		// downloads.
		ReadinessProbe: &corev1.Probe{
			ProbeHandler: corev1.ProbeHandler{
				HTTPGet: &corev1.HTTPGetAction{
					Path: "/health",
					Port: intOrStringFromInt(containerPort),
				},
			},
			InitialDelaySeconds: 30,
			PeriodSeconds:       30,
			FailureThreshold:    10,
		},
	}

	// HF token Secret → envFrom so any future secret-named keys
	// (HF_HUB_TOKEN aliases etc) flow without touching the
	// Deployment.
	if opts.HFToken != "" {
		container.EnvFrom = append(container.EnvFrom, corev1.EnvFromSource{
			SecretRef: &corev1.SecretEnvSource{
				LocalObjectReference: corev1.LocalObjectReference{Name: name + "-hf"},
			},
		})
	}

	// PVC mount when enabled, emptyDir otherwise. Either way the
	// container sees a writable HF cache at /root/.cache/huggingface.
	volumes := []corev1.Volume{}
	if opts.PVC.Enabled {
		container.VolumeMounts = append(container.VolumeMounts, corev1.VolumeMount{
			Name:      "hf-cache",
			MountPath: hfCacheMount,
		})
		volumes = append(volumes, corev1.Volume{
			Name: "hf-cache",
			VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
					ClaimName: name + "-hf-cache",
				},
			},
		})
	} else {
		container.VolumeMounts = append(container.VolumeMounts, corev1.VolumeMount{
			Name:      "hf-cache",
			MountPath: hfCacheMount,
		})
		volumes = append(volumes, corev1.Volume{
			Name: "hf-cache",
			VolumeSource: corev1.VolumeSource{
				EmptyDir: &corev1.EmptyDirVolumeSource{},
			},
		})
	}

	// vLLM benefits from large /dev/shm for NCCL when tensor-
	// parallel > 1. We don't know TP size statically; mount a
	// 2 GiB tmpfs at /dev/shm unconditionally — harmless for
	// single-GPU cases and required for multi-GPU.
	container.VolumeMounts = append(container.VolumeMounts, corev1.VolumeMount{
		Name:      "dshm",
		MountPath: "/dev/shm",
	})
	dshmSize := resource.MustParse("2Gi")
	volumes = append(volumes, corev1.Volume{
		Name: "dshm",
		VolumeSource: corev1.VolumeSource{
			EmptyDir: &corev1.EmptyDirVolumeSource{
				Medium:    corev1.StorageMediumMemory,
				SizeLimit: &dshmSize,
			},
		},
	})

	return &appsv1.Deployment{
		TypeMeta: metav1.TypeMeta{APIVersion: "apps/v1", Kind: "Deployment"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: opts.Namespace,
			Labels:    labels,
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: ptrInt32(opts.Replicas),
			Selector: &metav1.LabelSelector{MatchLabels: selector},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					RestartPolicy: corev1.RestartPolicyAlways,
					Containers:    []corev1.Container{container},
					Volumes:       volumes,
				},
			},
		},
	}
}

func buildService(name, ns string, labels map[string]string) *corev1.Service {
	return &corev1.Service{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Service"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: ns,
			Labels:    labels,
		},
		Spec: corev1.ServiceSpec{
			Type: corev1.ServiceTypeClusterIP,
			// Same selector as the Deployment template — matches by
			// app.kubernetes.io/name + instance only so model-id /
			// runtime label edits don't break service routing.
			Selector: selectorLabels(labels["app.kubernetes.io/name"], labels["app.kubernetes.io/instance"]),
			Ports: []corev1.ServicePort{
				{
					Name:       "http",
					Port:       containerPort,
					TargetPort: intOrStringFromInt(containerPort),
					Protocol:   corev1.ProtocolTCP,
				},
			},
		},
	}
}

// toUnstructured marshals a typed K8s object to JSON then re-reads
// it as unstructured.Unstructured. Heavy-ish but it's only run at
// deploy time, and it gives the handler exactly the shape
// applyOneDoc already knows how to consume.
func toUnstructured(obj runtime.Object) (*unstructured.Unstructured, error) {
	data, err := json.Marshal(obj)
	if err != nil {
		return nil, err
	}
	u := &unstructured.Unstructured{}
	if err := u.UnmarshalJSON(data); err != nil {
		return nil, err
	}
	return u, nil
}

// marshalYAML stitches every doc into one multi-document YAML
// stream the preview tab renders verbatim. Uses sigs.k8s.io/yaml
// (the K8s-flavored marshaller) so int / quantity formatting
// matches what kubectl prints, avoiding "why does my preview
// look different from what landed in the cluster" confusion.
//
// We avoid sigs.k8s.io/yaml's package-level dep here in case the
// caller is generating manifests in a side path; doing the
// JSON-then-yaml hop manually is straightforward and keeps the
// package import surface small.
func marshalYAML(docs []*unstructured.Unstructured) (string, error) {
	var sb strings.Builder
	for i, d := range docs {
		if i > 0 {
			sb.WriteString("---\n")
		}
		b, err := sigsYAMLMarshal(d.Object)
		if err != nil {
			return "", err
		}
		sb.Write(b)
	}
	return sb.String(), nil
}

// ptrInt32 returns a pointer to its int32 argument — needed because
// Deployment.Spec.Replicas takes *int32.
func ptrInt32(v int32) *int32 { return &v }

// intOrStringFromInt wraps the apimachinery IntOrString shape used
// by Service / Probe port fields. Always-int variant since our
// ports are always integers, never named string ports.
func intOrStringFromInt(p int) intstr.IntOrString {
	return intstr.FromInt(p)
}

// sigsYAMLMarshal forwards to sigs.k8s.io/yaml so we keep the
// K8s-flavored marshaller behind one symbol and can swap it later
// without grep across the file.
func sigsYAMLMarshal(v any) ([]byte, error) { return sigsyaml.Marshal(v) }

// IsAlreadyExistsErr is a helper for the handler to pretty-print
// the "deployment already exists" case as a 409 Conflict instead of
// generic 500. apply with createOnly conflicts surface as
// apierrors.IsAlreadyExists.
func IsAlreadyExistsErr(err error) bool {
	return apierrors.IsAlreadyExists(err)
}
