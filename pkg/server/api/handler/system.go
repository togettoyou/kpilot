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
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

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

// SystemSnapshot returns the latest stored snapshot for one node.
// 404 + EMPTY_SNAPSHOT when the poller hasn't produced anything yet
// (server cold-start window, worker just registered, worker stayed
// offline since boot).
func SystemSnapshot(_ *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		s, err := store.LatestSystemSnapshot(c.Param("node"))
		if errors.Is(err, gorm.ErrRecordNotFound) {
			apiErrWorker(c, "no snapshot yet")
			return
		}
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		c.Data(http.StatusOK, "application/json; charset=utf-8", s.Snapshot)
	}
}

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

// SystemHistory returns the chronological run of snapshots for one
// node. Query params:
//
//	?since=<RFC3339>   only rows with at > since; default = now - 1 h
//	?limit=<n>         max rows; default 240 (1 h at 15 s polling)
//
// Response shape: [{at, snapshot}, ...] in ASC time order so the
// frontend can append directly to its local ring. Used by the
// detail page's first-load (no since) and its 15 s polling tick
// (since=lastSampleAt) — incremental fetch, no overlap.
func SystemHistory(_ *gateway.GatewayServer) gin.HandlerFunc {
	type item struct {
		At       time.Time       `json:"at"`
		Snapshot json.RawMessage `json:"snapshot"`
	}
	return func(c *gin.Context) {
		nodeID := c.Param("node")
		// Defaults: last hour, capped at 240 samples (≈ 1 h at
		// 15 s polling). Caller can override either.
		since := time.Now().UTC().Add(-1 * time.Hour)
		if s := c.Query("since"); s != "" {
			t, err := time.Parse(time.RFC3339, s)
			if err != nil {
				apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
				return
			}
			since = t
		}
		limit := 240
		if l := c.Query("limit"); l != "" {
			if n, err := strconv.Atoi(l); err == nil && n > 0 {
				limit = n
			}
		}

		rows, err := store.SystemSnapshotsSince(nodeID, since, limit)
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
				log.Printf("[system] pprof stream truncated: node=%s kind=%s err=%v", node, kind, err)
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

