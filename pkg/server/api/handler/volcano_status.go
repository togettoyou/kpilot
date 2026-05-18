package handler

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/common/volcano"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// volcano_status.go — `GET /api/v1/clusters/:id/volcano/status` returns
// the worker's cluster-side detection result so frontend pages don't
// need to query KPilot's plugin registry to know whether Volcano is
// usable. The pattern matches the vGPU snapshot endpoint: synthetic
// ResourceRequest action, worker probes cluster, JSON in resp.Data.
//
// Consumers (today):
//
//   - Scheduler page: gates on Installed; reads ConfigMap from
//     SchedulerConfigMapNamespace rather than assuming a release ns.
//   - Overview's scheduler-config card: same.
//
// Open by design: this endpoint never 404s. Installed=false is a
// successful 200 with a flag — the frontend renders NotInstalled
// based on the body, not the status code. That keeps a "Volcano not
// installed yet, but the cluster is reachable" state distinct from
// "tunnel down / worker offline" (which IS a 5xx).

func GetVolcanoStatus(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
			Action: "volcano-status",
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			apiErrWorker(c, resp.Error)
			return
		}

		var status volcano.Status
		if err := json.Unmarshal(resp.Data, &status); err != nil {
			apiErrInternal(c, err)
			return
		}
		c.JSON(http.StatusOK, status)
	}
}
