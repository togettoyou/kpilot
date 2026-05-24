// Package handler — system-monitoring endpoints.
//
// Surface for the operator dashboard at /system. Conceptually the
// dashboard sees "nodes": one server (control-plane) + every online
// worker. Per-node it can fetch a one-shot Snapshot, open a 1 Hz WS
// stream, and download pprof profiles — all proxied through the
// existing tunnel (worker) or to the server's loopback diag mux
// (server) so the auth boundary stays at the main HTTP server's
// JWT middleware.
//
// Concurrency invariants:
//   - One node, many WS subscribers → exactly one upstream snapshot
//     per second (fan-out hub). N browsers on the same node do NOT
//     drive N tunnel pulls.
//   - First subscriber starts the ticker; last subscriber stops it.
//     Recount runs under the hub lock to avoid TOCTOU between
//     unsubscribe and an incoming new subscription.
//   - Per-subscriber writes use wsConn.WriteMessage (writeMu) so the
//     ping/pong heartbeat does not race with snapshot fan-out.
//   - Snapshot fetch has an 800 ms timeout per tick; a slow worker
//     causes us to skip the tick (no fallback / no retry), the next
//     tick tries again. Skipping costs nothing — the dashboard just
//     flatlines that one second.
package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

// systemNodeID is the URL :node path param value reserved for the
// server itself. Workers use their cluster_id (UUID). The literal
// "server" is short, memorable, and would be invalid as a UUID so
// can't clash with any worker.
const systemNodeID = "server"

// snapshotTimeout bounds one tick's fetch — a slow worker (cross-
// region link, GC pause) doesn't stall the hub. We just skip the
// tick and the next 1 s window retries.
const snapshotTimeout = 800 * time.Millisecond

// ─── REST endpoints ────────────────────────────────────────────────

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

// SystemSnapshot returns one node's current diag snapshot. Used by
// the detail page on first load (the WS catches up after) and by the
// landing page's per-row KPI refresh.
func SystemSnapshot(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		body, err := fetchNodeSnapshot(c.Request.Context(), gw, c.Param("node"))
		if err != nil {
			apiErrWorker(c, err.Error())
			return
		}
		c.Data(http.StatusOK, "application/json; charset=utf-8", body)
	}
}

// SystemSnapshots fan-fetches every monitorable node in parallel for
// the landing table. Each fetch is bounded by snapshotTimeout; failed
// nodes return {node_id, error} placeholders so partial outages don't
// drop the whole response.
func SystemSnapshots(gw *gateway.GatewayServer) gin.HandlerFunc {
	type item struct {
		NodeID   string          `json:"node_id"`
		Snapshot json.RawMessage `json:"snapshot,omitempty"`
		Error    string          `json:"error,omitempty"`
	}
	return func(c *gin.Context) {
		nodeIDs := []string{systemNodeID}
		clusters, err := store.ListClusters()
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		for _, cl := range clusters {
			if _, ok := gw.GetWorker(cl.ID); ok {
				nodeIDs = append(nodeIDs, cl.ID)
			}
		}

		out := make([]item, len(nodeIDs))
		var wg sync.WaitGroup
		for i, id := range nodeIDs {
			i, id := i, id
			wg.Add(1)
			go func() {
				defer wg.Done()
				body, err := fetchNodeSnapshot(c.Request.Context(), gw, id)
				out[i] = item{NodeID: id}
				if err != nil {
					out[i].Error = err.Error()
					return
				}
				out[i].Snapshot = body
			}()
		}
		wg.Wait()
		c.JSON(http.StatusOK, out)
	}
}

// SystemPprof reverse-proxies pprof endpoints to the underlying diag
// mux. Path: /system/:node/pprof/:kind (where :kind is heap, goroutine,
// allocs, block, mutex, threadcreate, profile, trace, cmdline, symbol).
// Query string is forwarded verbatim — important for ?seconds=30 on
// CPU profile and ?debug=2 on goroutine text dumps.
//
// CPU profile / trace require ?confirm=true to prevent accidental
// clicks: those endpoints take 30 s and visibly impact server CPU.
//
// Streams the upstream body straight to c.Writer instead of buffering —
// pprof CPU profile / trace can be tens of MB and a buffered path
// would briefly hold all of that on the heap for every concurrent
// download. The streaming path keeps server-side allocation flat.
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
		// CPU profile / trace are inherently 30 s — generous outer
		// timeout. Snapshot-class endpoints (heap, goroutine, etc.)
		// finish in milliseconds; the same outer timeout is harmless
		// because the upstream completes early.
		ctx, cancel := context.WithTimeout(c.Request.Context(), 90*time.Second)
		defer cancel()
		// streamDiagGET sets Content-Type itself when the upstream
		// responds; Content-Disposition we set inline below so a
		// pre-stream error path (worker offline, etc.) doesn't leak
		// the download header onto the JSON error response.
		err := streamDiagGET(ctx, c, gw, node, path, func() {
			c.Header("Content-Disposition", fmt.Sprintf(
				`attachment; filename="%s-%s.pb.gz"`, node, kind))
		})
		if err != nil {
			// Header may already be partly written if we got past the
			// status line; in that case fall through silently — the
			// download truncates and the browser surfaces the partial.
			if !c.Writer.Written() {
				apiErrWorker(c, err.Error())
			} else {
				log.Printf("[system] pprof stream truncated: node=%s kind=%s err=%v", node, kind, err)
			}
		}
	}
}

// ─── WebSocket fan-out hub ─────────────────────────────────────────

// systemHub is the per-process map of nodeID → ongoing 1 Hz pull.
// Goroutine count = number of distinct nodes with at least one
// active subscriber, NOT × number of subscribers per node.
//
// gateway lives in an atomic.Pointer (set once at boot, read lock-
// free on every tick) so the per-tick fetch doesn't contend with
// subscribe/unsubscribe for the hub mutex.
type systemHub struct {
	mu      sync.Mutex
	nodes   map[string]*nodeStream
	gateway atomic.Pointer[gateway.GatewayServer]
}

var hub = &systemHub{nodes: map[string]*nodeStream{}}

// SetSystemHubGateway installs the gateway dependency on the
// package-level hub. Called from cmd/server/main.go once; storing
// the gateway on the hub avoids threading it through every Subscribe
// invocation.
func SetSystemHubGateway(gw *gateway.GatewayServer) {
	hub.gateway.Store(gw)
}

// nodeStream is one ticking source feeding fan-out to N WS subscribers.
type nodeStream struct {
	nodeID   string
	subsMu   sync.Mutex
	subs     map[*wsConn]*subscriber
	stop     chan struct{}
	stopOnce sync.Once
	last     atomic.Pointer[[]byte] // most recent snapshot JSON (for new subscribers)
}

// subscriber tracks one WS conn's in-flight write state. The atomic
// flag lets the fan-out path skip queueing a new write goroutine for
// a slow consumer whose previous write hasn't completed yet — without
// it a paused tab could accumulate N goroutines per second waiting on
// the per-write deadline (10 s) before noticing the peer is gone.
type subscriber struct {
	conn    *wsConn
	writing atomic.Bool
}

// SystemStream is the WS upgrade handler. On connect: subscribe to
// the hub for the given node, send the most-recent snapshot (if any)
// immediately so the dashboard renders without waiting a full second,
// then loop until the WS read pump terminates (which happens on
// client close, ping timeout, or network drop).
func SystemStream(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		node := c.Param("node")
		// Reject upgrade for unknown nodes early so the browser sees
		// a 4xx and can show a clean error instead of dangling WS.
		if node != systemNodeID {
			if _, ok := gw.GetWorker(node); !ok {
				apiErrWorker(c, "node not connected")
				return
			}
		}
		rawConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			log.Printf("[system] ws upgrade failed: %v", err)
			return
		}
		ws := newWSConn(rawConn)
		defer rawConn.Close()

		hbCtx, hbCancel := context.WithCancel(c.Request.Context())
		defer hbCancel()
		ws.startHeartbeat(hbCtx)

		unsub := hub.subscribe(node, ws)
		defer unsub()

		// Reader pump: discards browser frames (we don't expect any
		// input on this socket), but is required so pong handler ticks
		// and so a closed connection unblocks promptly.
		for {
			if _, _, err := rawConn.NextReader(); err != nil {
				return
			}
		}
	}
}

func (h *systemHub) subscribe(nodeID string, ws *wsConn) func() {
	sub := &subscriber{conn: ws}
	h.mu.Lock()
	ns, ok := h.nodes[nodeID]
	if !ok {
		ns = &nodeStream{
			nodeID: nodeID,
			subs:   map[*wsConn]*subscriber{},
			stop:   make(chan struct{}),
		}
		h.nodes[nodeID] = ns
		go h.runNode(ns)
	}
	ns.subsMu.Lock()
	ns.subs[ws] = sub
	ns.subsMu.Unlock()
	h.mu.Unlock()

	// Send the most recent snapshot immediately so the dashboard
	// paints without waiting a full second.
	if snap := ns.last.Load(); snap != nil {
		_ = ws.WriteMessage(websocket.TextMessage, *snap)
	}

	return func() {
		h.mu.Lock()
		ns.subsMu.Lock()
		delete(ns.subs, ws)
		empty := len(ns.subs) == 0
		ns.subsMu.Unlock()
		if empty {
			delete(h.nodes, nodeID)
			ns.stopOnce.Do(func() { close(ns.stop) })
			log.Printf("[system] hub stopped node=%s", nodeID)
		}
		h.mu.Unlock()
	}
}

func (h *systemHub) runNode(ns *nodeStream) {
	// Defensive recover. If anything in the fetch / fan-out path
	// panics (collector bug, write to torn pipe, …) we don't want
	// the process to crash. Evict the node from h.nodes on the way
	// out so a fresh subscribe spawns a new goroutine — otherwise
	// future subscribers would find the stale ns and never get a
	// running ticker behind them. Existing subscribers' unsub
	// closures still reference `ns` directly; their delete on
	// h.nodes[nodeID] is idempotent so the eviction here doesn't
	// race them.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[system] hub panic node=%s: %v", ns.nodeID, r)
			h.mu.Lock()
			if cur, ok := h.nodes[ns.nodeID]; ok && cur == ns {
				delete(h.nodes, ns.nodeID)
			}
			h.mu.Unlock()
		}
	}()
	// 2 s cadence: 1 s redrew @ant-design/plots ~5–10 ms per chart;
	// the Scheduler tab has 9 charts visible at once = 50–90 ms /
	// sec ≈ 5–9% CPU on the browser tab just on redraws. Slowing to
	// 2 s halves that, doubles the ring-buffer window (2 h instead of
	// 1 h at 3600 samples), and stabilizes the per-tick CPU% delta
	// (a 2-second sampling window is less noisy than 1 s). Operator
	// can't perceive 1 Hz vs 0.5 Hz refresh anyway.
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	log.Printf("[system] hub started node=%s", ns.nodeID)
	// Only log fetch failures on the OK → failing transition (and the
	// failing → OK recovery). A worker that disconnects mid-subscription
	// would otherwise spam one line per second per node forever.
	var failing bool
	for {
		select {
		case <-ns.stop:
			return
		case <-t.C:
			gw := h.gateway.Load()
			ctx, cancel := context.WithTimeout(context.Background(), snapshotTimeout)
			body, err := fetchNodeSnapshot(ctx, gw, ns.nodeID)
			cancel()
			if err != nil {
				if !failing {
					log.Printf("[system] fetch failed: node=%s err=%v", ns.nodeID, err)
					failing = true
				}
				continue
			}
			if failing {
				log.Printf("[system] fetch recovered: node=%s", ns.nodeID)
				failing = false
			}
			ns.last.Store(&body)

			// Snapshot subscriber set under subsMu, then write
			// outside it so a stuck WS doesn't block fan-out to
			// other subscribers. Per-subscriber `writing` flag
			// (CAS) skips queueing a second goroutine while the
			// first is still inside WriteMessage's 10 s
			// writeWait — without it a paused tab would accrete
			// goroutines linearly at 1/sec until the deadline
			// finally returned errors.
			ns.subsMu.Lock()
			subs := make([]*subscriber, 0, len(ns.subs))
			for _, s := range ns.subs {
				subs = append(subs, s)
			}
			ns.subsMu.Unlock()
			for _, s := range subs {
				if !s.writing.CompareAndSwap(false, true) {
					continue // previous write still pending; skip this tick
				}
				go func(sub *subscriber) {
					defer sub.writing.Store(false)
					_ = sub.conn.WriteMessage(websocket.TextMessage, body)
				}(s)
			}
		}
	}
}

// ─── Shared snapshot fetcher ───────────────────────────────────────

// fetchNodeSnapshot returns the JSON bytes of one node's /debug/snapshot.
// Symmetric for server (loopback HTTP to local diag mux) and worker
// (gateway.SendHTTPRequest over tunnel to 127.0.0.1:<diag_port>).
func fetchNodeSnapshot(ctx context.Context, gw *gateway.GatewayServer, nodeID string) ([]byte, error) {
	body, _, _, err := proxyDiagGET(ctx, gw, nodeID, "/debug/snapshot")
	return body, err
}

// proxyDiagGET performs an HTTP GET against the per-node diag mux
// over whichever transport is appropriate (loopback or tunnel) and
// returns the body + status + Content-Type. Errors carry a short
// human message ("worker offline", "diag disabled on worker", ...).
func proxyDiagGET(ctx context.Context, gw *gateway.GatewayServer, nodeID, path string) (body []byte, status int, contentType string, err error) {
	if nodeID == systemNodeID {
		port := ServerDiagPort()
		if port == 0 {
			return nil, 0, "", fmt.Errorf("server diag not initialized")
		}
		url := fmt.Sprintf("http://127.0.0.1:%d%s", port, path)
		return localDiagGET(ctx, url)
	}

	if gw == nil {
		return nil, 0, "", fmt.Errorf("gateway unavailable")
	}
	w, ok := gw.GetWorker(nodeID)
	if !ok {
		return nil, 0, "", fmt.Errorf("worker offline")
	}
	if w.DiagPort == 0 {
		return nil, 0, "", fmt.Errorf("diag not enabled on worker")
	}
	url := fmt.Sprintf("http://127.0.0.1:%d%s", w.DiagPort, path)
	req := &gateway.HTTPRequest{Method: http.MethodGet, URL: url}
	resp, err := gw.SendHTTPRequest(ctx, nodeID, req)
	if err != nil {
		return nil, 0, "", fmt.Errorf("tunnel: %w", err)
	}
	if resp.Error != "" {
		return nil, 0, "", fmt.Errorf("worker: %s", resp.Error)
	}
	return resp.Body, int(resp.Status), headerValue(resp.Headers, "Content-Type"), nil
}

func localDiagGET(ctx context.Context, url string) ([]byte, int, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, "", err
	}
	resp, err := localDiagClient.Do(req)
	if err != nil {
		return nil, 0, "", err
	}
	defer resp.Body.Close()
	buf := &bytes.Buffer{}
	if _, err := io.Copy(buf, resp.Body); err != nil {
		return nil, 0, "", err
	}
	return buf.Bytes(), resp.StatusCode, resp.Header.Get("Content-Type"), nil
}

// streamDiagGET is the streaming counterpart to proxyDiagGET — used
// by SystemPprof so multi-MB CPU / trace profiles never get fully
// buffered on the server. Writes Content-Type + body straight to
// c.Writer with periodic Flush.
//
// beforeWrite, if non-nil, runs after we've decided the upstream is
// reachable but before any bytes are written to the response — the
// caller uses it to set headers (Content-Disposition) that would
// otherwise leak onto an error JSON response if the upstream failed
// pre-flight.
//
// Worker path opens a yamux STREAM_HTTP_REQUEST with stream_response;
// the worker forwards bytes live and we io.Copy them through. Local
// path uses the loopback http.Client with body left as a Reader.
func streamDiagGET(ctx context.Context, c *gin.Context, gw *gateway.GatewayServer, nodeID, path string, beforeWrite func()) error {
	if nodeID == systemNodeID {
		port := ServerDiagPort()
		if port == 0 {
			return fmt.Errorf("server diag not initialized")
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
		return fmt.Errorf("gateway unavailable")
	}
	w, ok := gw.GetWorker(nodeID)
	if !ok {
		return fmt.Errorf("worker offline")
	}
	if w.DiagPort == 0 {
		return fmt.Errorf("diag not enabled on worker")
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

// Dedicated client for loopback diag fetches. Short dial timeout
// (loopback is instant or broken); no per-request body cap because
// pprof profiles can legitimately be tens of MB. We rely on the
// caller's ctx timeout to bound the upper.
var localDiagClient = &http.Client{
	Transport: &http.Transport{
		MaxIdleConns:        4,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     30 * time.Second,
	},
	Timeout: 0, // controlled per request via ctx
}

func headerValue(hdrs []*pbv2.HTTPHeader, name string) string {
	for _, h := range hdrs {
		if strings.EqualFold(h.Name, name) {
			return h.Value
		}
	}
	return ""
}
