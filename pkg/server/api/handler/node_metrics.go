// Package handler — per-node monitoring panels.
//
// Drives the "Nodes" tab of /clusters/:id/monitoring. Returns one
// labeled series per node for each metric key. Hard dependency:
// node-exporter (instance label drives the per-node grouping). If
// node-exporter is not installed all series come back empty and the
// page shows an Empty state — the page itself still renders.
//
// ?groups=cpu,mem,disk,network,storage filters which PromQL queries
// fan out (Monitoring v2 lazy-loads each accordion section as it
// scrolls into view, so a typical page open only runs the keys the
// user actually sees). Backwards-compat: no `groups` param = all
// groups, matches the original behavior.
package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/gateway"

	kplog "github.com/togettoyou/kpilot/pkg/log"
)

var nodeMetricsLog = kplog.L("node-metrics")

// listNodeIPMap returns instanceIP → nodeName. Used to translate
// node-exporter's `instance` label (e.g. "10.203.0.8:9100") to the
// human-friendly Kubernetes node name (e.g. "vm-0-9-ubuntu") so
// charts can show consistent labels across all metrics — the
// upstream PromQL only carries `instance`, but operators think in
// node names.
//
// One list-full Node call per node-metrics request. Cheap relative
// to the dozen PromQL fan-outs; cluster size is bounded; falls back
// to instance-style labels when the call fails (logged + carry on).
func listNodeIPMap(ctx context.Context, gw *gateway.GatewayServer, clusterID string) map[string]string {
	resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
		Action:  "list-full",
		Group:   "",
		Version: "v1",
		Kind:    "Node",
	})
	if err != nil || resp == nil || !resp.Success {
		if err != nil {
			nodeMetricsLog.Warnf("list nodes failed: cluster=%s err=%v", clusterID, err)
		}
		return nil
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				Addresses []struct {
					Type    string `json:"type"`
					Address string `json:"address"`
				} `json:"addresses"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(resp.Data, &list); err != nil {
		nodeMetricsLog.Warnf("decode node list failed: cluster=%s err=%v", clusterID, err)
		return nil
	}
	m := make(map[string]string, len(list.Items))
	for _, n := range list.Items {
		for _, a := range n.Status.Addresses {
			// InternalIP is the address node-exporter listens on /
			// scrapes against. Hostname / ExternalIP can also match
			// in some setups so we index all three — first non-empty
			// wins per IP.
			if a.Type == "InternalIP" || a.Type == "ExternalIP" || a.Type == "Hostname" {
				if a.Address != "" {
					if _, exists := m[a.Address]; !exists {
						m[a.Address] = n.Metadata.Name
					}
				}
			}
		}
	}
	return m
}

// nodeNameFromInstance trims the port off node-exporter's instance
// (`10.203.0.8:9100` → `10.203.0.8`) and looks the IP up in the
// map. Empty return = no mapping found; caller falls back to the
// raw instance.
func nodeNameFromInstance(instance string, ipToName map[string]string) string {
	if ipToName == nil {
		return ""
	}
	host := instance
	if i := strings.LastIndex(instance, ":"); i > 0 {
		host = instance[:i]
	}
	return ipToName[host]
}


type nodeMetricSeries struct {
	// Instance is the node-exporter `instance` label
	// (typically "<ip>:9100"). NodeName is the kube node name when KSM
	// labels are available; empty otherwise — the frontend falls back
	// to Instance for display.
	Instance string         `json:"instance"`
	NodeName string         `json:"nodeName,omitempty"`
	// Mountpoint / Device are populated for per-partition / per-device
	// queries (diskPartitions, diskIOWait, …) — empty for plain
	// instance-keyed queries.
	Mountpoint string         `json:"mountpoint,omitempty"`
	Device     string         `json:"device,omitempty"`
	Points     []nodeMetricPt `json:"points"`
}

type nodeMetricPt struct {
	Ts    int64   `json:"ts"`
	Value float64 `json:"value"`
}

type nodeMetricsResponse struct {
	Range       string `json:"range"`
	From        string `json:"from"`
	To          string `json:"to"`
	GeneratedAt string `json:"generatedAt"`
	StepSeconds int    `json:"stepSeconds"`
	// Series keyed by metric id (cpu / mem / disk / netRx / netTx / …).
	// Each entry is one row per node (per partition / device for
	// breakdown queries).
	Series map[string][]nodeMetricSeries `json:"series"`
}

// nodeMetricQuery — one PromQL string + its label-extraction shape.
// labelKey hints which PromQL label drives the per-row "breakdown"
// dimension (empty = one row per instance; "mountpoint" = one row
// per mount per instance; "device" = one row per block device).
type nodeMetricQuery struct {
	key      string
	promql   string
	labelKey string
}

// nodeMetricQueries — all supported keys + their PromQL. Groups (used
// by ?groups=) reference these by key. Adding a new metric: append
// here + reference its key in the relevant group below.
var nodeMetricQueries = []nodeMetricQuery{
	// ─── CPU ──────────────────────────────────────────────────────
	{"cpu", `100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))`, ""},
	// Raw 1/5/15-min load. Pair with cpu / load-per-core to spot
	// "CPU 60% but load 8 on a 4-core" = I/O-bound contention.
	{"load1", `node_load1`, ""},
	{"load5", `node_load5`, ""},
	{"load15", `node_load15`, ""},
	// Load average normalized by core count — 1.0 means "all cores
	// busy + nothing waiting", >1 is queue forming.
	{"loadPerCore", `node_load1 / on(instance) group_left() count by (instance) (count by (cpu, instance) (node_cpu_seconds_total{mode="idle"}))`, ""},

	// ─── Memory ───────────────────────────────────────────────────
	{"mem", `100 * (1 - sum by (instance) (node_memory_MemAvailable_bytes) / sum by (instance) (node_memory_MemTotal_bytes))`, ""},
	// Absolute bytes used — UI formats with auto-scale (MiB / GiB).
	{"memUsed", `sum by (instance) (node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)`, ""},

	// ─── Disk capacity ────────────────────────────────────────────
	{"disk", `100 * (1 - sum by (instance) (node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"}) / sum by (instance) (node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"}))`, ""},
	// Per-mountpoint utilization — separate row per (instance, mount).
	// Operators chasing "node disk at 92%" want to know WHICH mount
	// is filling up (/var/lib/docker vs /).
	{"diskPartitions", `100 * (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"})`, "mountpoint"},
	// Inode utilization. 1B small files can exhaust inodes while byte
	// usage stays low — classic ops blind spot.
	{"inodeUtil", `100 * (1 - sum by (instance) (node_filesystem_files_free{fstype!~"tmpfs|overlay|squashfs"}) / sum by (instance) (node_filesystem_files{fstype!~"tmpfs|overlay|squashfs"}))`, ""},

	// ─── Network ──────────────────────────────────────────────────
	{"netRx", `sum by (instance) (rate(node_network_receive_bytes_total{device!~"lo|veth.*"}[5m]))`, ""},
	{"netTx", `sum by (instance) (rate(node_network_transmit_bytes_total{device!~"lo|veth.*"}[5m]))`, ""},
	{"netErrors", `sum by (instance) (rate(node_network_receive_errs_total{device!~"lo|veth.*"}[5m]) + rate(node_network_transmit_errs_total{device!~"lo|veth.*"}[5m]) + rate(node_network_receive_drop_total{device!~"lo|veth.*"}[5m]) + rate(node_network_transmit_drop_total{device!~"lo|veth.*"}[5m]))`, ""},
	// TCP established connections — capacity signal (kernel
	// somaxconn / file-handle exhaustion shows up here first).
	{"tcpConns", `node_netstat_Tcp_CurrEstab`, ""},
	// TCP retransmits — earlier-than-errs/drops signal of network
	// trouble; healthy clusters are usually << 1/s.
	{"tcpRetrans", `rate(node_netstat_Tcp_RetransSegs[5m])`, ""},

	// ─── Storage (block-device I/O) ───────────────────────────────
	// Bandwidth. loop/ram filtered out so kubelet image mounts don't
	// dominate; dm-* (LVM) kept — those carry real I/O on many setups.
	{"diskRead", `sum by (instance) (rate(node_disk_read_bytes_total{device!~"loop.*|ram.*"}[5m]))`, ""},
	{"diskWrite", `sum by (instance) (rate(node_disk_written_bytes_total{device!~"loop.*|ram.*"}[5m]))`, ""},
	// IOPS — latency-correlated. A workload can saturate IOPS budget
	// while throughput stays low (random small reads on SATA SSD).
	{"diskReadOps", `sum by (instance) (rate(node_disk_reads_completed_total{device!~"loop.*|ram.*"}[5m]))`, ""},
	{"diskWriteOps", `sum by (instance) (rate(node_disk_writes_completed_total{device!~"loop.*|ram.*"}[5m]))`, ""},
	// I/O wait time — weighted seconds queued (iostat's await*ops). Per
	// block device so a single noisy mount stands out.
	{"diskIOWait", `rate(node_disk_io_time_weighted_seconds_total{device!~"loop.*|ram.*"}[5m])`, "device"},
	// I/O service time — average seconds per op (iostat's svctm). Per
	// device. Together with IOWait it diagnoses queue depth vs slow
	// individual ops.
	{"diskIOService", `rate(node_disk_io_time_seconds_total{device!~"loop.*|ram.*"}[5m]) / (rate(node_disk_reads_completed_total{device!~"loop.*|ram.*"}[5m]) + rate(node_disk_writes_completed_total{device!~"loop.*|ram.*"}[5m]) > 0)`, "device"},
	// I/O busy ratio (iostat %util — fraction of wall time the device
	// was servicing I/O). Per device. > 80% = bottlenecked.
	{"diskIOBusy", `100 * rate(node_disk_io_time_seconds_total{device!~"loop.*|ram.*"}[5m])`, "device"},
}

// nodeMetricGroups — UI accordion sections (one HTTP call each) map
// to a subset of metric keys. Keep the keys here in sync with the
// frontend's NodeTab section list.
var nodeMetricGroups = map[string][]string{
	"cpu":     {"cpu", "load1", "load5", "load15", "loadPerCore"},
	"mem":     {"mem", "memUsed"},
	"disk":    {"disk", "diskPartitions", "inodeUtil"},
	"network": {"netRx", "netTx", "netErrors", "tcpConns", "tcpRetrans"},
	"storage": {"diskRead", "diskWrite", "diskReadOps", "diskWriteOps", "diskIOWait", "diskIOService", "diskIOBusy"},
}

// resolveQueryKeys returns the unique set of metric keys to fan out
// for. Empty / missing groups param = all keys (full back-compat with
// the pre-v2 single-call shape).
func resolveQueryKeys(groupsParam string, groups map[string][]string) (keys []string, cacheSig string) {
	if groupsParam == "" {
		return nil, "all" // nil = all-known
	}
	requested := strings.Split(groupsParam, ",")
	set := make(map[string]struct{})
	picked := make([]string, 0)
	for _, g := range requested {
		g = strings.TrimSpace(g)
		if keysForGroup, ok := groups[g]; ok {
			for _, k := range keysForGroup {
				if _, dup := set[k]; dup {
					continue
				}
				set[k] = struct{}{}
				picked = append(picked, k)
			}
		}
	}
	sort.Strings(picked)
	return picked, "g=" + strings.Join(picked, ",")
}

// GetNodeMetrics serves /api/v1/clusters/:id/node-metrics?range=…
// &groups=…
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

		// Resolve which PromQL keys to fan out based on ?groups=. nil
		// = all (no groups param, back-compat path).
		picked, sig := resolveQueryKeys(c.Query("groups"), nodeMetricGroups)
		queries := make([]nodeMetricQuery, 0, len(nodeMetricQueries))
		if picked == nil {
			queries = nodeMetricQueries
		} else {
			pickedSet := make(map[string]struct{}, len(picked))
			for _, k := range picked {
				pickedSet[k] = struct{}{}
			}
			for _, q := range nodeMetricQueries {
				if _, ok := pickedSet[q.key]; ok {
					queries = append(queries, q)
				}
			}
		}

		// Cache key includes the groups signature so calls for
		// different group sets don't share a body.
		cacheKey := vmCacheKey("node-metrics", clusterID, tr.cacheSuffix+"|"+sig)
		body, err := sharedVMResponseCache.GetOrCompute(cacheKey, 4*time.Second, func() (any, error) {
			// One list-Node up front; reused across every PromQL
			// projection to translate instance → node name. Empty
			// map = upstream call failed; per-row code falls back
			// to the raw instance.
			ipToName := listNodeIPMap(ctx, gw, clusterID)
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
						// Resolve node name with the precedence:
						//   1. native `node` label (rare — only some
						//      KSM-derived queries carry it)
						//   2. IP-to-name lookup against the live
						//      Node list (covers all node-exporter
						//      queries which only have `instance`)
						//   3. raw instance as last-resort fallback
						//      so a row never disappears entirely
						instance := s.Labels["instance"]
						nodeName := s.Labels["node"]
						if nodeName == "" {
							nodeName = nodeNameFromInstance(instance, ipToName)
						}
						row := nodeMetricSeries{
							Instance: instance,
							NodeName: nodeName,
							Points:   pts,
						}
						// Per-breakdown queries carry an extra label
						// (mountpoint / device) that lifts to its own
						// row dimension.
						if q.labelKey == "mountpoint" {
							row.Mountpoint = s.Labels["mountpoint"]
						} else if q.labelKey == "device" {
							row.Device = s.Labels["device"]
						}
						rows = append(rows, row)
					}
					// Stable order so chart legends don't reshuffle
					// between refreshes — sort by the breakdown label
					// when present (otherwise by instance).
					sort.SliceStable(rows, func(i, j int) bool {
						if rows[i].Instance != rows[j].Instance {
							return rows[i].Instance < rows[j].Instance
						}
						if rows[i].Mountpoint != rows[j].Mountpoint {
							return rows[i].Mountpoint < rows[j].Mountpoint
						}
						return rows[i].Device < rows[j].Device
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
