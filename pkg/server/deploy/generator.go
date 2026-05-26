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
//   - PVC                (only if opts.PVC.Enabled AND source uses
//                        generator-managed cache — huggingface /
//                        modelscope. local_path / oci use opts.LocalPVCName
//                        which must already exist.)
//   - Secret             (only if opts.RegistryToken non-empty AND
//                        source is huggingface / modelscope)
//   - Deployment         (always; OCI source gets an ORAS initContainer)
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
	"path"
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

// PVCSpec sub-options for the model-files cache PVC. When
// Enabled=false the Deployment uses emptyDir and re-downloads the
// model every cold start — fine for the smallest test models,
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

	// RegistryToken, when non-empty, becomes a Secret + envFrom on
	// the container so gated models can be pulled at startup. The
	// env key is source-dependent:
	//   source=huggingface → HF_TOKEN
	//   source=modelscope  → MODELSCOPE_API_TOKEN
	//   source=local_path / oci → ignored (no Secret emitted)
	RegistryToken string

	// LocalPVCName is the cluster-side pre-existing PVC to mount
	// when source=local_path (required) or source=oci (optional —
	// when set, OCI pulls are persisted across pod restarts).
	// Ignored for source=huggingface / modelscope (those use the
	// PVC sub-spec below).
	LocalPVCName string

	// ExtraArgs append to the model's default_args list. Useful for
	// per-deployment tweaks ("this instance gets --max-model-len
	// 131072 because it's the long-context one") without forking the
	// catalog row.
	ExtraArgs []string

	// PVC controls a generator-managed cache PVC. Only honored for
	// source=huggingface / modelscope; the other sources use
	// LocalPVCName above.
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
	// containerPort is vLLM's default OpenAI-compatible HTTP port.
	containerPort = 8000

	// hfCacheMount is where vLLM expects the HuggingFace model cache.
	// $HF_HOME overrides this but the PVC + Deployment env do the
	// same thing more transparently.
	hfCacheMount = "/root/.cache/huggingface"

	// msCacheMount is where vLLM expects the ModelScope model cache
	// when VLLM_USE_MODELSCOPE=True. $MODELSCOPE_CACHE overrides it.
	msCacheMount = "/root/.cache/modelscope"

	// ociWeightsMount is the fixed in-container path the ORAS
	// initContainer pulls into; the main container reads the model
	// from here via --model /weights. (The path itself is fixed to
	// /weights for backward-compat with operators who might inspect
	// the manifest — the directory name is opaque to vLLM.)
	ociWeightsMount = "/weights"

	// orasImage is the ORAS CLI image used by the OCI initContainer.
	// Pinned to a specific release so a registry-side mutable tag
	// can't change behavior under us. Operators on air-gapped
	// networks may need to mirror this to their own registry — see
	// docs/models.md.
	orasImage = "ghcr.io/oras-project/oras:v1.2.0"
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

	// Default source to huggingface so legacy callers (none in-tree,
	// but conceivable for direct package consumers) don't get a
	// confusing "unknown source: ''" error.
	src := model.Source
	if src == "" {
		src = store.ModelSourceHuggingFace
	}

	// Per-source preconditions surface here as a 400 to the operator
	// (handler validates the same things upstream; we re-check so a
	// future direct caller can't bypass them).
	switch src {
	case store.ModelSourceHuggingFace, store.ModelSourceModelScope:
		if model.SourceRef == "" {
			return nil, fmt.Errorf("source=%s requires source_ref (the hub repo id)", src)
		}
	case store.ModelSourceLocalPath:
		if model.LocalPath == "" {
			return nil, fmt.Errorf("source=local_path requires model.local_path")
		}
		if opts.LocalPVCName == "" {
			return nil, fmt.Errorf("source=local_path requires deploy option local_pvc_name (pre-existing PVC mounting the model files)")
		}
		// LocalPath must be at least /a/b — we mount the PVC at
		// path.Dir(LocalPath), so the parent must be a real dir
		// (not "/"). Reject root-level paths early so the
		// generator's mount logic stays simple.
		if path.Dir(model.LocalPath) == "/" || path.Dir(model.LocalPath) == "." {
			return nil, fmt.Errorf("source=local_path requires model.local_path to be at least two segments (e.g. /models/qwen3)")
		}
	case store.ModelSourceOCI:
		if model.OCIURL == "" {
			return nil, fmt.Errorf("source=oci requires model.oci_url")
		}
	default:
		return nil, fmt.Errorf("unknown source: %s", src)
	}

	name := deployName(model.Name, opts.Instance)
	labels := buildLabels(model, opts.Instance, name)

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

	// Generator-managed PVC only for hub sources. local_path uses
	// the user-supplied PVC (must already exist); OCI either uses
	// opts.LocalPVCName for persistence or emptyDir for transient.
	if opts.PVC.Enabled && (src == store.ModelSourceHuggingFace || src == store.ModelSourceModelScope) {
		pvc := buildPVC(name, opts.Namespace, labels, opts.PVC, src)
		u, err := toUnstructured(pvc)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}

	// Registry token Secret only meaningful for hub sources. The
	// env key (HF_TOKEN vs MODELSCOPE_API_TOKEN) is set on the
	// Secret data so envFrom transparently picks the right name.
	if opts.RegistryToken != "" && (src == store.ModelSourceHuggingFace || src == store.ModelSourceModelScope) {
		secret := buildRegistrySecret(name, opts.Namespace, labels, opts.RegistryToken, src)
		u, err := toUnstructured(secret)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}

	dep := buildDeployment(model, opts, name, labels, args, src)
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
// the source-specific `--model` value + the user's ExtraArgs.
// Order: default first, then --model, then user extras — later
// args win on flag conflicts (vLLM late-wins) so ExtraArgs can
// override defaults.
//
// `--model` value per source:
//
//	huggingface → SourceRef (HF repo id)
//	modelscope  → SourceRef (MS repo id)
//	local_path  → LocalPath (in-container absolute path)
//	oci         → ociWeightsMount ("/weights", initContainer fills it)
func buildArgs(model *store.Model, extra []string) ([]string, error) {
	if model.Runtime != store.ModelRuntimeVLLM {
		return nil, fmt.Errorf("unsupported runtime: %s", model.Runtime)
	}
	out := []string{}
	if model.DefaultArgs != "" {
		var def []string
		if err := json.Unmarshal([]byte(model.DefaultArgs), &def); err != nil {
			return nil, fmt.Errorf("model.default_args is not a JSON string array: %w", err)
		}
		out = append(out, def...)
	}
	var modelArg string
	switch model.Source {
	case store.ModelSourceLocalPath:
		modelArg = model.LocalPath
	case store.ModelSourceOCI:
		modelArg = ociWeightsMount
	default: // huggingface, modelscope, "" (legacy)
		modelArg = model.SourceRef
	}
	if modelArg != "" {
		out = append(out, "--model", modelArg)
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

// buildPVC emits the generator-managed model-file cache. The PVC
// name suffix encodes the source so a future "share PVC across
// instances of the same model" feature can key on it without
// renaming live PVCs.
func buildPVC(name, ns string, labels map[string]string, spec PVCSpec, src store.ModelSource) *corev1.PersistentVolumeClaim {
	suffix := "-hf-cache"
	if src == store.ModelSourceModelScope {
		suffix = "-ms-cache"
	}
	pvc := &corev1.PersistentVolumeClaim{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "PersistentVolumeClaim"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name + suffix,
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

// buildRegistrySecret holds the auth token for the model source's
// hub. The env key picked here flows through envFrom: HF's vLLM
// integration reads HF_TOKEN; ModelScope's reads MODELSCOPE_API_TOKEN.
// Wrong key = silent un-auth = 401 from the registry; matching by
// source is the only reliable contract.
func buildRegistrySecret(name, ns string, labels map[string]string, token string, src store.ModelSource) *corev1.Secret {
	envKey := "HF_TOKEN"
	suffix := "-hf"
	if src == store.ModelSourceModelScope {
		envKey = "MODELSCOPE_API_TOKEN"
		suffix = "-ms"
	}
	return &corev1.Secret{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Secret"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      name + suffix,
			Namespace: ns,
			Labels:    labels,
		},
		Type: corev1.SecretTypeOpaque,
		StringData: map[string]string{
			envKey: token,
		},
	}
}

func buildDeployment(
	model *store.Model,
	opts DeployOptions,
	name string,
	labels map[string]string,
	args []string,
	src store.ModelSource,
) *appsv1.Deployment {
	selector := selectorLabels(model.Name, name)

	// Resources built up in two layers:
	//   1. CPU + memory: request + limit can differ (burst headroom)
	//   2. GPU resources (nvidia.com/gpu or volcano.sh/vgpu-*): K8s
	//      mirrors limits → requests for extended resources at admission
	//      time (requests==limits is mandatory), so we follow the
	//      upstream convention and only emit them under `limits`.
	//      NVIDIA's device-plugin README + Volcano vGPU docs + HAMi
	//      volcano-vgpu-device-plugin README all show limits-only.
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
	gpuCount := *resource.NewQuantity(int64(opts.GPUCount), resource.DecimalSI)
	switch opts.GPUType {
	case GPUTypeVolcano:
		limits[corev1.ResourceName("volcano.sh/vgpu-number")] = gpuCount
		if opts.VGPUMemoryMiB > 0 {
			limits[corev1.ResourceName("volcano.sh/vgpu-memory")] = *resource.NewQuantity(int64(opts.VGPUMemoryMiB), resource.DecimalSI)
		}
		if opts.VGPUCores > 0 {
			limits[corev1.ResourceName("volcano.sh/vgpu-cores")] = *resource.NewQuantity(int64(opts.VGPUCores), resource.DecimalSI)
		}
	default:
		limits[corev1.ResourceName("nvidia.com/gpu")] = gpuCount
	}

	// Env per source. HF_ENDPOINT (mirror) is huggingface-specific
	// and only set when non-empty so the upstream default kicks in
	// for users who left it blank.
	env := []corev1.EnvVar{}
	switch src {
	case store.ModelSourceHuggingFace:
		env = append(env, corev1.EnvVar{Name: "HF_HOME", Value: hfCacheMount})
		if model.HFEndpoint != "" {
			env = append(env, corev1.EnvVar{Name: "HF_ENDPOINT", Value: model.HFEndpoint})
		}
	case store.ModelSourceModelScope:
		env = append(env,
			corev1.EnvVar{Name: "VLLM_USE_MODELSCOPE", Value: "True"},
			corev1.EnvVar{Name: "MODELSCOPE_CACHE", Value: msCacheMount},
		)
	}

	container := corev1.Container{
		Name:            "inference",
		Image:           model.Image,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Args:            args,
		Ports: []corev1.ContainerPort{
			{Name: "http", ContainerPort: containerPort, Protocol: corev1.ProtocolTCP},
		},
		Env: env,
		Resources: corev1.ResourceRequirements{
			Limits:   limits,
			Requests: requests,
		},
		// Cold start can be many minutes (HF download for big
		// models). Readiness probe targets vLLM's /health endpoint.
		// 5-minute failureThreshold gives 10×30s = 5min before
		// marking not-ready, which is the floor for medium model
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

	// Registry token Secret → envFrom only for hub sources. Local
	// path / OCI sources don't need auth (the model is already in
	// the cluster or pulled via initContainer with its own auth).
	if opts.RegistryToken != "" && (src == store.ModelSourceHuggingFace || src == store.ModelSourceModelScope) {
		suffix := "-hf"
		if src == store.ModelSourceModelScope {
			suffix = "-ms"
		}
		container.EnvFrom = append(container.EnvFrom, corev1.EnvFromSource{
			SecretRef: &corev1.SecretEnvSource{
				LocalObjectReference: corev1.LocalObjectReference{Name: name + suffix},
			},
		})
	}

	// Model-file volume layout differs per source:
	//   huggingface: cache PVC (or emptyDir) → /root/.cache/huggingface
	//   modelscope:  cache PVC (or emptyDir) → /root/.cache/modelscope
	//   local_path:  pre-existing PVC → path.Dir(model.LocalPath), read-only
	//   oci:         emptyDir or LocalPVCName → /weights, ORAS initContainer fills it
	volumes := []corev1.Volume{}
	var initContainers []corev1.Container

	switch src {
	case store.ModelSourceHuggingFace, store.ModelSourceModelScope:
		mountPath := hfCacheMount
		volSuffix := "-hf-cache"
		if src == store.ModelSourceModelScope {
			mountPath = msCacheMount
			volSuffix = "-ms-cache"
		}
		container.VolumeMounts = append(container.VolumeMounts, corev1.VolumeMount{
			Name:      "weights-cache",
			MountPath: mountPath,
		})
		if opts.PVC.Enabled {
			volumes = append(volumes, corev1.Volume{
				Name: "weights-cache",
				VolumeSource: corev1.VolumeSource{
					PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
						ClaimName: name + volSuffix,
					},
				},
			})
		} else {
			volumes = append(volumes, corev1.Volume{
				Name:         "weights-cache",
				VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
			})
		}

	case store.ModelSourceLocalPath:
		// Mount the operator-supplied PVC read-only at the parent
		// directory of LocalPath. So LocalPath="/models/qwen3" →
		// mount at "/models" and the operator's PVC must contain
		// the model files at the relative subpath "qwen3/". RO so
		// the inference container can't corrupt the shared model
		// across other readers of the same PVC.
		mountPath := path.Dir(model.LocalPath)
		container.VolumeMounts = append(container.VolumeMounts, corev1.VolumeMount{
			Name:      "weights-local",
			MountPath: mountPath,
			ReadOnly:  true,
		})
		volumes = append(volumes, corev1.Volume{
			Name: "weights-local",
			VolumeSource: corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
					ClaimName: opts.LocalPVCName,
					ReadOnly:  true,
				},
			},
		})

	case store.ModelSourceOCI:
		// ORAS initContainer pulls the OCI artifact (the model files
		// packaged as an OCI image) into /weights before the main
		// container starts. emptyDir = re-pull on every Pod restart;
		// LocalPVCName = persist across restarts.
		container.VolumeMounts = append(container.VolumeMounts, corev1.VolumeMount{
			Name:      "weights-oci",
			MountPath: ociWeightsMount,
		})
		ociVol := corev1.Volume{Name: "weights-oci"}
		if opts.LocalPVCName != "" {
			ociVol.VolumeSource = corev1.VolumeSource{
				PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{
					ClaimName: opts.LocalPVCName,
				},
			}
		} else {
			ociVol.VolumeSource = corev1.VolumeSource{
				EmptyDir: &corev1.EmptyDirVolumeSource{},
			}
		}
		volumes = append(volumes, ociVol)
		initContainers = append(initContainers, corev1.Container{
			Name:    "oras-pull",
			Image:   orasImage,
			Command: []string{"oras"},
			// `pull -o /weights` lays the artifact files directly
			// under /weights. Operators wanting auth need to bake
			// `.docker/config.json` into a Secret + projected volume
			// — out of P-Source-2's MVP scope; document as a known
			// limitation.
			Args: []string{"pull", "-o", ociWeightsMount, model.OCIURL},
			VolumeMounts: []corev1.VolumeMount{
				{Name: "weights-oci", MountPath: ociWeightsMount},
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

	podSpec := corev1.PodSpec{
		RestartPolicy:  corev1.RestartPolicyAlways,
		InitContainers: initContainers, // nil for non-OCI sources; K8s elides the field
		Containers:     []corev1.Container{container},
		Volumes:        volumes,
	}
	// Volcano vGPU requires the Volcano scheduler — the device plugin
	// reads vgpu-memory / vgpu-cores assignments off Volcano-set pod
	// annotations and falls back to a "cannot get valid pod" rpc
	// error from kubelet's Allocate path when default-scheduler is
	// the one that admitted the pod. Setting SchedulerName here is
	// the missing step; the user does not need to opt in separately.
	if opts.GPUType == GPUTypeVolcano {
		podSpec.SchedulerName = "volcano"
	}

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
				Spec:       podSpec,
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
