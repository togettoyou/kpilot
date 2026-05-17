// Package handler — cluster-wide monitoring panels.
//
// The /clusters/:id/monitoring page is split into three handlers so the
// frontend can poll them at independent cadences and degrade
// individually when the underlying exporter isn't installed:
//
//   /cluster-metrics  — this file. Top KPI strip + cluster-wide trend.
//   /node-metrics     — per-node series for the table + charts.
//   /pod-metrics      — top-N Pod CPU / memory series, namespace-scoped.
//
// Hard requirement: victoria-metrics plugin (PromQL endpoint). Soft
// requirements: node-exporter (drives node-level CPU / memory / disk /
// network) and kube-state-metrics (drives Pod state counts). When a
// soft requirement is missing the matching panels simply return empty
// series — the page renders an Empty state instead of failing.
package handler

import (
	"context"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// logSoftErr is shared with node_metrics / pod_metrics: a single PromQL
// failure in a fan-out shouldn't blank out the page, just hide that one
// panel. Component / handler / cluster id captured so an operator can
// grep for the failing query.
func logSoftErr(handler, clusterID, key string, err error) {
	log.Printf("[%s] PromQL fan-out failure: cluster=%s key=%s err=%v",
		handler, clusterID, key, err)
}

// clusterMetricsRanges are the windows the monitoring page picker
// exposes. Same shape as the Compute pages so the UX is consistent.
var clusterMetricsRanges = map[string]struct {
	duration time.Duration
	step     time.Duration
}{
	"1h":  {duration: time.Hour, step: 30 * time.Second},
	"24h": {duration: 24 * time.Hour, step: 5 * time.Minute},
	"7d":  {duration: 7 * 24 * time.Hour, step: 30 * time.Minute},
	"30d": {duration: 30 * 24 * time.Hour, step: 2 * time.Hour},
}

type clusterMetricsSnapshot struct {
	// NodesReady / NodesTotal come from kube-state-metrics; both are 0
	// when KSM is not installed. Frontend treats (0, 0) as "data not
	// available" and hides the gauge.
	NodesReady int `json:"nodesReady"`
	NodesTotal int `json:"nodesTotal"`
	// CPU / memory utilization are computed cluster-wide from
	// node-exporter; expressed as percent in [0, 100].
	CPUUtilPct float64 `json:"cpuUtilPct"`
	MemUtilPct float64 `json:"memUtilPct"`
	// Absolute companions for the rate fields above. "45% of 200
	// cores" reads very differently from a flat 45% — the rate alone
	// doesn't tell an operator whether 50% on a 4-core cluster is
	// fine or 50% on a 400-core cluster needs attention. Zero values
	// indicate the source metric isn't present (node-exporter
	// missing).
	CPUTotalCores float64 `json:"cpuTotalCores"`
	CPUUsedCores  float64 `json:"cpuUsedCores"`
	MemTotalBytes float64 `json:"memTotalBytes"`
	MemUsedBytes  float64 `json:"memUsedBytes"`
	// Pod state distribution: phase → count. Empty map when KSM is
	// absent.
	PodsByPhase map[string]int `json:"podsByPhase"`
	// PodsTotal is the sum of PodsByPhase — handed back pre-summed so
	// the frontend doesn't redo the work.
	PodsTotal int `json:"podsTotal"`
}

type clusterMetricsSeries struct {
	Points []clusterMetricsPt `json:"points"`
}

type clusterMetricsPt struct {
	Ts    int64   `json:"ts"`
	Value float64 `json:"value"`
}

type clusterMetricsResponse struct {
	Range       string                          `json:"range"`
	From        string                          `json:"from"`
	To          string                          `json:"to"`
	GeneratedAt string                          `json:"generatedAt"`
	StepSeconds int                             `json:"stepSeconds"`
	Snapshot    clusterMetricsSnapshot          `json:"snapshot"`
	Series      map[string]clusterMetricsSeries `json:"series"`
}

// GetClusterMetrics serves /api/v1/clusters/:id/cluster-metrics?range=…
// Five PromQL queries in parallel; any single query failure is logged
// and produces an empty result for that metric so a missing exporter
// doesn't blank out the whole page.
func GetClusterMetrics(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		rangeKey := c.DefaultQuery("range", "1h")
		spec, ok := clusterMetricsRanges[rangeKey]
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		// Reuse the shared 4s response cache that powers gpu-metrics —
		// the underlying PromQL fan-out is the most expensive part of
		// the page render and a typical UI poll interval is 5s.
		cacheKey := vmCacheKey("cluster-metrics", clusterID, rangeKey)
		if body, ok := sharedVMResponseCache.Get(cacheKey); ok {
			c.Data(http.StatusOK, "application/json", body)
			return
		}

		vmURL, code, err := resolveVMQueryURL(gw, clusterID)
		if err != nil {
			if code != "" {
				if code == CodePluginNotFound || code == CodePluginNotEnabled || code == CodePluginNotRunning {
					apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
					return
				}
				apiErr(c, http.StatusServiceUnavailable, code)
				return
			}
			apiErrInternal(c, err)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), vmTimeout)
		defer cancel()
		now := time.Now()
		from := now.Add(-spec.duration)

		// Cluster-wide PromQL. CPU / memory expressions follow the
		// canonical Prometheus community guides (avg over per-node
		// idle, available vs total). Pod phase and Node Ready come
		// from kube-state-metrics; expressions return zero rows when
		// KSM isn't installed.
		instantQueries := []struct {
			key    string
			promql string
		}{
			{"nodesReady", `count(kube_node_status_condition{condition="Ready",status="true"})`},
			{"nodesTotal", `count(kube_node_info)`},
			{"cpuUtilPct", `(1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100`},
			{"memUtilPct", `(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100`},
			// Absolute companions. cpuTotalCores counts logical CPUs
			// across all nodes (one idle-mode series per logical CPU).
			// cpuUsedCores is the cluster-wide non-idle rate — it
			// converges to "currently active cores" because each
			// busy core ticks one second per real second.
			{"cpuTotalCores", `count(count by (cpu, instance) (node_cpu_seconds_total{mode="idle"}))`},
			{"cpuUsedCores", `sum(rate(node_cpu_seconds_total{mode!="idle"}[5m]))`},
			{"memTotalBytes", `sum(node_memory_MemTotal_bytes)`},
			{"memUsedBytes", `sum(node_memory_MemTotal_bytes) - sum(node_memory_MemAvailable_bytes)`},
		}
		rangeQueries := []struct {
			key    string
			promql string
		}{
			// Cluster CPU / memory utilization over time — drives the
			// trend chart under the KPI strip.
			{"cpu", `(1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100`},
			{"mem", `(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100`},
		}

		var (
			mu       sync.Mutex
			wg       sync.WaitGroup
			instants = make(map[string]float64, len(instantQueries))
			ranges   = make(map[string]clusterMetricsSeries, len(rangeQueries))
			phases   = make(map[string]int)
		)
		// 5 instant + 2 range queries, all fan out. Each failure is
		// logged and produces a zero / empty result.
		for _, q := range instantQueries {
			q := q
			wg.Add(1)
			go func() {
				defer wg.Done()
				series, err := queryVM(ctx, gw, clusterID, vmURL, q.promql)
				if err != nil {
					logSoftErr("cluster-metrics", clusterID, q.key, err)
					return
				}
				var v float64
				if len(series) > 0 {
					v = series[0].Value
				}
				mu.Lock()
				instants[q.key] = v
				mu.Unlock()
			}()
		}
		for _, q := range rangeQueries {
			q := q
			wg.Add(1)
			go func() {
				defer wg.Done()
				series, err := queryVMRange(ctx, gw, clusterID, vmURL, q.promql, from, now, spec.step)
				if err != nil {
					logSoftErr("cluster-metrics", clusterID, q.key, err)
					return
				}
				pts := make([]clusterMetricsPt, 0)
				if len(series) > 0 {
					for _, p := range series[0].Points {
						pts = append(pts, clusterMetricsPt{Ts: p.Ts, Value: p.Value})
					}
				}
				mu.Lock()
				ranges[q.key] = clusterMetricsSeries{Points: pts}
				mu.Unlock()
			}()
		}
		// One extra query: pod phase histogram (instant, by-phase).
		wg.Add(1)
		go func() {
			defer wg.Done()
			series, err := queryVM(ctx, gw, clusterID, vmURL,
				`sum by (phase) (kube_pod_status_phase)`)
			if err != nil {
				logSoftErr("cluster-metrics", clusterID, "podsByPhase", err)
				return
			}
			mu.Lock()
			for _, s := range series {
				p := s.Labels["phase"]
				if p == "" {
					continue
				}
				phases[p] = int(s.Value)
			}
			mu.Unlock()
		}()
		wg.Wait()

		snap := clusterMetricsSnapshot{
			NodesReady:    int(instants["nodesReady"]),
			NodesTotal:    int(instants["nodesTotal"]),
			CPUUtilPct:    instants["cpuUtilPct"],
			MemUtilPct:    instants["memUtilPct"],
			CPUTotalCores: instants["cpuTotalCores"],
			CPUUsedCores:  instants["cpuUsedCores"],
			MemTotalBytes: instants["memTotalBytes"],
			MemUsedBytes:  instants["memUsedBytes"],
			PodsByPhase:   phases,
		}
		for _, n := range phases {
			snap.PodsTotal += n
		}
		// Clamp negatives — PromQL can return tiny negative rates for
		// gauges in flaky conditions; gauges in the UI don't like them.
		if snap.CPUUtilPct < 0 {
			snap.CPUUtilPct = 0
		}
		if snap.MemUtilPct < 0 {
			snap.MemUtilPct = 0
		}

		resp := clusterMetricsResponse{
			Range:       rangeKey,
			From:        from.UTC().Format(time.RFC3339),
			To:          now.UTC().Format(time.RFC3339),
			GeneratedAt: now.UTC().Format(time.RFC3339),
			StepSeconds: int(spec.step.Seconds()),
			Snapshot:    snap,
			Series:      ranges,
		}
		body, err := sharedVMResponseCache.Put(cacheKey, resp, 4*time.Second)
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		c.Data(http.StatusOK, "application/json", body)
	}
}
