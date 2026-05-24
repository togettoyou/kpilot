// Package handler — system-monitoring endpoints.
//
// Surface for the operator dashboard at /system. Conceptually the
// dashboard sees "nodes": one server (control-plane) + every
// registered worker. Per-node it can fetch:
//
//   - the latest diag snapshot (one row from system_snapshots)
//   - the last ~1 h of snapshots (range read from system_snapshots)
//   - pprof profiles, reverse-proxied through the worker tunnel
//     (server: loopback HTTP, worker: yamux SendHTTPRequestStream)
//
// Writes to system_snapshots are owned entirely by the diag.Poller
// (pkg/server/diag/poller.go), which runs a per-node 15 s ticker.
// Handlers in this file are pure DB readers — strict R/W split
// keeps the dashboard cheap regardless of subscriber count and
// survives server restarts (history is in PG).
//
// pprof remains live-tunneled (never persisted) because those
// profiles are operator-initiated, per-request, often tens of MB,
// and pointless to store.
package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"

	kplog "github.com/togettoyou/kpilot/pkg/log"
)

var systemLog = kplog.L("system")

// systemNodeID is the URL :node path param value reserved for the
// server itself. Workers use their cluster_id (UUID). The literal
// "server" is short, memorable, and would be invalid as a UUID so
// can't clash with any worker.
const systemNodeID = "server"

// ─── Node list (cluster registry view) ─────────────────────────────

// SystemNodeInfo is the per-node summary card the landing table renders.
type SystemNodeInfo struct {
	NodeID      string `json:"node_id"`
	Kind        string `json:"kind"` // "server" / "worker"
	ClusterID   string `json:"cluster_id,omitempty"`
	ClusterName string `json:"cluster_name,omitempty"`
	Online      bool   `json:"online"`
	DiagAvail   bool   `json:"diag_available"`
}

// SystemNodes returns the list of monitorable nodes:
//   - One row for the server itself ({node_id: "server", ...}).
//   - One row per cluster in store.ListClusters; Online=true when the
//     gateway reports an active worker session; DiagAvail=true when
//     that session reported a non-zero diag_port at register time.
func SystemNodes(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		nodes := []SystemNodeInfo{{
			NodeID:    systemNodeID,
			Kind:      "server",
			Online:    true,
			DiagAvail: ServerDiagPort() != 0,
		}}
		clusters, err := store.ListClusters()
		if err != nil {
			apiErrInternal(c, fmt.Errorf("list clusters: %w", err))
			return
		}
		for _, cl := range clusters {
			info := SystemNodeInfo{
				NodeID:      cl.ID,
				Kind:        "worker",
				ClusterID:   cl.ID,
				ClusterName: cl.Name,
			}
			if w, ok := gw.GetWorker(cl.ID); ok {
				info.Online = true
				info.DiagAvail = w.DiagPort != 0
			}
			nodes = append(nodes, info)
		}
		c.JSON(http.StatusOK, nodes)
	}
}

// ─── Snapshot reads (from system_snapshots) ────────────────────────

// SystemSnapshots returns the latest snapshot per known node. Used
// by the landing table — one DB roundtrip (DISTINCT ON) replaces the
// pre-DB fan-out that opened one yamux stream per worker on every
// refresh. Nodes without a row yet appear with `error="no data"`
// so partial coverage doesn't drop the response shape.
func SystemSnapshots(_ *gateway.GatewayServer) gin.HandlerFunc {
	type item struct {
		NodeID   string          `json:"node_id"`
		Snapshot json.RawMessage `json:"snapshot,omitempty"`
		Error    string          `json:"error,omitempty"`
	}
	return func(c *gin.Context) {
		rows, err := store.LatestSystemSnapshots()
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		latest := make(map[string][]byte, len(rows))
		for _, r := range rows {
			latest[r.NodeID] = r.Snapshot
		}

		// Walk the canonical node list (server + clusters) so the
		// response order matches the landing table; rows the poller
		// hasn't filled yet get a clear error string.
		nodeIDs := []string{systemNodeID}
		clusters, err := store.ListClusters()
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		for _, cl := range clusters {
			nodeIDs = append(nodeIDs, cl.ID)
		}

		out := make([]item, 0, len(nodeIDs))
		for _, id := range nodeIDs {
			if body, ok := latest[id]; ok {
				out = append(out, item{NodeID: id, Snapshot: body})
				continue
			}
			out = append(out, item{NodeID: id, Error: "no data"})
		}
		c.JSON(http.StatusOK, out)
	}
}

// systemHistoryPresets — the five durations the detail page's
// TimeRangePicker offers. Step is set to roughly (duration / 240)
// so resolveTimeRange's cache key has meaningful granularity,
// though we don't actually use step (PG-side downsampling picks
// its own modulo). Listed in resolveTimeRange's `presets` arg.
var systemHistoryPresets = map[string]timeRangeSpec{
	"1h":  {duration: 1 * time.Hour, step: 15 * time.Second},
	"3h":  {duration: 3 * time.Hour, step: 45 * time.Second},
	"6h":  {duration: 6 * time.Hour, step: 90 * time.Second},
	"12h": {duration: 12 * time.Hour, step: 3 * time.Minute},
	"24h": {duration: 24 * time.Hour, step: 6 * time.Minute},
}

// systemHistoryMaxRows caps every /history response so the chart
// stays renderable regardless of how wide the requested range is.
// 240 ≈ 1 sample / 15 s for 1 h (no actual downsample), 1/6 min
// for 24 h (visible-trend resolution; spike detail requires
// narrowing the range).
const systemHistoryMaxRows = 240

// SystemHistory returns the chronological run of snapshots for one
// node. Two operating modes:
//
//	?since=<RFC3339>           — incremental: rows strictly after
//	                              since, no downsampling. The detail
//	                              page uses this only on the 1 h
//	                              preset for its 15 s polling tick
//	                              (each tick adds 1-2 rows).
//
//	?range=1h|3h|6h|12h|24h    — full window via the shared
//	?from=<RFC3339>&to=<RFC3339>  TimeRangePicker vocabulary; uses
//	                              resolveTimeRange. Result is
//	                              uniformly downsampled to at most
//	                              ~240 rows so a 24 h selection
//	                              still renders fast.
//
// Response shape (both modes): [{at, snapshot}, ...] in ASC time
// order so the frontend can append (since path) or replace (range
// path) its local ring buffer directly.
func SystemHistory(_ *gateway.GatewayServer) gin.HandlerFunc {
	type item struct {
		At       time.Time       `json:"at"`
		Snapshot json.RawMessage `json:"snapshot"`
	}
	return func(c *gin.Context) {
		nodeID := c.Param("node")

		// Incremental mode — used by the 1 h live polling tick.
		if sinceStr := c.Query("since"); sinceStr != "" {
			since, err := time.Parse(time.RFC3339, sinceStr)
			if err != nil {
				apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
				return
			}
			rows, err := store.SystemSnapshotsSince(nodeID, since, systemHistoryMaxRows)
			if err != nil {
				apiErrInternal(c, err)
				return
			}
			out := make([]item, 0, len(rows))
			for _, r := range rows {
				out = append(out, item{At: r.At, Snapshot: r.Snapshot})
			}
			c.JSON(http.StatusOK, out)
			return
		}

		// Range mode — preset or custom. Downsampled.
		rng, ok := resolveTimeRange(c, systemHistoryPresets)
		if !ok {
			return // resolveTimeRange already wrote the error
		}
		rows, err := store.SystemSnapshotsRange(nodeID, rng.from, rng.to, systemHistoryMaxRows)
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		out := make([]item, 0, len(rows))
		for _, r := range rows {
			out = append(out, item{At: r.At, Snapshot: r.Snapshot})
		}
		c.JSON(http.StatusOK, out)
	}
}

// ─── Log reads (from system_logs) ─────────────────────────────────

// systemLogsRangePresets — TimeRangePicker offers for the logs page.
// Same vocabulary as SystemHistory so the operator can flip between
// the monitoring + logs tabs with the same range. Step values are
// unused (PG-side filtering doesn't downsample log rows; capped via
// `limit` instead).
var systemLogsRangePresets = map[string]timeRangeSpec{
	"15m": {duration: 15 * time.Minute},
	"1h":  {duration: 1 * time.Hour},
	"3h":  {duration: 3 * time.Hour},
	"6h":  {duration: 6 * time.Hour},
	"12h": {duration: 12 * time.Hour},
	"24h": {duration: 24 * time.Hour},
}

// SystemLogs returns log entries for one node. Pulls from
// system_logs (the LogsPoller is the sole writer).
//
// Two operating modes, mutually exclusive:
//
//	?after_seq=<uint64>            — live tail. Returns rows with
//	                                  seq > after_seq, newest first,
//	                                  capped at limit. The frontend's
//	                                  2 s polling tick uses this to
//	                                  pick up just-arrived lines.
//
//	?range= | ?from=&to=           — windowed query via the shared
//	                                  TimeRangePicker vocabulary. Plus
//	                                  optional filters:
//	                                    ?level=info|warn|error  (>=)
//	                                    ?module=<exact-or-prefix>
//	                                    ?q=<substring>
//
// Hard cap 10 000 rows/response. Frontend uses virtual scrolling so
// larger windows just trim oldest first (newest-first order).
//
// Concurrency cap on heavy queries: when limit ≥ heavyLogsThreshold
// the request takes a slot from heavyLogsSem before running. The
// JSON response of a 10k-row pull is roughly 3 MB; under load
// without back-pressure 128 in-flight pulls peaked at ~500 MB and
// OOM-killed a 1 Gi server in stress tests. The semaphore caps
// peak in-flight memory at heavyLogsConcurrency × ~3 MB ≈ 48 MB
// even under a thundering-herd, at the cost of returning 503 to
// the (rare) request that finds all slots taken.
//
// Response: [{seq, at, level, module, msg, fields}, ...] newest first.
//
// 503 body: {code: "SERVER_BUSY"} when the semaphore is exhausted.
var (
	heavyLogsThreshold   = 1000
	heavyLogsConcurrency = 16
	heavyLogsSem         = make(chan struct{}, heavyLogsConcurrency)
)

func SystemLogs(_ *gateway.GatewayServer) gin.HandlerFunc {
	type item struct {
		// seq is the anchored UnixNano (~1.8e18) — exceeds
		// JavaScript Number precision (2^53). Serialize as JSON
		// string so the browser keeps lossless cursor identity
		// across the dedupe Set / lastSeq tracking.
		Seq    uint64          `json:"seq,string"`
		At     time.Time       `json:"at"`
		Level  string          `json:"level"`
		Module string          `json:"module,omitempty"`
		Msg    string          `json:"msg"`
		Fields json.RawMessage `json:"fields,omitempty"`
	}
	return func(c *gin.Context) {
		nodeID := c.Param("node")

		filter := store.SystemLogFilter{
			NodeID: nodeID,
			Level:  store.SystemLogLevelAny,
		}

		// Live-tail mode: after_seq is exclusive. No time range —
		// caller assumes "anything newer than this seq".
		if afterStr := c.Query("after_seq"); afterStr != "" {
			var after uint64
			if _, err := fmt.Sscanf(afterStr, "%d", &after); err != nil {
				apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
				return
			}
			filter.AfterSeq = after
		} else {
			// Range mode. Time window required; default to last 1h
			// when nothing specified (matches what an operator
			// landing on the page would expect).
			rng, ok := resolveTimeRange(c, systemLogsRangePresets)
			if !ok {
				return
			}
			filter.From = rng.from
			filter.To = rng.to
		}

		// Level filter — accepts string or int8. Empty means "all".
		if lvlStr := c.Query("level"); lvlStr != "" {
			filter.Level = store.ParseLogLevel(strings.ToLower(lvlStr))
		}
		if mod := strings.TrimSpace(c.Query("module")); mod != "" {
			filter.Module = mod
		}
		if q := strings.TrimSpace(c.Query("q")); q != "" {
			filter.Q = q
		}
		if limStr := c.Query("limit"); limStr != "" {
			var lim int
			if _, err := fmt.Sscanf(limStr, "%d", &lim); err == nil && lim > 0 {
				filter.Limit = lim
			}
		}

		// Bound peak in-flight memory for "heavy" pulls. See the
		// heavyLogsSem doc above for the why. Non-blocking try-send
		// — if all slots are taken we 503 immediately instead of
		// queueing requests behind a 60s wait (which would just shift
		// the OOM risk to client-side timeout pile-ups).
		if filter.Limit >= heavyLogsThreshold {
			select {
			case heavyLogsSem <- struct{}{}:
				defer func() { <-heavyLogsSem }()
			default:
				apiErr(c, http.StatusServiceUnavailable, CodeServerBusy)
				return
			}
		}

		rows, err := store.QuerySystemLogs(filter)
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		out := make([]item, 0, len(rows))
		for _, r := range rows {
			out = append(out, item{
				Seq:    r.Seq,
				At:     r.At,
				Level:  store.LevelString(r.Level),
				Module: r.Module,
				Msg:    r.Msg,
				Fields: json.RawMessage(r.Fields),
			})
		}
		c.JSON(http.StatusOK, out)
	}
}

// SystemLogModules returns the distinct module names present in
// the log table. Used by the frontend module picker to populate
// its options. The ?node_id= query param scopes the list to a
// single node — strongly recommended for picker UX (server-only
// module names like "router" / "gorm" don't belong in a worker's
// picker, and vice versa). When omitted, returns the global union.
func SystemLogModules(_ *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		nodeID := c.Query("node_id")
		mods, err := store.DistinctSystemLogModules(nodeID)
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		c.JSON(http.StatusOK, mods)
	}
}

// ─── pprof reverse proxy (live, never persisted) ───────────────────

// SystemPprof reverse-proxies pprof endpoints to the underlying diag
// mux. Path: /system/:node/pprof/:kind (where :kind is heap, goroutine,
// allocs, block, mutex, threadcreate, profile, trace, cmdline, symbol).
// Query string is forwarded verbatim — important for ?seconds=30 on
// CPU profile and ?debug=2 on goroutine text dumps.
//
// CPU profile / trace require ?confirm=true to prevent accidental
// clicks: those endpoints take 30 s and visibly impact server CPU.
//
// Streams the upstream body straight to c.Writer — pprof CPU profile
// / trace can be tens of MB and a buffered path would briefly hold
// all of that on the heap per concurrent download.
func SystemPprof(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		node := c.Param("node")
		kind := c.Param("kind")
		if kind == "profile" || kind == "trace" {
			if c.Query("confirm") != "true" {
				apiErr(c, http.StatusForbidden, CodePprofConfirmationRequired)
				return
			}
		}
		path := "/debug/pprof/" + kind
		if rq := c.Request.URL.RawQuery; rq != "" {
			path += "?" + rq
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 90*time.Second)
		defer cancel()
		err := streamDiagGET(ctx, c, gw, node, path, func() {
			c.Header("Content-Disposition", fmt.Sprintf(
				`attachment; filename="%s-%s.pb.gz"`, node, kind))
		})
		if err != nil {
			if !c.Writer.Written() {
				apiErrWorker(c, err.Error())
			} else {
				systemLog.Warnf("pprof stream truncated: node=%s kind=%s err=%v", node, kind, err)
			}
		}
	}
}

// streamDiagGET reverse-proxies a GET request to one node's diag mux
// in streaming mode. beforeWrite, if non-nil, runs after we've
// decided the upstream is reachable but before any bytes are written
// to the response — used by SystemPprof to set Content-Disposition
// without leaking it onto error JSON.
//
// Server path uses the loopback HTTP client; worker path opens a
// yamux STREAM_HTTP_REQUEST with stream_response so multi-MB pprof
// bodies never get fully buffered on the server.
func streamDiagGET(ctx context.Context, c *gin.Context, gw *gateway.GatewayServer, nodeID, path string, beforeWrite func()) error {
	if nodeID == systemNodeID {
		port := ServerDiagPort()
		if port == 0 {
			return errors.New("server diag not initialized")
		}
		url := fmt.Sprintf("http://127.0.0.1:%d%s", port, path)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		resp, err := localDiagClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if beforeWrite != nil {
			beforeWrite()
		}
		if ct := resp.Header.Get("Content-Type"); ct != "" {
			c.Writer.Header().Set("Content-Type", ct)
		}
		c.Writer.WriteHeader(resp.StatusCode)
		_, copyErr := io.Copy(c.Writer, resp.Body)
		return copyErr
	}

	if gw == nil {
		return errors.New("gateway unavailable")
	}
	w, ok := gw.GetWorker(nodeID)
	if !ok {
		return errors.New("worker offline")
	}
	if w.DiagPort == 0 {
		return errors.New("diag not enabled on worker")
	}
	url := fmt.Sprintf("http://127.0.0.1:%d%s", w.DiagPort, path)
	req := &gateway.HTTPRequest{Method: http.MethodGet, URL: url, StreamResponse: true}
	stream, err := gw.SendHTTPRequestStream(ctx, nodeID, req)
	if err != nil {
		return fmt.Errorf("tunnel: %w", err)
	}
	defer stream.Close()
	if stream.Error != "" {
		return fmt.Errorf("worker: %s", stream.Error)
	}
	if beforeWrite != nil {
		beforeWrite()
	}
	if ct := headerValue(stream.Headers, "Content-Type"); ct != "" {
		c.Writer.Header().Set("Content-Type", ct)
	}
	c.Writer.WriteHeader(int(stream.Status))
	_, copyErr := io.Copy(c.Writer, stream.Body)
	return copyErr
}

// Dedicated client for loopback diag fetches (pprof reverse-proxy
// path). Short dial timeout — loopback is instant or broken; no
// per-request body cap because pprof profiles can legitimately be
// tens of MB. We rely on the caller's ctx timeout to bound the upper.
var localDiagClient = &http.Client{
	Transport: &http.Transport{
		MaxIdleConns:        4,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     30 * time.Second,
	},
}

func headerValue(hdrs []*pbv2.HTTPHeader, name string) string {
	for _, h := range hdrs {
		if strings.EqualFold(h.Name, name) {
			return h.Value
		}
	}
	return ""
}

