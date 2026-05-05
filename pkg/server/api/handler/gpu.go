package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

// gpuSummaryTimeout caps the Worker round-trip for the GPU page. Longer
// than the workload page's per-list because the worker is doing TWO list
// operations (nodes + pods, all namespaces) plus aggregation; on a busy
// cluster the pod list alone can be a few MB. 30s leaves headroom but
// still gives the user a snappier 504 than the proxy's 60s if the
// cluster's API server is genuinely overloaded.
const gpuSummaryTimeout = 30 * time.Second

// GetClusterGPU returns the cluster-wide GPU view: per-node device detail
// from HAMI annotations + extended-resource capacity/allocatable +
// per-pod GPU usage. Worker does the heavy lifting (cluster API queries,
// aggregation), Server just transports the JSON.
//
// Bound to GET /api/v1/clusters/:id/gpu.
func GetClusterGPU(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		if _, err := store.GetClusterByID(clusterID); err != nil {
			apiErr(c, http.StatusNotFound, CodeClusterNotFound)
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), gpuSummaryTimeout)
		defer cancel()
		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action: "gpu-summary",
		})
		if err != nil {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}
		if !resp.Success {
			// Surface the worker's actual error (list nodes failed, RBAC,
			// etc.) so the user has something actionable.
			apiErrWorker(c, resp.Error)
			return
		}
		// Already JSON-encoded by Worker — pass through with the right
		// Content-Type so the frontend's request lib parses it directly.
		c.Data(http.StatusOK, "application/json", resp.Data)
	}
}
