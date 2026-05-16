// Package handler — internal observability endpoint.
//
// GetMetrics serves /api/v1/metrics: a JSON snapshot of the gateway's
// in-process counters (worker connections, in-flight resource +
// HTTP-proxy requests, live streaming sessions, plugin-log buffers)
// plus the handler-package caches (plugin resolve, proxy semaphores,
// VM response cache). Exposed so an operator can spot a process
// leaking sessions or piling up wedged requests without attaching a
// debugger.
//
// Auth: behind the same JWT middleware as every other /api/v1 route —
// admin only because that's currently the only role. Single-tenant
// deployment means "anyone authenticated" = "the operator". When
// multi-tenancy lands, the endpoint should be moved to a role-scoped
// admin route.
//
// Output is plain JSON, not Prometheus text format. The numbers are
// for a human looking at a debug page; if/when KPilot grows a real
// Prometheus exporter it'll be a separate endpoint emitting OpenMetrics
// with stable metric names.
package handler

import (
	"net/http"
	"runtime"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

type metricsResponse struct {
	GeneratedAt string                   `json:"generatedAt"`
	Gateway     gateway.MetricsSnapshot  `json:"gateway"`
	Caches      metricsCaches            `json:"caches"`
	Runtime     metricsRuntime           `json:"runtime"`
}

type metricsCaches struct {
	// PluginResolve is the number of cached (cluster, plugin) → release
	// namespace lookups. Bounded by (#clusters × #plugins ever queried)
	// with a 30s TTL reaper.
	PluginResolve int `json:"pluginResolve"`
	// ProxySemaphores is the number of per-cluster reverse-proxy slots
	// allocated. Created lazily on first proxy hit per cluster; dropped
	// on DeleteCluster.
	ProxySemaphores int `json:"proxySemaphores"`
	// VMResponse is the number of TTL'd VM-query response bodies
	// (gpu-metrics, gpu-hour) currently held. Bounded by
	// (handlers × clusters × ranges) — small.
	VMResponse int `json:"vmResponse"`
}

type metricsRuntime struct {
	Goroutines int    `json:"goroutines"`
	GoVersion  string `json:"goVersion"`
}

// GetMetrics returns a JSON snapshot of in-process counters. Cheap —
// each underlying read takes the relevant lock for a `len()` and
// nothing else.
func GetMetrics(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		resp := metricsResponse{
			GeneratedAt: time.Now().UTC().Format(time.RFC3339),
			Gateway:     gw.MetricsSnapshot(),
			Caches: metricsCaches{
				PluginResolve:   PluginResolveCacheSize(),
				ProxySemaphores: ProxySemaphoreCount(),
				VMResponse:      sharedVMResponseCache.Size(),
			},
			Runtime: metricsRuntime{
				Goroutines: runtime.NumGoroutine(),
				GoVersion:  runtime.Version(),
			},
		}
		c.JSON(http.StatusOK, resp)
	}
}
