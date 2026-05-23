// Package handler — per-pod monitoring panels (top-N CPU / memory).
//
// Drives the "Pods" tab of /clusters/:id/monitoring. Returns at most
// `limit` (default 20) series ordered by current CPU or current memory
// usage, optionally filtered by namespace. Hard dependency: cAdvisor
// metrics (via kubelet) for container_cpu_usage_seconds_total and
// container_memory_working_set_bytes — these are always present in a
// stock Kubernetes node when kubelet's metrics endpoint is scraped by
// VM, so the page renders even without kube-state-metrics.
package handler

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

type podMetricSeries struct {
	Namespace string        `json:"namespace"`
	Pod       string        `json:"pod"`
	Points    []podMetricPt `json:"points"`
	// Snapshot value of the last point in `points` — handy for sorting
	// + the "current value" column in the table.
	Latest float64 `json:"latest"`
}

type podMetricPt struct {
	Ts    int64   `json:"ts"`
	Value float64 `json:"value"`
}

type podMetricsResponse struct {
	Range       string `json:"range"`
	From        string `json:"from"`
	To          string `json:"to"`
	GeneratedAt string `json:"generatedAt"`
	StepSeconds int    `json:"stepSeconds"`
	Namespace   string `json:"namespace,omitempty"`
	// Series keyed by metric id (cpu / mem). Pre-sorted by Latest desc
	// at handler time so the frontend can render directly.
	Series map[string][]podMetricSeries `json:"series"`
}

// GetPodMetrics serves /api/v1/clusters/:id/pod-metrics?range=…&namespace=…&limit=…
func GetPodMetrics(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		tr, ok := resolveTimeRange(c, clusterMetricsRanges)
		if !ok {
			return
		}
		ns := c.Query("namespace")
		limit := 20
		if s := c.Query("limit"); s != "" {
			if v, err := strconv.Atoi(s); err == nil && v > 0 && v <= 100 {
				limit = v
			}
		}
		// Pod-name substring filter. When the UI's search box is non-
		// empty, push the filter into PromQL via a pod=~".*search.*"
		// matcher BEFORE topk() — without this, the client-side filter
		// runs against the top-N which already excluded the pod the
		// user is searching for, and they'd see an empty chart even
		// when their pod exists.
		//
		// Safety: regex-escape with QuoteMeta so a name like
		// "foo.bar" doesn't get interpreted as a wildcard. PromQL
		// uses RE2; QuoteMeta is the right escape for that syntax.
		podSearch := strings.TrimSpace(c.Query("podSearch"))
		podFilter := ""
		if podSearch != "" {
			// (?i) for case-insensitive — matches the frontend's
			// previous toLowerCase() comparison.
			podFilter = fmt.Sprintf(`,pod=~%q`, "(?i).*"+regexp.QuoteMeta(podSearch)+".*")
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
		from, to := tr.from, tr.to

		// Group filter mirrors node-metrics: ?groups= picks a subset
		// of the per-key PromQL fan-out. UI Pod tab loads each
		// accordion section independently. Empty groups param =
		// fetch everything (back-compat with v1 monolithic page).
		groupsParam := c.Query("groups")
		groupKeys := map[string][]string{
			"cpu":      {"cpu"},
			"mem":      {"mem"},
			"network":  {"netRx", "netTx"},
			"io":       {"fsRead", "fsWrite"},
			"throttle": {"cpuThrottle"},
			"memLimit": {"memLimitRatio"},
		}
		wantKey := func(key string) bool {
			if groupsParam == "" {
				return true
			}
			for _, g := range strings.Split(groupsParam, ",") {
				g = strings.TrimSpace(g)
				if keys, ok := groupKeys[g]; ok {
					for _, k := range keys {
						if k == key {
							return true
						}
					}
				}
			}
			return false
		}

		// Cache key includes namespace + limit + groups + pod search
		// so different drill-downs don't share a body.
		cacheKey := vmCacheKey("pod-metrics", clusterID,
			fmt.Sprintf("%s|ns=%s|limit=%d|g=%s|q=%s",
				tr.cacheSuffix, ns, limit, groupsParam, podSearch))
		body, err := sharedVMResponseCache.GetOrCompute(cacheKey, 4*time.Second, func() (any, error) {

			// PromQL builds the namespace filter inline rather than via a
			// label-replace pipeline — VM keeps cardinality bounded by the
			// filter and the topk() applied at query time gives us the
			// final result set without a second round-trip.
			nsFilter := ""
			if ns != "" {
				nsFilter = fmt.Sprintf(`,namespace=%q`, ns)
			}
			// Combined label tail injected inside every metric's
			// `{...}`. Namespace + pod search compose; either can be
			// empty.
			labelFilter := nsFilter + podFilter
			queries := []struct {
				key    string
				promql string
			}{
				// container_cpu_usage_seconds_total is per-container; sum
				// by (namespace, pod) to roll up; topk picks the heaviest
				// at the current edge of the window.
				{"cpu", fmt.Sprintf(
					`topk(%d, sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"%s}[5m])))`,
					limit, labelFilter,
				)},
				// working_set_bytes is the closest analog to "what kubectl
				// top shows" — RSS plus active anonymous pages.
				{"mem", fmt.Sprintf(
					`topk(%d, sum by (namespace, pod) (container_memory_working_set_bytes{container!="",container!="POD"%s}))`,
					limit, labelFilter,
				)},
				// Per-pod network throughput. cAdvisor reports per-
				// container; sum to pod, topk to keep the chart legible.
				// loopback / lo isn't filtered here because cAdvisor only
				// reports the pod's veth — the upstream side already.
				{"netRx", fmt.Sprintf(
					`topk(%d, sum by (namespace, pod) (rate(container_network_receive_bytes_total{pod!=""%s}[5m])))`,
					limit, labelFilter,
				)},
				{"netTx", fmt.Sprintf(
					`topk(%d, sum by (namespace, pod) (rate(container_network_transmit_bytes_total{pod!=""%s}[5m])))`,
					limit, labelFilter,
				)},
				// CPU throttling % — fraction of CFS periods in which the
				// container's CPU limit fired. The classic "invisible" pod
				// signal: CPU usage looks healthy because the limit is the
				// ceiling. Value is a percentage 0..100; tens of percent is
				// already worth investigating.
				{"cpuThrottle", fmt.Sprintf(
					`topk(%d, 100 * sum by (namespace, pod) (rate(container_cpu_cfs_throttled_periods_total{container!="",container!="POD"%s}[5m])) / (sum by (namespace, pod) (rate(container_cpu_cfs_periods_total{container!="",container!="POD"%s}[5m])) > 0))`,
					limit, labelFilter, labelFilter,
				)},
				// Pod-level filesystem I/O. cAdvisor reports per-container;
				// sum to pod. Mirrors the node disk I/O panels so an
				// operator can chase "node disk is hot, which pod?" without
				// leaving the page.
				{"fsRead", fmt.Sprintf(
					`topk(%d, sum by (namespace, pod) (rate(container_fs_reads_bytes_total{container!="",container!="POD"%s}[5m])))`,
					limit, labelFilter,
				)},
				{"fsWrite", fmt.Sprintf(
					`topk(%d, sum by (namespace, pod) (rate(container_fs_writes_bytes_total{container!="",container!="POD"%s}[5m])))`,
					limit, labelFilter,
				)},
				// Memory headroom = working set / memory limit. Filter on
				// the aggregated limit > 0 so pods without a limit (which
				// would divide by zero) drop out — they can't be near a
				// ceiling that doesn't exist. >80% is the "imminent OOM"
				// band.
				{"memLimitRatio", fmt.Sprintf(
					`topk(%d, 100 * sum by (namespace, pod) (container_memory_working_set_bytes{container!="",container!="POD"%s}) / (sum by (namespace, pod) (container_spec_memory_limit_bytes{container!="",container!="POD"%s}) > 0))`,
					limit, labelFilter, labelFilter,
				)},
			}

			var (
				mu  sync.Mutex
				wg  sync.WaitGroup
				out = make(map[string][]podMetricSeries, len(queries))
			)
			for _, q := range queries {
				if !wantKey(q.key) {
					continue
				}
				q := q
				wg.Add(1)
				go func() {
					defer wg.Done()
					series, err := queryVMRange(ctx, gw, clusterID, vmURL, q.promql, from, to, tr.step)
					if err != nil {
						logSoftErr("pod-metrics", clusterID, q.key, err)
						return
					}
					rows := make([]podMetricSeries, 0, len(series))
					for _, s := range series {
						pts := make([]podMetricPt, 0, len(s.Points))
						for _, p := range s.Points {
							pts = append(pts, podMetricPt{Ts: p.Ts, Value: p.Value})
						}
						var latest float64
						if n := len(pts); n > 0 {
							latest = pts[n-1].Value
						}
						rows = append(rows, podMetricSeries{
							Namespace: s.Labels["namespace"],
							Pod:       s.Labels["pod"],
							Points:    pts,
							Latest:    latest,
						})
					}
					sort.SliceStable(rows, func(i, j int) bool {
						return rows[i].Latest > rows[j].Latest
					})
					mu.Lock()
					out[q.key] = rows
					mu.Unlock()
				}()
			}
			wg.Wait()

			return podMetricsResponse{
				Range:       tr.cacheSuffix,
				From:        from.UTC().Format(time.RFC3339),
				To:          to.UTC().Format(time.RFC3339),
				GeneratedAt: time.Now().UTC().Format(time.RFC3339),
				StepSeconds: int(tr.step.Seconds()),
				Namespace:   ns,
				Series:      out,
			}, nil
		})
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		c.Data(http.StatusOK, "application/json", body)
	}
}
