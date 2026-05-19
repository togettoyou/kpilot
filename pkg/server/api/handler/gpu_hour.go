// Package handler — GPU-Hour billing report.
//
// Integrates DCGM_FI_DEV_GPU_UTIL/100 over a user-selected time window
// to produce per-GPU GPU-hour consumption. The semantic is "hardware
// utilization-hours", not "allocation-hours" — a job that holds a GPU
// allocation but runs `nvidia-smi` once a minute will register a tiny
// amount of GPU-hour even though it occupied the slot.
//
// v1 limitation: rows are grouped by (Hostname, gpu) only. Going
// further (per Volcano queue / Pod / namespace) requires cross-
// referencing Pod labels at sample time, which DCGM doesn't naturally
// emit — would need a worker-side periodic snapshot pushed to a
// server DB table. Acknowledged in the page banner.
package handler

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// supportedRanges are the windows the page picker exposes. Anything
// outside the set is rejected so the server never tries to range-query
// VM for years of history (the bundled chart's 30d retention would
// quietly fill with zeros past day 30 and the result would look like
// a real but empty period).
//
// Step is sized so each bucket is plenty fine-grained for visual
// integration without driving up VM CPU. 1h window → 60 5s buckets,
// 30d → ~2880 15m buckets.
var supportedRanges = map[string]struct {
	duration time.Duration
	step     time.Duration
}{
	"1h":  {duration: time.Hour, step: time.Minute},
	"24h": {duration: 24 * time.Hour, step: 5 * time.Minute},
	"7d":  {duration: 7 * 24 * time.Hour, step: 15 * time.Minute},
	"30d": {duration: 30 * 24 * time.Hour, step: 15 * time.Minute},
}

type gpuHourRow struct {
	Hostname string `json:"hostname,omitempty"`
	Instance string `json:"instance,omitempty"`
	GPU      string `json:"gpu,omitempty"`
	UUID     string `json:"uuid,omitempty"`
	// Hours: integrated GPU-utilization × duration, expressed in hours.
	// "1.5" means the GPU was effectively running at 100% for an hour
	// and a half over the window. With 4 GPUs at 100% for the same
	// hour you'd see 4.0.
	Hours float64 `json:"hours"`
}

type gpuHourResponse struct {
	Range       string       `json:"range"`
	From        string       `json:"from"`
	To          string       `json:"to"`
	GeneratedAt string       `json:"generatedAt"`
	Rows        []gpuHourRow `json:"rows"`
	// Total over all rows. Hand back pre-summed so the frontend
	// doesn't have to repeat the work.
	Total float64 `json:"total"`
}

// GetGPUHour serves /api/v1/clusters/:id/gpu-hour?range=24h. Implicit
// auth model: anyone authenticated to the cluster sees all GPU-Hours
// — there is no per-tenant scoping yet. Aligns with the rest of the
// /compute pages which are also cluster-wide.
func GetGPUHour(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		rangeKey := c.DefaultQuery("range", "24h")
		spec, ok := supportedRanges[rangeKey]
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
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

		// 60s TTL — gpu-hour is the slowest VM query (30d range can
		// scan tens of millions of samples on a busy cluster) and the
		// underlying value only changes meaningfully on the order of
		// minutes. Caching server-side means a tab refreshing every
		// 5s pays the real cost once a minute. GetOrCompute layers
		// singleflight so multiple operators opening the same report
		// at once share a single fan-out.
		cacheKey := vmCacheKey("gpu-hour", clusterID, rangeKey)
		body, err := sharedVMResponseCache.GetOrCompute(cacheKey, 60*time.Second, func() (any, error) {
			// VM doesn't have a built-in trapezoidal integrator. We compute
			// avg_over_time(util/100) over the full window, multiply by
			// the window length in hours. Equivalent to integrating the
			// curve and accurate up to the original sampling rate (DCGM
			// default ~5s scrape). avg_over_time runs faster than a
			// query_range pull-and-sum, and the result is one vector
			// sample per series — cheap to ship over the worker tunnel.
			promql := fmt.Sprintf(
				`avg_over_time((DCGM_FI_DEV_GPU_UTIL / 100)[%s:%s])`,
				rangeKey, fmt.Sprintf("%ds", int(spec.step.Seconds())),
			)
			series, err := queryVM(ctx, gw, clusterID, vmURL, promql)
			if err != nil {
				return nil, err
			}

			hoursPerUnit := spec.duration.Hours()
			rows := make([]gpuHourRow, 0, len(series))
			var total float64
			for _, s := range series {
				h := s.Value * hoursPerUnit
				rows = append(rows, gpuHourRow{
					Hostname: s.Labels["Hostname"],
					Instance: s.Labels["instance"],
					GPU:      s.Labels["gpu"],
					UUID:     s.Labels["UUID"],
					Hours:    h,
				})
				total += h
			}

			sort.SliceStable(rows, func(i, j int) bool {
				return rows[i].Hours > rows[j].Hours
			})

			return gpuHourResponse{
				Range:       rangeKey,
				From:        from.UTC().Format(time.RFC3339),
				To:          now.UTC().Format(time.RFC3339),
				GeneratedAt: now.UTC().Format(time.RFC3339),
				Rows:        rows,
				Total:       total,
			}, nil
		})
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		c.Data(http.StatusOK, "application/json", body)
	}
}

// VM-side query_range pull-and-sum left as a future option. The avg_
// over_time approach above is simpler and good enough for v1; if we
// need millisecond-accurate billing we'll switch to true trapezoidal
// integration. Stub kept to make the alternate path obvious to the
// next reader.
//
//nolint:unused
func gpuHourPullAndSum(ctx context.Context, gw *gateway.GatewayServer, clusterID, vmURL string, from, to time.Time, step time.Duration) (map[string]float64, error) {
	rows, err := queryVMRange(ctx, gw, clusterID, vmURL,
		`DCGM_FI_DEV_GPU_UTIL / 100`, from, to, step)
	if err != nil {
		return nil, err
	}
	out := map[string]float64{}
	stepHours := step.Hours()
	for _, r := range rows {
		key := fmt.Sprintf("%s/%s", r.Labels["Hostname"], r.Labels["gpu"])
		for _, pt := range r.Points {
			out[key] += pt.Value * stepHours
		}
	}
	return out, nil
}
