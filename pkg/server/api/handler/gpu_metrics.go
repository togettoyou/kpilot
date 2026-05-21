// Package handler — GPU monitoring (custom UI, no Grafana).
//
// Replaces the original Grafana-iframe approach: the /compute/:id/
// gpu-monitoring page renders its own panels from this endpoint's
// structured response. Keeping the visualization in KPilot lets the
// 算力调度 platform stay specialized (Volcano-aware drill-down,
// product-grade Empty states, theme parity) while Grafana remains as
// the generic dashboard for cluster management.
//
// Six DCGM metrics ship in one round trip:
//   - util  (DCGM_FI_DEV_GPU_UTIL)              %
//   - temp  (DCGM_FI_DEV_GPU_TEMP)              °C
//   - power (DCGM_FI_DEV_POWER_USAGE)           W
//   - fbUsed/fbTotal (DCGM_FI_DEV_FB_USED/FB_TOTAL) MiB
//   - sm    (DCGM_FI_DEV_SM_CLOCK)              MHz (server divides Hz)
//   - tensor (DCGM_FI_PROF_PIPE_TENSOR_ACTIVE)  unit ratio (0-1)
//
// The "current snapshot" (avg temp, total power, avg util, fb summary)
// is computed server-side from the latest range point per series, so
// the frontend doesn't have to walk the same data twice.
package handler

import (
	"context"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// metricRangeSpec mirrors gpu_hour's supportedRanges but with a wider
// step floor — line charts don't need as fine granularity as billing
// integration. The 30d view especially benefits from coarser buckets
// (otherwise the chart is mostly aliasing).
var metricRangeSpec = map[string]timeRangeSpec{
	"1h":  {duration: time.Hour, step: 30 * time.Second},
	"24h": {duration: 24 * time.Hour, step: 5 * time.Minute},
	"7d":  {duration: 7 * 24 * time.Hour, step: 30 * time.Minute},
	"30d": {duration: 30 * 24 * time.Hour, step: 2 * time.Hour},
}

// gpuMetricSeries is one labeled curve in the response. Labels are
// already projected to the fields the frontend needs (no Prometheus
// label-bag exposed) — adding a new label means changing the wire
// contract on purpose, not by accident.
type gpuMetricSeries struct {
	Hostname string        `json:"hostname,omitempty"`
	GPU      string        `json:"gpu,omitempty"`
	UUID     string        `json:"uuid,omitempty"`
	Points   []gpuMetricPt `json:"points"`
}

type gpuMetricPt struct {
	Ts    int64   `json:"ts"`
	Value float64 `json:"value"`
}

// gpuMetricsSnapshot is the cluster-level "right now" rollup the
// frontend uses to fill the four KPI gauges above the chart grid.
// Computed from the last sample of each series — VM doesn't ship
// "current value" as a separate concept, so we use the most recent
// range point.
type gpuMetricsSnapshot struct {
	ActiveGPUs      int     `json:"activeGPUs"`
	AvgTempC        float64 `json:"avgTempC"`
	MaxTempC        float64 `json:"maxTempC"`
	TotalPowerW     float64 `json:"totalPowerW"`
	AvgUtilPct      float64 `json:"avgUtilPct"`
	FBUsedMiB       float64 `json:"fbUsedMiB"`
	FBTotalMiB      float64 `json:"fbTotalMiB"`
	FBUsagePct      float64 `json:"fbUsagePct"`
	AvgTensorActPct float64 `json:"avgTensorActPct"`
}

type gpuMetricsResponse struct {
	Range       string             `json:"range"`
	From        string             `json:"from"`
	To          string             `json:"to"`
	GeneratedAt string             `json:"generatedAt"`
	StepSeconds int                `json:"stepSeconds"`
	Snapshot    gpuMetricsSnapshot `json:"snapshot"`
	// Series keyed by metric ID. Frontend renders one chart per key,
	// in the order it cares about (server side leaves ordering to the
	// frontend so reordering panels doesn't require a backend change).
	Series map[string][]gpuMetricSeries `json:"series"`
}

// GetGPUMetrics serves /api/v1/clusters/:id/gpu-metrics?range=…. Six
// VM range queries in parallel; the slowest query bounds the response
// latency. Any single query failure is logged and produces an empty
// series for that metric — fresh clusters often have `tensor` and `fb`
// missing for a few seconds while DCGM warms up.
func GetGPUMetrics(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		tr, ok := resolveTimeRange(c, metricRangeSpec)
		if !ok {
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
		from, to := tr.from, tr.to

		// 4s response cache — slightly under the typical 5s browser
		// poll, so a single underlying VM fan-out serves every tab on
		// the same (cluster, range) tuple. GetOrCompute layers
		// singleflight on top so concurrent cold misses collapse to
		// a single fan-out instead of stampeding the worker.
		cacheKey := vmCacheKey("gpu-metrics", clusterID, tr.cacheSuffix)
		body, err := sharedVMResponseCache.GetOrCompute(cacheKey, 4*time.Second, func() (any, error) {

			// Each entry: result key + PromQL. The PromQL strings keep a
			// stable label set (Hostname, gpu, UUID) because the frontend's
			// chart legend depends on those labels matching across charts.
			queries := []struct {
				key    string
				promql string
			}{
				{"util", `DCGM_FI_DEV_GPU_UTIL`},
				{"temp", `DCGM_FI_DEV_GPU_TEMP`},
				{"power", `DCGM_FI_DEV_POWER_USAGE`},
				// FB used / total separately so the frontend can render the
				// raw GiB curve AND derive a percentage on the snapshot
				// gauge. DCGM exporter (verified 4.x) does NOT publish
				// DCGM_FI_DEV_FB_TOTAL — only FB_USED + FB_FREE. Derive
				// total as USED + FREE per GPU (the `sum by (...)` keeps
				// the per-card identity tags so the chart legend stays
				// the same as the other per-card series).
				{"fbUsed", `DCGM_FI_DEV_FB_USED`},
				{"fbTotal", `sum by (Hostname, gpu, UUID, modelName) (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE)`},
				// SM clock in MHz — DCGM emits MHz already (despite some
				// docs saying Hz). Old dashboards multiply by 1e6; we
				// don't, and the chart label says MHz.
				{"sm", `DCGM_FI_DEV_SM_CLOCK`},
				// Tensor active is a unit ratio [0,1]. Multiply by 100 in
				// the chart layer for the % axis.
				{"tensor", `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE`},
			}

			var (
				mu  sync.Mutex
				wg  sync.WaitGroup
				out = make(map[string][]gpuMetricSeries, len(queries))
			)
			for _, q := range queries {
				q := q
				wg.Add(1)
				go func() {
					defer wg.Done()
					series, err := queryVMRange(ctx, gw, clusterID, vmURL, q.promql, from, to, tr.step)
					if err != nil {
						log.Printf("[gpu-metrics] VM range query failed: cluster=%s key=%s err=%v",
							clusterID, q.key, err)
						return
					}
					rows := make([]gpuMetricSeries, 0, len(series))
					for _, s := range series {
						pts := make([]gpuMetricPt, 0, len(s.Points))
						for _, p := range s.Points {
							pts = append(pts, gpuMetricPt{Ts: p.Ts, Value: p.Value})
						}
						rows = append(rows, gpuMetricSeries{
							Hostname: s.Labels["Hostname"],
							GPU:      s.Labels["gpu"],
							UUID:     s.Labels["UUID"],
							Points:   pts,
						})
					}
					// Stable order so chart legends don't shuffle between
					// refreshes. Hostname → gpu index is what an operator
					// expects to see top-down.
					sort.SliceStable(rows, func(i, j int) bool {
						if rows[i].Hostname != rows[j].Hostname {
							return rows[i].Hostname < rows[j].Hostname
						}
						return rows[i].GPU < rows[j].GPU
					})
					mu.Lock()
					out[q.key] = rows
					mu.Unlock()
				}()
			}
			wg.Wait()

			snapshot := buildSnapshot(out)

			return gpuMetricsResponse{
				Range:       tr.cacheSuffix,
				From:        from.UTC().Format(time.RFC3339),
				To:          to.UTC().Format(time.RFC3339),
				GeneratedAt: time.Now().UTC().Format(time.RFC3339),
				StepSeconds: int(tr.step.Seconds()),
				Snapshot:    snapshot,
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

// buildSnapshot reduces the per-metric series into the four KPI
// numbers the frontend gauges need. Uses the latest point of each
// series so the snapshot tracks the chart's right-most edge —
// "right now" semantically matches what the user sees in the chart.
func buildSnapshot(series map[string][]gpuMetricSeries) gpuMetricsSnapshot {
	var snap gpuMetricsSnapshot

	lastOf := func(s gpuMetricSeries) (float64, bool) {
		if len(s.Points) == 0 {
			return 0, false
		}
		return s.Points[len(s.Points)-1].Value, true
	}

	// ActiveGPUs is the cardinality of the util series — most reliable
	// since utilization is reported for every GPU even when idle.
	{
		uniq := make(map[string]struct{})
		for _, s := range series["util"] {
			uniq[s.UUID] = struct{}{}
		}
		snap.ActiveGPUs = len(uniq)
	}

	if rows := series["temp"]; len(rows) > 0 {
		var sum float64
		var n int
		for _, r := range rows {
			if v, ok := lastOf(r); ok {
				sum += v
				if v > snap.MaxTempC {
					snap.MaxTempC = v
				}
				n++
			}
		}
		if n > 0 {
			snap.AvgTempC = sum / float64(n)
		}
	}

	for _, r := range series["power"] {
		if v, ok := lastOf(r); ok {
			snap.TotalPowerW += v
		}
	}

	if rows := series["util"]; len(rows) > 0 {
		var sum float64
		var n int
		for _, r := range rows {
			if v, ok := lastOf(r); ok {
				sum += v
				n++
			}
		}
		if n > 0 {
			snap.AvgUtilPct = sum / float64(n)
		}
	}

	for _, r := range series["fbUsed"] {
		if v, ok := lastOf(r); ok {
			snap.FBUsedMiB += v
		}
	}
	for _, r := range series["fbTotal"] {
		if v, ok := lastOf(r); ok {
			snap.FBTotalMiB += v
		}
	}
	if snap.FBTotalMiB > 0 {
		snap.FBUsagePct = (snap.FBUsedMiB / snap.FBTotalMiB) * 100
	}

	if rows := series["tensor"]; len(rows) > 0 {
		var sum float64
		var n int
		for _, r := range rows {
			if v, ok := lastOf(r); ok {
				sum += v * 100 // unit ratio → %
				n++
			}
		}
		if n > 0 {
			snap.AvgTensorActPct = sum / float64(n)
		}
	}

	// Floor tiny negative readings to zero — gauge components do not
	// like negatives and DCGM occasionally emits -0.0 for idle GPUs.
	floor := func(v *float64) {
		if *v < 0 {
			*v = 0
		}
	}
	floor(&snap.AvgTempC)
	floor(&snap.TotalPowerW)
	floor(&snap.AvgUtilPct)
	floor(&snap.AvgTensorActPct)

	return snap
}
