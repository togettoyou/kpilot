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
	"errors"
	"net/http"
	"regexp"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

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
	HFToken         string   `json:"hf_token"`
	ExtraArgs       []string `json:"extra_args"`
	PVC             pvcReq   `json:"pvc"`
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
