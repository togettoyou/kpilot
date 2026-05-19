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
		tr, ok := resolveTimeRange(c, clusterMetricsRanges)
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

		cacheKey := vmCacheKey("node-metrics", clusterID, tr.cacheSuffix)
		body, err := sharedVMResponseCache.GetOrCompute(cacheKey, 4*time.Second, func() (any, error) {

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
			// IOPS (operations / sec) is the latency-correlated signal
			// — a workload can saturate IOPS budget while throughput
			// stays low (random small reads on a SATA SSD, say). Same
			// device filter as the bandwidth pair above.
			{"diskReadOps", `sum by (instance) (rate(node_disk_reads_completed_total{device!~"loop.*|ram.*"}[5m]))`},
			{"diskWriteOps", `sum by (instance) (rate(node_disk_writes_completed_total{device!~"loop.*|ram.*"}[5m]))`},
			{"netRx", `sum by (instance) (rate(node_network_receive_bytes_total{device!~"lo|veth.*"}[5m]))`},
			{"netTx", `sum by (instance) (rate(node_network_transmit_bytes_total{device!~"lo|veth.*"}[5m]))`},
			// Load average normalized by core count — 1.0 means "all
			// cores busy + nothing waiting", >1 is queue forming.
			// Pair with CPU utilization: CPU 60% + load 3.0 on an
			// 8-core box means most of the time is spent waiting on
			// I/O, not on CPU.
			{"loadPerCore", `node_load1 / on(instance) group_left() count by (instance) (count by (cpu, instance) (node_cpu_seconds_total{mode="idle"}))`},
			// Network errors + drops summed across all non-lo / non-veth
			// devices. Trending up = link degradation; sustained > 0
			// typically warrants kicking the NIC / kernel driver.
			{"netErrors", `sum by (instance) (rate(node_network_receive_errs_total{device!~"lo|veth.*"}[5m]) + rate(node_network_transmit_errs_total{device!~"lo|veth.*"}[5m]))`},
			// Filesystem inode utilization. 1B small files can exhaust
			// inodes while byte usage stays low — orthogonal to disk%
			// and a classic ops blind spot.
			{"inodeUtil", `100 * (1 - sum by (instance) (node_filesystem_files_free{fstype!~"tmpfs|overlay|squashfs"}) / sum by (instance) (node_filesystem_files{fstype!~"tmpfs|overlay|squashfs"}))`},
			// TCP retransmits rate. Earlier-than-errs/drops signal of
			// network trouble; healthy clusters are usually << 1/s.
			{"tcpRetrans", `rate(node_netstat_Tcp_RetransSegs[5m])`},
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
				series, err := queryVMRange(ctx, gw, clusterID, vmURL, q.promql, from, to, tr.step)
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

			return nodeMetricsResponse{
				Range:       tr.cacheSuffix,
				From:        from.UTC().Format(time.RFC3339),
				To:          to.UTC().Format(time.RFC3339),
				GeneratedAt: time.Now().UTC().Format(time.RFC3339),
				StepSeconds: int(tr.step.Seconds()),
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
