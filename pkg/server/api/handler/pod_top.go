package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// TopPod fetches metrics.k8s.io/v1beta1 PodMetrics through the worker
// and returns a flat JSON shape ready for the UI table:
//
//	{ timestamp, window, containers: [{ name, cpu_milli, memory_bytes }] }
//
// Two failure modes both surface as 404 / RESOURCE_NOT_AVAILABLE so the
// frontend renders the same "enable Metrics Server plugin" hint:
//
//   - "no matches for kind PodMetrics" — Metrics Server isn't installed
//     in the cluster (the metrics.k8s.io APIService is missing).
//   - "podmetrics ... not found" — Metrics Server is installed but
//     hasn't produced data for this pod (kwok node, OrbStack < 2.1.1
//     without the PodAndContainerStatsFromCRI feature gate, or just
//     haven't scraped yet on a freshly created pod).
//
// The user-actionable suggestion is the same for both: check that the
// plugin is running.
func TopPod(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		name := c.Param("name")
		namespace := c.Param("namespace")

		ctx, cancel := context.WithTimeout(c.Request.Context(), workerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &proto.ResourceRequest{
			Action:    "get",
			Group:     "metrics.k8s.io",
			Version:   "v1beta1",
			Kind:      "PodMetrics",
			Namespace: namespace,
			Name:      name,
		})
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			if isNoMatchMessage(resp.Error) || isPodMetricsNotFoundMsg(resp.Error) {
				apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
				return
			}
			apiErrWorker(c, resp.Error)
			return
		}

		var pm struct {
			Timestamp  string `json:"timestamp"`
			Window     string `json:"window"`
			Containers []struct {
				Name  string `json:"name"`
				Usage struct {
					CPU    string `json:"cpu"`
					Memory string `json:"memory"`
				} `json:"usage"`
			} `json:"containers"`
		}
		if err := json.Unmarshal(resp.Data, &pm); err != nil {
			apiErrInternal(c, err)
			return
		}

		out := podTopResponse{
			Timestamp:  pm.Timestamp,
			Window:     pm.Window,
			Containers: make([]containerUsage, 0, len(pm.Containers)),
		}
		for _, ctr := range pm.Containers {
			out.Containers = append(out.Containers, containerUsage{
				Name:        ctr.Name,
				CPUMilli:    parseQuantityMilli(ctr.Usage.CPU),
				MemoryBytes: parseQuantityBytes(ctr.Usage.Memory),
			})
		}
		c.JSON(http.StatusOK, out)
	}
}

type podTopResponse struct {
	Timestamp  string           `json:"timestamp"`
	Window     string           `json:"window"`
	Containers []containerUsage `json:"containers"`
}

type containerUsage struct {
	Name        string `json:"name"`
	CPUMilli    int64  `json:"cpu_milli"`
	MemoryBytes int64  `json:"memory_bytes"`
}

func parseQuantityMilli(s string) int64 {
	q, err := resource.ParseQuantity(s)
	if err != nil {
		return 0
	}
	return q.MilliValue()
}

func parseQuantityBytes(s string) int64 {
	q, err := resource.ParseQuantity(s)
	if err != nil {
		return 0
	}
	return q.Value()
}

func isPodMetricsNotFoundMsg(s string) bool {
	l := strings.ToLower(s)
	return strings.Contains(l, "podmetrics") &&
		(strings.Contains(l, "not found") || strings.Contains(l, "404"))
}
