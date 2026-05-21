// Package handler — model deployment (P16-A).
//
// Generates a Deployment + Service (optional PVC + Secret) from a
// catalog Model row and a small DeployRequest payload, then walks
// applyOneDoc against the target cluster's worker tunnel. Source
// of truth for "what's deployed where" is the cluster itself —
// no ModelDeployment table; the labels the generator stamps
// (`app.kubernetes.io/managed-by=kpilot`, `kpilot.io/model-id=N`)
// let a later phase fan out a list query without our DB caring.
package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/togettoyou/kpilot/pkg/server/deploy"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

// dnsLabelRe and the length caps live next to the validator since
// the drawer enforces the same shape; keep both in sync.
var dnsLabelRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

const (
	maxDeployInstanceLen  = 30          // model.Name is up to 63; instance up to 30 keeps the joined name within K8s' 63 label cap
	maxDeployNamespaceLen = 63
	maxDeployExtraArgsLen = 8 * 1024    // mirrors maxModelDefaultArgsLen — user's per-deploy override
	maxDeployHFTokenLen   = 200         // HF tokens are typically ~40 chars; cap with headroom
	maxDeployReplicas     = 32          // sanity ceiling — beyond this is a cluster scaling story, not P16
	maxDeployGPUCount     = 16          // single Pod cap; multi-node would need a Job not a Deployment
	maxDeployPVCSizeGiB   = 4096        // 4 TiB ceiling so a typo doesn't request 999999 GiB
	maxDeployQtyLen       = 32          // K8s quantity strings ("4Gi", "500m", "2") are short; mirrors JobForm
	maxDeployVGPUMemMiB   = 1 << 20     // 1 TiB in MiB — single-slot ceiling far past any real card
)

// deployRequest is the wire shape of POST /api/v1/models/:id/deploy.
// Field names are snake_case to match the rest of the API. PVC has
// its own nested shape so a future "share weights across deploys"
// option (RWX, claimName override) can land without changing the
// top-level surface.
type deployRequest struct {
	ClusterID       string   `json:"cluster_id" binding:"required"`
	Namespace       string   `json:"namespace"`
	CreateNamespace bool     `json:"create_namespace"`
	Instance        string   `json:"instance"`
	Replicas        int32    `json:"replicas"`
	GPUCount        int      `json:"gpu_count"`
	GPUType         string   `json:"gpu_type"` // "nvidia" | "volcano"
	// CPU / memory request / limit as K8s quantity strings ("2",
	// "500m", "4Gi"). Empty omits that resource. Each side
	// validated through resource.ParseQuantity below.
	CPURequest    string `json:"cpu_request"`
	CPULimit      string `json:"cpu_limit"`
	MemoryRequest string `json:"memory_request"`
	MemoryLimit   string `json:"memory_limit"`
	// vGPU sub-resources — only honored when gpu_type=volcano.
	// vgpu_memory_mib is per-slot MiB (vgpu device plugin's unit),
	// vgpu_cores is 0..100 percent of SMs per slot.
	VGPUMemoryMiB int      `json:"vgpu_memory_mib"`
	VGPUCores     int      `json:"vgpu_cores"`
	HFToken       string   `json:"hf_token"`
	ExtraArgs     []string `json:"extra_args"`
	PVC           pvcReq   `json:"pvc"`
}

type pvcReq struct {
	Enabled          bool   `json:"enabled"`
	SizeGiB          int    `json:"size_gib"`
	StorageClassName string `json:"storage_class_name"`
}

// validate runs the per-field shape + length guards. Returns the
// apiErr code (empty = OK) so callers do `if code := req.validate(); code != ""`.
func (r *deployRequest) validate() string {
	if utf8.RuneCountInString(r.ClusterID) == 0 {
		return CodeInvalidRequest
	}
	if r.Instance != "" {
		if len(r.Instance) > maxDeployInstanceLen || !dnsLabelRe.MatchString(r.Instance) {
			return CodeInvalidRequest
		}
	}
	if r.Namespace != "" {
		if len(r.Namespace) > maxDeployNamespaceLen || !dnsLabelRe.MatchString(r.Namespace) {
			return CodeInvalidRequest
		}
	}
	if r.Replicas < 0 || r.Replicas > maxDeployReplicas {
		return CodeInvalidRequest
	}
	if r.GPUCount < 0 || r.GPUCount > maxDeployGPUCount {
		return CodeInvalidRequest
	}
	if r.GPUType != "" && r.GPUType != "nvidia" && r.GPUType != "volcano" {
		return CodeInvalidRequest
	}
	if len(r.HFToken) > maxDeployHFTokenLen {
		return CodeInvalidRequest
	}
	if r.PVC.Enabled {
		if r.PVC.SizeGiB <= 0 || r.PVC.SizeGiB > maxDeployPVCSizeGiB {
			return CodeInvalidRequest
		}
		if r.PVC.StorageClassName != "" && len(r.PVC.StorageClassName) > maxDeployNamespaceLen {
			return CodeInvalidRequest
		}
	}
	// Quantity strings — length cap + parse-check. Length stops a
	// runaway request from blowing memory in ParseQuantity; the
	// parse stops "4Q" from getting all the way to the generator
	// where it'd silently drop.
	for _, q := range []string{r.CPURequest, r.CPULimit, r.MemoryRequest, r.MemoryLimit} {
		if q == "" {
			continue
		}
		if len(q) > maxDeployQtyLen {
			return CodeInvalidRequest
		}
		if _, err := resource.ParseQuantity(q); err != nil {
			return CodeInvalidRequest
		}
	}
	// vGPU sub-resources: only meaningful with volcano, but we
	// still range-check the values when present so a stale form
	// state (user picked volcano, filled values, switched to
	// nvidia) doesn't get rejected — generator just drops them.
	if r.VGPUMemoryMiB < 0 || r.VGPUMemoryMiB > maxDeployVGPUMemMiB {
		return CodeInvalidRequest
	}
	if r.VGPUCores < 0 || r.VGPUCores > 100 {
		return CodeInvalidRequest
	}
	// extra_args: cap total serialized length so a runaway request
	// can't blow up the manifest. Each arg also gets a per-element
	// cap so one giant 8 KiB arg doesn't consume the whole budget.
	total := 0
	for _, a := range r.ExtraArgs {
		if len(a) > 1024 {
			return CodeInvalidRequest
		}
		total += len(a)
	}
	if total > maxDeployExtraArgsLen {
		return CodeInvalidRequest
	}
	return ""
}

// deployResponse is the wire shape returned on both dry_run and
// real applies. Manifests + YAMLPreview are always populated;
// ApplyResults is non-nil only when we actually applied. The
// frontend uses Applied to decide whether to navigate to the
// workloads page or just show the preview.
type deployResponse struct {
	DeploymentName string                 `json:"deployment_name"`
	Namespace      string                 `json:"namespace"`
	YAMLPreview    string                 `json:"yaml_preview"`
	Applied        bool                   `json:"applied"`
	ApplyResults   []ApplyYamlResult      `json:"apply_results,omitempty"`
}

// DeployModel handles POST /api/v1/models/:id/deploy. Optional
// `?dry_run=true` returns the generated manifests + YAML preview
// without touching the cluster — used by the drawer's preview tab.
func DeployModel(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseModelID(c)
		if err != nil {
			return
		}
		model, err := store.GetModelByID(id)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				apiErr(c, http.StatusNotFound, CodeModelNotFound)
				return
			}
			apiErrInternal(c, err)
			return
		}

		var req deployRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		if code := req.validate(); code != "" {
			apiErr(c, http.StatusBadRequest, code)
			return
		}

		gpuType := deploy.GPUTypeNvidia
		if req.GPUType == "volcano" {
			gpuType = deploy.GPUTypeVolcano
		}

		opts := deploy.DeployOptions{
			ClusterID:       req.ClusterID,
			Namespace:       req.Namespace,
			CreateNamespace: req.CreateNamespace,
			Instance:        req.Instance,
			Replicas:        req.Replicas,
			GPUCount:        req.GPUCount,
			GPUType:         gpuType,
			CPURequest:      req.CPURequest,
			CPULimit:        req.CPULimit,
			MemoryRequest:   req.MemoryRequest,
			MemoryLimit:     req.MemoryLimit,
			VGPUMemoryMiB:   req.VGPUMemoryMiB,
			VGPUCores:       req.VGPUCores,
			HFToken:         req.HFToken,
			ExtraArgs:       req.ExtraArgs,
			PVC: deploy.PVCSpec{
				Enabled:          req.PVC.Enabled,
				SizeGiB:          req.PVC.SizeGiB,
				StorageClassName: req.PVC.StorageClassName,
			},
		}

		bundle, err := deploy.BuildManifests(model, opts)
		if err != nil {
			// Generator errors are user-input shape issues (JSON
			// in default_args is bad, unknown runtime, etc) — bubble
			// up as 400 with the raw reason so the drawer can show it.
			apiErrDetail(c, http.StatusBadRequest, CodeInvalidRequest, err.Error())
			return
		}

		resp := deployResponse{
			DeploymentName: bundle.DeploymentName,
			Namespace:      bundle.Namespace,
			YAMLPreview:    bundle.YAMLPreview,
		}

		// Dry-run path: hand back the preview without ever
		// touching the cluster. Drawer's preview tab uses this.
		if c.Query("dry_run") == "true" {
			c.JSON(http.StatusOK, resp)
			return
		}

		// Real apply — fan applyOneDoc across every generated doc.
		// applyOneDoc is fail-soft per doc (matches ApplyYAML
		// semantics); the response carries individual results so
		// the drawer can show "Deployment ok, Service ok, PVC
		// failed because no default StorageClass" rather than just
		// "deploy failed".
		results := make([]ApplyYamlResult, 0, len(bundle.Manifests))
		for i, obj := range bundle.Manifests {
			results = append(results, applyOneDoc(c.Request.Context(), gw, req.ClusterID, i, obj))
		}
		resp.Applied = true
		resp.ApplyResults = results
		c.JSON(http.StatusOK, resp)
	}
}

// listDeploymentsTimeout caps the per-cluster fan-out — long enough
// for a slow cross-border tunnel to return a Deployment list, short
// enough that a wedged worker can't stall the whole catalog page.
// The drawer can refresh on demand if a cluster slipped past it.
const listDeploymentsTimeout = 8 * time.Second

// modelInstance is one inference deployment row returned to the
// frontend. Cluster-scoped fields are flattened (cluster_id +
// cluster_name) so the frontend can group either by cluster or
// show a flat list. Replicas + ready_replicas come straight out
// of `status` — no extra Pod list needed for v1.
type modelInstance struct {
	// Model identity (per-row since the aggregate listing can
	// span multiple models). ModelDisplayName / ModelFamily come
	// from the DB lookup so the table can show "Qwen3-0.6B" + a
	// family chip without an extra round-trip per row.
	// ModelDisplayName falls back to the deployment name when the
	// catalog row was deleted but the cluster still has the
	// deployment (orphan); ModelFamily becomes empty string then.
	ModelID          int64  `json:"model_id"`
	ModelDisplayName string `json:"model_display_name"`
	ModelFamily      string `json:"model_family,omitempty"`
	ModelRuntime     string `json:"model_runtime,omitempty"`
	// ModelField is the exact string the inference Service expects
	// in `chat/completions` request body's `model` field. vLLM /
	// SGLang / TGI start with `--model <HuggingFaceID>` (or the
	// runtime's equivalent flag), so the served model name == the
	// HF id. Falls back to deployment name when HF id is empty
	// (custom rows without an HF source); orphan rows (catalog
	// gone) also fall back to deployment name. Empty value would
	// always 404 in vLLM — we keep this server-side so the chat
	// page doesn't have to know about runtime quirks.
	ModelField string `json:"model_field"`

	ClusterID         string    `json:"cluster_id"`
	ClusterName       string    `json:"cluster_name"`
	Namespace         string    `json:"namespace"`
	Name              string    `json:"name"`
	InstanceSuffix    string    `json:"instance_suffix"`
	Image             string    `json:"image,omitempty"`
	Replicas          int32     `json:"replicas"`
	ReadyReplicas     int32     `json:"ready_replicas"`
	AvailableReplicas int32     `json:"available_replicas"`
	CreatedAt         time.Time `json:"created_at"`
	// ServicePort hardcoded to 8000 in deploy.buildService — the
	// frontend uses this to construct the chat URL without having
	// to fan out a second Service list. If we ever expose port as
	// a deploy option this needs to come from the Service.
	ServicePort int32 `json:"service_port"`
	// Status is the rolled-up condition we show in the table:
	// "Running" (ready==spec), "Progressing" (ready<spec but progressing),
	// "Failed" (status has a non-progressing condition). Pure derived
	// state; the frontend doesn't need to walk conditions itself.
	Status string `json:"status"`
}

type modelInstancesResponse struct {
	Instances []modelInstance `json:"instances"`
	// Errors lists clusters we tried but failed (worker offline,
	// list timeout, RBAC missing apps/v1). The frontend renders
	// this as an inline warning so users see "we tried 5 clusters,
	// 1 was offline" rather than silently missing rows.
	Errors []modelInstanceErr `json:"errors,omitempty"`
}

type modelInstanceErr struct {
	ClusterID   string `json:"cluster_id"`
	ClusterName string `json:"cluster_name"`
	Error       string `json:"error"`
}

// ListAllDeployments handles GET /api/v1/models/deployments
// [?model_id=N]. Fans out a labelled Deployment list across
// every online worker, merging into a flat row array. Two query
// modes share one handler:
//
//   - no model_id          → label selector requires only
//                            `app.kubernetes.io/managed-by=kpilot,
//                            app.kubernetes.io/component=inference`.
//                            Used by the platform-level deployments
//                            page (cross-model survey).
//   - ?model_id=N          → narrows with `kpilot.io/model-id=N`.
//                            Used by anything that wants only one
//                            model's instances.
//
// The per-row Model* fields come from a single up-front
// `store.ListModels` so we don't fan out N+1 DB lookups when the
// listing covers many models. Orphan deployments (model row
// deleted but cluster still has the Deployment) fall back to the
// deployment name as ModelDisplayName + empty family.
//
// Offline clusters are silently skipped (the cluster page is the
// place to see online/offline state). Worker errors land in the
// errors array so a partial result is still useful.
func ListAllDeployments(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Build the selector — always require managed-by+component;
		// optionally narrow to a single model.
		selector := "app.kubernetes.io/managed-by=kpilot,app.kubernetes.io/component=inference"
		if mid := c.Query("model_id"); mid != "" {
			id, err := strconv.ParseUint(mid, 10, 64)
			if err != nil {
				apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
				return
			}
			selector += fmt.Sprintf(",kpilot.io/model-id=%d", id)
		}

		clusters, err := store.ListClusters()
		if err != nil {
			apiErrInternal(c, err)
			return
		}

		// Pre-load all catalog rows once so per-row enrichment is
		// an O(1) map lookup. ListModels("","") returns built-ins
		// + custom; small (~12-30 rows), cheap.
		models, err := store.ListModels("", "")
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		modelsByID := make(map[uint]*store.Model, len(models))
		for i := range models {
			modelsByID[models[i].ID] = &models[i]
		}

		var (
			mu        sync.Mutex
			instances []modelInstance
			errs      []modelInstanceErr
			wg        sync.WaitGroup
		)

		for i := range clusters {
			cl := clusters[i]
			// Skip offline workers up-front so we don't burn a
			// full timeout per cluster. SendResourceRequest would
			// fail fast with "not connected" anyway, but doing
			// the check here keeps the errors list cleaner —
			// offline is the cluster page's job to surface.
			if _, ok := gw.GetWorker(cl.ID); !ok {
				continue
			}
			wg.Add(1)
			go func(cl store.Cluster) {
				defer wg.Done()
				ctx, cancel := context.WithTimeout(c.Request.Context(), listDeploymentsTimeout)
				defer cancel()
				rows, err := listInstancesInCluster(ctx, gw, &cl, selector, modelsByID)
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					errs = append(errs, modelInstanceErr{
						ClusterID:   cl.ID,
						ClusterName: cl.Name,
						Error:       err.Error(),
					})
					return
				}
				instances = append(instances, rows...)
			}(cl)
		}
		wg.Wait()

		c.JSON(http.StatusOK, modelInstancesResponse{
			Instances: instances,
			Errors:    errs,
		})
	}
}

// listInstancesInCluster runs one list-full against apps/v1
// Deployment with the label selector, then maps each item to a
// modelInstance. We use list-full (not Table API) because Table
// API drops .spec.template.spec.containers[0].image and
// .status.{readyReplicas,availableReplicas} that we need for the
// row. The selector is narrow so payload stays small.
//
// modelsByID enriches each row with display name + family without
// a per-row DB hit. Rows whose `kpilot.io/model-id` label points
// at a deleted catalog row keep ModelID=0 + ModelDisplayName =
// deployment name (orphan presentation) so the table still
// surfaces them.
func listInstancesInCluster(
	ctx context.Context,
	gw *gateway.GatewayServer,
	cl *store.Cluster,
	selector string,
	modelsByID map[uint]*store.Model,
) ([]modelInstance, error) {
	resp, err := gw.SendResourceRequest(ctx, cl.ID, &gateway.ResourceRequest{
		Action:        "list-full",
		Group:         "apps",
		Version:       "v1",
		Kind:          "Deployment",
		Namespace:     "", // empty = all namespaces (worker handles allNs)
		LabelSelector: selector,
	})
	if err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("%s", resp.Error)
	}

	// The list-full payload is a vanilla DeploymentList JSON; we
	// decode just the fields we need rather than pulling in
	// k8s.io/api/apps/v1 (the generator side uses it, the list
	// side doesn't need to).
	var list struct {
		Items []struct {
			Metadata struct {
				Name              string            `json:"name"`
				Namespace         string            `json:"namespace"`
				Labels            map[string]string `json:"labels"`
				CreationTimestamp time.Time         `json:"creationTimestamp"`
			} `json:"metadata"`
			Spec struct {
				Replicas *int32 `json:"replicas"`
				Template struct {
					Spec struct {
						Containers []struct {
							Image string `json:"image"`
						} `json:"containers"`
					} `json:"spec"`
				} `json:"template"`
			} `json:"spec"`
			Status struct {
				Replicas            int32 `json:"replicas"`
				ReadyReplicas       int32 `json:"readyReplicas"`
				AvailableReplicas   int32 `json:"availableReplicas"`
				UnavailableReplicas int32 `json:"unavailableReplicas"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(resp.Data, &list); err != nil {
		log.Printf("[model-list] decode list-full failed: cluster=%s err=%v", cl.ID, err)
		return nil, fmt.Errorf("decode deployment list: %w", err)
	}

	rows := make([]modelInstance, 0, len(list.Items))
	for _, d := range list.Items {
		var replicas int32
		if d.Spec.Replicas != nil {
			replicas = *d.Spec.Replicas
		}
		var image string
		if len(d.Spec.Template.Spec.Containers) > 0 {
			image = d.Spec.Template.Spec.Containers[0].Image
		}
		// Roll up status the way the user perceives it. Avoid
		// surfacing "Unknown" — when in doubt, show "Progressing"
		// since the readiness gate is the more honest signal.
		var status string
		switch {
		case replicas > 0 && d.Status.ReadyReplicas >= replicas:
			status = "Running"
		case d.Status.UnavailableReplicas > 0 && d.Status.ReadyReplicas == 0:
			status = "Failed"
		default:
			status = "Progressing"
		}
		// Enrich with model identity. The model-id label is
		// what the generator stamps; missing / unparseable label
		// keeps the row as an orphan (still useful to see).
		var modelID int64
		var displayName, family, runtime, modelField string
		if midStr := d.Metadata.Labels["kpilot.io/model-id"]; midStr != "" {
			if mid, err := strconv.ParseUint(midStr, 10, 64); err == nil {
				if m, ok := modelsByID[uint(mid)]; ok {
					modelID = int64(m.ID)
					displayName = m.DisplayName
					family = string(m.Family)
					runtime = string(m.Runtime)
					modelField = m.HuggingFaceID
				} else {
					// Orphan: catalog row deleted but cluster still
					// has the Deployment. Surface anyway so the user
					// can clean it up; ModelID=0 lets the frontend
					// disable model-scoped actions.
					modelID = int64(mid)
				}
			}
		}
		if displayName == "" {
			displayName = d.Metadata.Name
		}
		// Fall back to deployment name when HF id is missing
		// (custom rows / orphans). vLLM 404s on unknown model
		// names regardless, but this at least lets the chat
		// request surface an informative error.
		if modelField == "" {
			modelField = d.Metadata.Name
		}
		rows = append(rows, modelInstance{
			ModelID:           modelID,
			ModelDisplayName:  displayName,
			ModelFamily:       family,
			ModelRuntime:      runtime,
			ModelField:        modelField,
			ClusterID:         cl.ID,
			ClusterName:       cl.Name,
			Namespace:         d.Metadata.Namespace,
			Name:              d.Metadata.Name,
			InstanceSuffix:    d.Metadata.Labels["kpilot.io/instance-suffix"],
			Image:             image,
			Replicas:          replicas,
			ReadyReplicas:     d.Status.ReadyReplicas,
			AvailableReplicas: d.Status.AvailableReplicas,
			CreatedAt:         d.Metadata.CreationTimestamp,
			ServicePort:       8000,
			Status:            status,
		})
	}
	return rows, nil
}
