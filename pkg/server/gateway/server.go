// Package gateway is the v2 (yamux) transport gateway between
// kpilot server and worker clusters. See docs/transport-v2.md.
//
// Each worker holds one TLS TCP conn → yamux session → N concurrent
// per-RPC streams. Server-initiated RPCs (resource list/get/apply,
// HTTP reverse proxy, Pod logs/exec, WS proxy, plugin enable/disable)
// each open a fresh yamux stream from the session and own its full
// lifecycle through Close. Worker-initiated pushes (plugin status,
// plugin install log) come in as streams that the server-side accept
// loop dispatches to their handler.
//
// This file owns:
//   - ConnectedWorker struct + bookkeeping
//   - GatewayServer + worker registry + register lifecycle helpers
//
// The Send* methods live in send.go; HTTPStream + SendHTTPRequestStream
// in http_stream.go; Logs / Exec / WS in stream.go; plugin command
// + status / log push handling in plugin.go + plugin_log.go.
package gateway

import (
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/togettoyou/kpilot/pkg/server/store"
	transportv2 "github.com/togettoyou/kpilot/pkg/transport/yamux"
)

// ConnectedWorker represents a live worker connection. Always
// backed by a yamux Session in v2 — phase B retired the v1 gRPC
// bidi stream entirely.
type ConnectedWorker struct {
	ClusterID string
	// ClusterDomain is the K8s DNS suffix the worker reported on
	// register (e.g. "cluster.local"). The reverse proxy uses it
	// to build the FQDN of the in-cluster Service it forwards to.
	ClusterDomain string

	// Session is the yamux multiplex over one TLS/TCP conn.
	// Send* methods call Session.Open(kind, …) per RPC.
	Session *transportv2.Session

	// lastSeenNS is the unix-nano timestamp the worker last sent
	// something application-visible. Maintained for the debug
	// /metrics snapshot only — liveness comes from yamux KeepAlive
	// (Session.CloseChan fires when the link dies), not from this
	// timestamp.
	lastSeenNS atomic.Int64

	// done closes when this ConnectedWorker is unregistered, used
	// by long-running per-worker goroutines (accept loop, log
	// pump) as a shutdown signal.
	cancelOnce sync.Once
	done       chan struct{}
}

func (w *ConnectedWorker) markSeen() { w.lastSeenNS.Store(time.Now().UnixNano()) }

// GatewayServer is the per-process registry of connected workers
// and the entry point for handler-side Send* / Open* calls.
type GatewayServer struct {
	mu      sync.RWMutex
	workers map[string]*ConnectedWorker

	// pluginLogMu guards the per-(cluster, plugin) install-log
	// buffers + their subscriber sets. See plugin_log.go.
	pluginLogMu       sync.Mutex
	pluginLogSessions map[string]*pluginLogSession

	// clusterDomainResolver lets pluginservice ask "what's worker
	// X's cluster_domain?" without importing this package's
	// concrete types — used during BuildEnableCommand to inject
	// ${KPILOT_CLUSTER_DOMAIN} into values.
	clusterDomainResolver ClusterDomainResolver
}

// ClusterDomainResolver is the indirection pluginservice uses to
// ask gateway for a worker's reported cluster_domain. Implemented
// by GatewayServer; defined as an interface so pluginservice
// doesn't need to import the gateway package.
type ClusterDomainResolver interface {
	ClusterDomain(clusterID string) string
}

func NewGatewayServer() *GatewayServer {
	g := &GatewayServer{
		workers:           make(map[string]*ConnectedWorker),
		pluginLogSessions: make(map[string]*pluginLogSession),
	}
	g.clusterDomainResolver = g
	return g
}

// GetWorker returns the connected worker for a cluster, or false
// when the cluster is offline.
func (g *GatewayServer) GetWorker(clusterID string) (*ConnectedWorker, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	w, ok := g.workers[clusterID]
	return w, ok
}

// KickWorker force-closes a connected worker's session. Used by
// the cluster delete / token rotate paths so the next reconnect
// fails. Idempotent on already-disconnected clusters.
func (g *GatewayServer) KickWorker(clusterID string) {
	g.mu.RLock()
	w, ok := g.workers[clusterID]
	g.mu.RUnlock()
	if !ok || w.Session == nil {
		return
	}
	_ = w.Session.Close()
}

// unregister removes a worker from the registry and clears its
// associated per-worker state. Called from handleYamuxConn when
// the session terminates (worker disconnect, keepalive timeout,
// session close, network drop).
func (g *GatewayServer) unregister(w *ConnectedWorker) {
	clusterID := w.ClusterID

	g.mu.Lock()
	cur, ok := g.workers[clusterID]
	wasCurrent := ok && cur == w
	if wasCurrent {
		delete(g.workers, clusterID)
	}
	g.mu.Unlock()

	if !wasCurrent {
		log.Printf("[gateway] worker exited (already replaced): cluster=%s", clusterID)
		return
	}

	if err := store.UpdateClusterStatus(clusterID, store.ClusterStatusOffline); err != nil {
		log.Printf("[gateway] update cluster offline failed: cluster=%s err=%v", clusterID, err)
	}
	w.cancelOnce.Do(func() {
		close(w.done)
	})
	log.Printf("[gateway] worker disconnected: cluster=%s", clusterID)
}

// MetricsSnapshot is the JSON shape /api/v1/metrics returns. Phase B
// reduces this to yamux-specific counters; the v1 sender queue
// depths / pending response map sizes are gone.
type MetricsSnapshot struct {
	Workers []WorkerSnapshot `json:"workers"`
}

// WorkerSnapshot is the per-worker debug view.
type WorkerSnapshot struct {
	ClusterID     string `json:"cluster_id"`
	ClusterDomain string `json:"cluster_domain"`
	NumStreams    int    `json:"num_streams"`
	LastSeen      int64  `json:"last_seen_unix_nano"`
}

// MetricsSnapshot returns the current observability snapshot.
func (g *GatewayServer) MetricsSnapshot() MetricsSnapshot {
	g.mu.RLock()
	defer g.mu.RUnlock()
	snap := MetricsSnapshot{Workers: make([]WorkerSnapshot, 0, len(g.workers))}
	for _, w := range g.workers {
		var n int
		if w.Session != nil {
			n = w.Session.NumStreams()
		}
		snap.Workers = append(snap.Workers, WorkerSnapshot{
			ClusterID:     w.ClusterID,
			ClusterDomain: w.ClusterDomain,
			NumStreams:    n,
			LastSeen:      w.lastSeenNS.Load(),
		})
	}
	return snap
}
