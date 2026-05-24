// Package handler — cluster-wide monitoring panels.
//
// The /clusters/:id/monitoring page is split into three handlers so the
// frontend can poll them at independent cadences and degrade
// individually when the underlying exporter isn't installed:
//
//	/cluster-metrics  — this file. Top KPI strip + cluster-wide trend.
//	/node-metrics     — per-node series for the table + charts.
//	/pod-metrics      — top-N Pod CPU / memory series, namespace-scoped.
//
// Hard requirement: victoria-metrics plugin (PromQL endpoint). Soft
// requirements: node-exporter (drives node-level CPU / memory / disk /
// network) and kube-state-metrics (drives Pod state counts). When a
// soft requirement is missing the matching panels simply return empty
// series — the page renders an Empty state instead of failing.
package handler

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	kplog "github.com/togettoyou/kpilot/pkg/log"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// logSoftErr is shared with node_metrics / pod_metrics: a single PromQL
// failure in a fan-out shouldn't blank out the page, just hide that one
// panel. Handler name is passed in so the log line carries the actual
// originating page (cluster-metrics / node-metrics / pod-metrics).
func logSoftErr(handler, clusterID, key string, err error) {
	kplog.L(handler).Warn("PromQL fan-out failure", "cluster", clusterID, "key", key, "err", err)
}

// clusterMetricsRanges are the preset windows the monitoring page picker
// exposes. Custom ranges (?from=&to=) bypass this table — see
// resolveTimeRange in time_range.go.
var clusterMetricsRanges = map[string]timeRangeSpec{
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
	// PodsPending is broken out of the phase map for the KPI card —
	// scheduling backlog is a top-of-page operational signal worth
	// surfacing without needing to read the tag list.
	PodsPending int `json:"podsPending"`
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
// 12 PromQL queries in parallel (8 instant + 3 range + 1 by-phase
// histogram); any single query failure is logged and produces an
// empty result for that metric so a missing exporter doesn't blank
// out the whole page.
func GetClusterMetrics(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		tr, ok := resolveTimeRange(c, clusterMetricsRanges)
		if !ok {
			return
		}

		// Resolve VM URL up front (cheap, hits a 30s in-process cache)
		// so plugin-not-installed errors stay typed and map to
		// RESOURCE_NOT_AVAILABLE 404. Cache lookup + compute happen
		// after; a singleflight gate inside the cache collapses
		// concurrent cold misses on the same key into one fan-out.
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
		from, to := tr.from, tr.to

		// Group filter — UI accordion sections fetch independently.
		// "overview" = KPI instant queries (always cheap, defaults
		// to running when groups param is empty so the first-paint
		// hits aren't broken). "capacity" = range trends. "workload" =
		// Pod phase + restart / crashloop trends.
		groupsParam := c.Query("groups")
		wantOverview := groupsParam == "" || strings.Contains(","+groupsParam+",", ",overview,")
		wantCapacity := groupsParam == "" || strings.Contains(","+groupsParam+",", ",capacity,")
		wantWorkload := groupsParam == "" || strings.Contains(","+groupsParam+",", ",workload,")
		cacheSig := "all"
		if groupsParam != "" {
			cacheSig = "g=" + groupsParam
		}

		cacheKey := vmCacheKey("cluster-metrics", clusterID, tr.cacheSuffix+"|"+cacheSig)
		body, err := sharedVMResponseCache.GetOrCompute(cacheKey, 4*time.Second, func() (any, error) {

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
				group  string // "capacity" or "workload"
			}{
				// Capacity: cluster CPU / mem / disk utilization over
				// time — drives the trend chart under the KPI strip.
				{"cpu", `(1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100`, "capacity"},
				{"mem", `(1 - sum(node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)) * 100`, "capacity"},
				{"disk", `100 * (1 - sum(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"}) / sum(node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"}))`, "capacity"},
				// Workload: scheduling backlog + cluster-wide restart /
				// crashloop trends.
				//
				// kube_pod_status_phase is a 0/1 gauge: for each pod KSM
				// emits one series per phase (so count() of the Pending
				// label returns one row PER POD regardless of which
				// phase it's actually in). sum() over the value gives
				// the real Pending count.
				{"pendingPods", `sum(kube_pod_status_phase{phase="Pending"}) or vector(0)`, "workload"},
				{"restartRate", `sum(rate(kube_pod_container_status_restarts_total[5m])) or vector(0)`, "workload"},
				// kube_pod_container_status_waiting_reason is also 0/1
				// per (pod, container, reason). Same count-vs-sum
				// fallacy applies — sum gives the real count of
				// containers currently in CrashLoopBackOff.
				{"crashLooping", `sum(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}) or vector(0)`, "workload"},
			}

			var (
				mu       sync.Mutex
				wg       sync.WaitGroup
				instants = make(map[string]float64, len(instantQueries))
				ranges   = make(map[string]clusterMetricsSeries, len(rangeQueries))
				phases   = make(map[string]int)
			)
			// Fan out per group selection — sections that aren't
			// visible (?groups=…) skip the cost.
			if wantOverview {
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
			}
			for _, q := range rangeQueries {
				if (q.group == "capacity" && !wantCapacity) ||
					(q.group == "workload" && !wantWorkload) {
					continue
				}
				q := q
				wg.Add(1)
				go func() {
					defer wg.Done()
					series, err := queryVMRange(ctx, gw, clusterID, vmURL, q.promql, from, to, tr.step)
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
			// Pod phase histogram (instant, by-phase) — overview group.
			// Lives in overview rather than workload because the KPI
			// strip in the cluster tab's overview section needs
			// podsByPhase / podsTotal / podsPending to render the Pods
			// card; the workload section only consumes the time-series
			// (pendingPods / restartRate / crashLooping).
			if wantOverview {
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
			}
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
			snap.PodsPending = phases["Pending"]
			// Clamp negatives — PromQL can return tiny negative rates for
			// gauges in flaky conditions; gauges in the UI don't like them.
			if snap.CPUUtilPct < 0 {
				snap.CPUUtilPct = 0
			}
			if snap.MemUtilPct < 0 {
				snap.MemUtilPct = 0
			}

			return clusterMetricsResponse{
				Range:       tr.cacheSuffix,
				From:        from.UTC().Format(time.RFC3339),
				To:          to.UTC().Format(time.RFC3339),
				GeneratedAt: time.Now().UTC().Format(time.RFC3339),
				StepSeconds: int(tr.step.Seconds()),
				Snapshot:    snap,
				Series:      ranges,
			}, nil
		})
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		c.Data(http.StatusOK, "application/json", body)
	}
}
