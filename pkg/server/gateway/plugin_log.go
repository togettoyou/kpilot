package gateway

import (
	"log"
	"sync"
	"time"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// Plugin install / upgrade / uninstall log fan-out.
//
// Worker pushes PluginLogChunk + PluginLogEnd via the existing tunnel
// (see WorkerMessage oneof). Server keeps a per-(cluster, plugin) ring
// buffer so a UI tab opened mid-install replays the lines it missed,
// and fans live frames out to any currently-subscribed WebSocket
// connection. No DB persistence in v1 — buffers TTL out 10 min after
// the last activity.

// PluginLogEntry is the wire shape the HTTP handler streams to the
// browser. Mirrors the proto fields but adds a `kind` discriminator so
// the same WS channel can carry chunks, the terminal "end" frame, and
// the "reset" sentinel emitted when a new session starts on a plugin
// that already had an end frame (user clicked Disable on a Running
// plugin, or re-Enabled after a Failed).
type PluginLogEntry struct {
	Kind    string `json:"kind"`              // "chunk" / "end" / "reset"
	Level   string `json:"level,omitempty"`   // info / warn / error  (chunk only)
	Ts      int64  `json:"ts,omitempty"`      // unix ms  (chunk only)
	Message string `json:"message,omitempty"` // chunk text
	Success bool   `json:"success,omitempty"` // end only
	Summary string `json:"summary,omitempty"` // end only
}

const (
	// pluginLogBufferSize bounds memory per (cluster, plugin) session.
	// Real-world Helm installs emit ~20-50 lines for a typical chart;
	// 500 leaves headroom for chatty umbrella charts (cert-manager,
	// kube-prometheus-stack) without unbounded growth.
	pluginLogBufferSize = 500
	// pluginLogSubscriberBuf is the per-subscriber channel capacity.
	// Helm log lines arrive sequentially from the worker, so a slow
	// browser client only needs enough headroom for the WS write loop
	// to drain between bursts. 32 is generous; over that we drop and
	// log (same pattern as the Stream session backlog).
	pluginLogSubscriberBuf = 32
	// pluginLogIdleTTL evicts buffers that haven't seen activity for
	// this long. Keeps memory bounded across many short-lived installs.
	pluginLogIdleTTL = 10 * time.Minute
)

// pluginLogSession is the per-(cluster, plugin) state: ring buffer of
// recent entries + the set of currently-subscribed WS handlers.
// Idempotent re-Install (user clicked Enable twice) reuses the same
// session — fresh entries land on top of the old ones in the ring
// buffer, which is exactly the behavior the UI wants ("retry attempt
// 2: chart download...").
type pluginLogSession struct {
	mu        sync.Mutex
	buf       []PluginLogEntry // ring buffer; len(buf) <= pluginLogBufferSize
	lastSeen  time.Time
	subs      map[*pluginLogSubscriber]struct{}
	closed    bool // set after PluginLogEnd; new appends accepted but subs see End first
}

type pluginLogSubscriber struct {
	ch      chan PluginLogEntry
	dropped int // diagnostic counter; logged once per power-of-two threshold
}

// pluginLogKey is `clusterID|crdName`. Pipe as separator because crd
// names are DNS-1123 (no pipe), so this is collision-free.
func pluginLogKey(clusterID, crdName string) string {
	return clusterID + "|" + crdName
}

// recordPluginLog is called by handleWorkerMessage when the worker
// pushes a PluginLogChunk frame.
func (g *GatewayServer) recordPluginLog(clusterID string, chunk *proto.PluginLogChunk) {
	entry := PluginLogEntry{
		Kind:    "chunk",
		Level:   chunk.Level,
		Ts:      chunk.Ts,
		Message: chunk.Message,
	}
	g.appendPluginLog(clusterID, chunk.CrdName, entry, false)
}

// recordPluginLogEnd is called when the worker pushes PluginLogEnd.
// We mark the session closed and stop accepting subscribers for new
// frames, but keep the buffer around so late-joiners can replay the
// outcome inside the TTL window.
func (g *GatewayServer) recordPluginLogEnd(clusterID string, end *proto.PluginLogEnd) {
	entry := PluginLogEntry{
		Kind:    "end",
		Success: end.Success,
		Summary: end.Summary,
	}
	g.appendPluginLog(clusterID, end.CrdName, entry, true)
}

func (g *GatewayServer) appendPluginLog(clusterID, crdName string, entry PluginLogEntry, isEnd bool) {
	key := pluginLogKey(clusterID, crdName)
	g.pluginLogMu.Lock()
	sess, ok := g.pluginLogSessions[key]
	if !ok {
		sess = &pluginLogSession{
			subs: make(map[*pluginLogSubscriber]struct{}),
		}
		g.pluginLogSessions[key] = sess
	}
	g.pluginLogMu.Unlock()

	sess.mu.Lock()
	sess.lastSeen = time.Now()
	if isEnd {
		sess.closed = true
	} else if sess.closed {
		// New activity after a prior End — a fresh install / upgrade /
		// uninstall is starting on the same plugin. Drop the previous
		// session's entries so a late subscriber doesn't replay
		// "installed ✓" right before "uninstalling release…" + signal
		// live subscribers to clear their local state via a reset frame
		// (handled below before this fresh chunk lands).
		sess.closed = false
		sess.buf = sess.buf[:0]
		reset := PluginLogEntry{Kind: "reset"}
		for sub := range sess.subs {
			select {
			case sub.ch <- reset:
			default:
				// Drop counter bookkeeping happens below for the real
				// chunk; the reset frame itself is best-effort.
			}
		}
	}
	sess.buf = append(sess.buf, entry)
	if len(sess.buf) > pluginLogBufferSize {
		sess.buf = sess.buf[len(sess.buf)-pluginLogBufferSize:]
	}
	// Fan out to live subscribers. Drop with a counter on full
	// channels (same pattern as Stream.deliver) — a stuck client
	// shouldn't block other subscribers.
	for sub := range sess.subs {
		select {
		case sub.ch <- entry:
		default:
			sub.dropped++
			if sub.dropped == 1 || sub.dropped&(sub.dropped-1) == 0 {
				log.Printf("[plugin-log] subscriber backlog full, dropped frame: cluster=%s plugin=%s dropped_total=%d",
					clusterID, crdName, sub.dropped)
			}
		}
	}
	sess.mu.Unlock()
}

// SubscribePluginLog opens a subscription to the per-(cluster, plugin)
// log stream. Returns the current buffer snapshot for immediate replay
// + a channel that receives all subsequent entries until unsubscribe
// is called. The caller MUST call unsubscribe (typically via defer)
// on WS disconnect.
//
// If no session exists yet (worker hasn't started the reconcile or
// already evicted), returns an empty snapshot + a live channel — the
// session is created lazily so any push that arrives later still
// reaches the subscriber.
func (g *GatewayServer) SubscribePluginLog(clusterID, crdName string) ([]PluginLogEntry, <-chan PluginLogEntry, func()) {
	key := pluginLogKey(clusterID, crdName)
	g.pluginLogMu.Lock()
	sess, ok := g.pluginLogSessions[key]
	if !ok {
		sess = &pluginLogSession{
			subs:     make(map[*pluginLogSubscriber]struct{}),
			lastSeen: time.Now(),
		}
		g.pluginLogSessions[key] = sess
	}
	g.pluginLogMu.Unlock()

	sess.mu.Lock()
	snapshot := make([]PluginLogEntry, len(sess.buf))
	copy(snapshot, sess.buf)
	sub := &pluginLogSubscriber{ch: make(chan PluginLogEntry, pluginLogSubscriberBuf)}
	sess.subs[sub] = struct{}{}
	sess.mu.Unlock()

	unsubscribe := func() {
		sess.mu.Lock()
		if _, still := sess.subs[sub]; still {
			delete(sess.subs, sub)
			close(sub.ch)
		}
		sess.mu.Unlock()
	}
	return snapshot, sub.ch, unsubscribe
}

// reapPluginLogs periodically evicts idle buffers. Started by
// NewGatewayServer as a long-lived goroutine. Eviction only triggers
// when the session has no live subscribers AND has been idle longer
// than the TTL — an actively-watched session never times out.
func (g *GatewayServer) reapPluginLogs() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		g.pluginLogMu.Lock()
		for key, sess := range g.pluginLogSessions {
			sess.mu.Lock()
			idle := len(sess.subs) == 0 && now.Sub(sess.lastSeen) > pluginLogIdleTTL
			sess.mu.Unlock()
			if idle {
				delete(g.pluginLogSessions, key)
			}
		}
		g.pluginLogMu.Unlock()
	}
}
