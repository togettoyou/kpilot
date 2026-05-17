// Package handler — per-node monitoring panels.
//
// Drives the "Nodes" tab of /clusters/:id/monitoring. Returns one
// labeled series per node for each of CPU / memory / disk / network
// receive / network transmit. Hard dependency: node-exporter (instance
// label drives the per-node grouping). If node-exporter is not
// installed all series come back empty and the page shows an Empty
// state — the page itself still renders.
package handler

import (
	"context"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

type nodeMetricSeries struct {
	// Instance is the node-exporter `instance` label
	// (typically "<ip>:9100"). NodeName is the kube node name when KSM
	// labels are available; empty otherwise — the frontend falls back
	// to Instance for display.
	Instance string             `json:"instance"`
	NodeName string             `json:"nodeName,omitempty"`
	Points   []nodeMetricPt     `json:"points"`
}

type nodeMetricPt struct {
	Ts    int64   `json:"ts"`
	Value float64 `json:"value"`
}

type nodeMetricsResponse struct {
	Range       string                          `json:"range"`
	From        string                          `json:"from"`
	To          string                          `json:"to"`
	GeneratedAt string                          `json:"generatedAt"`
	StepSeconds int                             `json:"stepSeconds"`
	// Series keyed by metric id (cpu / mem / disk / netRx / netTx).
	// Each entry is one row per node.
	Series map[string][]nodeMetricSeries `json:"series"`
}

// GetNodeMetrics serves /api/v1/clusters/:id/node-metrics?range=…
func GetNodeMetrics(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		rangeKey := c.DefaultQuery("range", "1h")
		spec, ok := clusterMetricsRanges[rangeKey]
		if !ok {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		cacheKey := vmCacheKey("node-metrics", clusterID, rangeKey)
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

		// PromQL grouped by `instance`. CPU is averaged across modes
		// per host; memory uses MemAvailable for the "used" delta.
		// Disk usage rolls up all non-tmpfs / non-overlay filesystems
		// to avoid double-counting bind-mounts. Network uses the
		// non-loopback aggregate.
		queries := []struct {
			key    string
			promql string
		}{
			{"cpu", `100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))`},
			{"mem", `100 * (1 - sum by (instance) (node_memory_MemAvailable_bytes) / sum by (instance) (node_memory_MemTotal_bytes))`},
			{"disk", `100 * (1 - sum by (instance) (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"}) / sum by (instance) (node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"}))`},
			// Disk I/O — operators care about read / write bandwidth
			// separately. loop / ram devices are filtered out so
			// kubelet image mounts don't dominate the chart; we keep
			// dm-* (LVM-backed disks) since those carry real I/O on
			// many production setups.
			{"diskRead", `sum by (instance) (rate(node_disk_read_bytes_total{device!~"loop.*|ram.*"}[5m]))`},
			{"diskWrite", `sum by (instance) (rate(node_disk_written_bytes_total{device!~"loop.*|ram.*"}[5m]))`},
			{"netRx", `sum by (instance) (rate(node_network_receive_bytes_total{device!~"lo|veth.*"}[5m]))`},
			{"netTx", `sum by (instance) (rate(node_network_transmit_bytes_total{device!~"lo|veth.*"}[5m]))`},
		}

		var (
			mu  sync.Mutex
			wg  sync.WaitGroup
			out = make(map[string][]nodeMetricSeries, len(queries))
		)
		for _, q := range queries {
			q := q
			wg.Add(1)
			go func() {
				defer wg.Done()
				series, err := queryVMRange(ctx, gw, clusterID, vmURL, q.promql, from, now, spec.step)
				if err != nil {
					logSoftErr("node-metrics", clusterID, q.key, err)
					return
				}
				rows := make([]nodeMetricSeries, 0, len(series))
				for _, s := range series {
					pts := make([]nodeMetricPt, 0, len(s.Points))
					for _, p := range s.Points {
						pts = append(pts, nodeMetricPt{Ts: p.Ts, Value: p.Value})
					}
					rows = append(rows, nodeMetricSeries{
						Instance: s.Labels["instance"],
						NodeName: s.Labels["node"],
						Points:   pts,
					})
				}
				// Stable instance order so chart legends don't reshuffle
				// between refreshes.
				sort.SliceStable(rows, func(i, j int) bool {
					return rows[i].Instance < rows[j].Instance
				})
				mu.Lock()
				out[q.key] = rows
				mu.Unlock()
			}()
		}
		wg.Wait()

		resp := nodeMetricsResponse{
			Range:       rangeKey,
			From:        from.UTC().Format(time.RFC3339),
			To:          now.UTC().Format(time.RFC3339),
			GeneratedAt: now.UTC().Format(time.RFC3339),
			StepSeconds: int(spec.step.Seconds()),
			Series:      out,
		}
		body, err := sharedVMResponseCache.Put(cacheKey, resp, 4*time.Second)
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		c.Data(http.StatusOK, "application/json", body)
	}
}
