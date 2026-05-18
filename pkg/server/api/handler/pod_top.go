package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// TopPod fetches metrics.k8s.io/v1beta1 PodMetrics through the worker
// and returns a flat JSON shape ready for the UI table:
//
//	{ timestamp, window, containers: [{ name, cpu_milli, memory_bytes }] }
//
// Any error pattern that boils down to "Metrics Server isn't producing
// data" is collapsed to 404 / RESOURCE_NOT_AVAILABLE so the frontend
// renders the same "enable Metrics Server plugin" hint instead of
// leaking the raw K8s error message — see isMetricsUnavailableMsg for
// the three flavors we recognise.
func TopPod(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		name := c.Param("name")
		namespace := c.Param("namespace")

		ctx, cancel := context.WithTimeout(c.Request.Context(), readWorkerTimeout)
		defer cancel()

		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
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
			if isMetricsUnavailableMsg(resp.Error) {
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

// isMetricsUnavailableMsg recognises the three failure modes that all
// boil down to "Metrics Server isn't producing data right now":
//
//   - "no matches for kind PodMetrics" — RESTMapper can't resolve the
//     kind because the APIService isn't registered (plugin not installed).
//   - "podmetrics ... not found" — APIService is registered but the
//     metrics-server backend has no row for this specific pod (kwok node,
//     pod just created and no scrape window has hit yet, etc).
//   - "the server could not find the requested resource" — generic 404
//     surfaced when the aggregated APIService endpoint is unreachable
//     (metrics-server pod not yet Ready, FailedDiscoveryCheck on the
//     APIService, kubelet 401 leaving stale registration, ...).
//
// All three look identical to the user — they want metrics, they didn't
// get any. Collapse to RESOURCE_NOT_AVAILABLE so the drawer renders the
// same "enable Metrics Server plugin" hint instead of leaking the raw
// K8s error.
func isMetricsUnavailableMsg(s string) bool {
	l := strings.ToLower(s)
	if strings.Contains(l, "no matches for kind") {
		return true
	}
	if strings.Contains(l, "podmetrics") &&
		(strings.Contains(l, "not found") || strings.Contains(l, "404")) {
		return true
	}
	if strings.Contains(l, "could not find the requested resource") {
		return true
	}
	return false
}
