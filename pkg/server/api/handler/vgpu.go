package handler

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/common/vgpu"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// vgpu.go — single endpoint that surfaces the vGPU cluster snapshot
// projected by the worker. The frontend slices it into three views
// (cluster totals / node list / per-card detail) but the data is one
// logical thing — splitting on the server side would force the worker
// to project three times for what is the same in-memory scan.
//
// Worker contract: ResourceRequest{Action: "vgpu-snapshot"} returns
// JSON-encoded vgpu.Snapshot in resp.Data. No GVK / namespace / name
// because the query is cluster-scoped and synthetic (aggregates
// Volcano annotations, not a real K8s kind).

// GetVGPUSnapshot fetches the projected snapshot and returns it
// verbatim. The response wire shape is vgpu.Snapshot — kept stable so
// frontend types can be hand-mirrored without a code-gen step.
//
// Failure modes the frontend may see:
//
//   - 404 with code RESOURCE_NOT_AVAILABLE: device-plugin not
//     installed, no nodes registered (the snapshot returns
//     empty Nodes; the handler converts that to 404 so the page can
//     render a "vGPU plugin not enabled" empty state instead of an
//     empty table that looks broken).
//   - 500 with code WORKER_ERROR: worker reported a list error.
//   - 504-ish via INTERNAL_ERROR: gRPC tunnel down or decode failed.
func GetVGPUSnapshot(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
			Action: "vgpu-snapshot",
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			apiErrWorker(c, resp.Error)
			return
		}

		var snap vgpu.Snapshot
		if err := json.Unmarshal(resp.Data, &snap); err != nil {
			apiErrInternal(c, err)
			return
		}
		// No nodes registered vGPU → treat as "plugin not installed".
		// The frontend already has the NotInstalled banner pattern;
		// surface the same code (RESOURCE_NOT_AVAILABLE) so it just
		// works without a new code path.
		if len(snap.Nodes) == 0 {
			apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
			return
		}
		c.JSON(http.StatusOK, snap)
	}
}
