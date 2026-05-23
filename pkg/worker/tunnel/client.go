// Package tunnel is the worker-side v2 transport client
// (docs/transport-v2.md). One TLS/TCP conn → yamux client session
// → N concurrent per-RPC streams. Worker dials the server, opens
// STREAM_REGISTER first, then accepts server-initiated streams
// (Resource / HTTP / Plugin / Pod logs / Pod exec / WS proxy) on
// its main loop. Push streams (Plugin status / Plugin install log)
// are opened on demand from the worker side.
//
// Replaces v1's bidi gRPC + prioritySender + chunked transport
// + per-RPC cancel registry / rxAccumulator. Per-RPC isolation,
// flow control, and cancellation all come from yamux natively
// — see pkg/transport/yamux.
package tunnel

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/togettoyou/kpilot/pkg/common/version"
	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	transportv2 "github.com/togettoyou/kpilot/pkg/transport/yamux"
)

// dialResult is what resolveServerAddr returns: target host:port +
// whether to wrap the dialed conn in TLS + (for TLS) the SNI/
// verification server name.
type dialResult struct {
	host    string
	useTLS  bool
	tlsName string
}

// resolveServerAddr accepts a SERVER_ADDR in bare host:port form
// (legacy plaintext default) or with an explicit URL scheme. v1
// understood grpc:// / grpcs:// / http:// / https:// — v2 keeps
// those as aliases since the user-facing meaning ("plaintext vs
// TLS") didn't change. The underlying transport is no longer
// gRPC, so the scheme names are slightly misnomers — kept for
// migration ergonomics.
func resolveServerAddr(addr string) (dialResult, error) {
	if !strings.Contains(addr, "://") {
		return dialResult{host: addr, useTLS: false}, nil
	}
	u, err := url.Parse(addr)
	if err != nil {
		return dialResult{}, fmt.Errorf("parse SERVER_ADDR %q: %w", addr, err)
	}
	if u.Host == "" {
		return dialResult{}, fmt.Errorf("SERVER_ADDR %q has no host", addr)
	}
	scheme := strings.ToLower(u.Scheme)
	host := u.Host
	useTLS := false
	defaultPort := ""
	switch scheme {
	case "grpcs", "https", "tls", "tcps":
		useTLS, defaultPort = true, "443"
	case "grpc", "http", "tcp":
		useTLS, defaultPort = false, "80"
	default:
		return dialResult{}, fmt.Errorf("SERVER_ADDR %q has unsupported scheme %q (use tcp:// tcps:// or bare host:port)", addr, u.Scheme)
	}
	if _, _, err := net.SplitHostPort(host); err != nil {
		host = net.JoinHostPort(host, defaultPort)
	}
	r := dialResult{host: host, useTLS: useTLS}
	if useTLS {
		if name, _, err := net.SplitHostPort(host); err == nil {
			r.tlsName = name
		} else {
			r.tlsName = host
		}
	}
	return r, nil
}

const (
	reconnectBaseDelay = 3 * time.Second
	reconnectMaxDelay  = 60 * time.Second
	connectTimeout     = 15 * time.Second
	registerTimeout    = 30 * time.Second
)

// ErrTokenRejected is returned when the server explicitly rejects
// the cluster token. Fatal — retrying is pointless until reconfigured.
var ErrTokenRejected = errors.New("token rejected by server")

// Handlers is the per-stream-kind callback table the worker
// registers before Run. Each handler receives a freshly accepted
// yamux stream wrapped in our codec; the handler owns the
// stream's lifecycle through Close.
//
// Stream contract:
//   - Handler MUST close the stream (defer fine) — yamux state
//     leaks until the session terminates if not.
//   - Server already wrote the StreamHeader; the stream is
//     positioned at the first business message (e.g.
//     ResourceRequest, HTTPRequestStart).
//   - For one-shot RPCs the handler reads the request frame +
//     optional body, processes, writes the response frame +
//     optional body. For bidi streams (Exec, WS) the handler
//     manages read and write loops concurrently.
//   - Cancellation: server-side stream.Close cascades as yamux
//     FIN; the next Read returns io.EOF and the next Write
//     returns an error. Handler should treat both as "abort
//     and return".
type Handlers struct {
	OnResource func(ctx context.Context, st *transportv2.Stream)
	OnHTTP     func(ctx context.Context, st *transportv2.Stream)
	OnPlugin   func(ctx context.Context, st *transportv2.Stream)
	OnPodLogs  func(ctx context.Context, st *transportv2.Stream)
	OnPodExec  func(ctx context.Context, st *transportv2.Stream)
	OnWSProxy  func(ctx context.Context, st *transportv2.Stream)
}

// Client is the worker's transport singleton. One Client maintains
// one yamux session at a time + a reconnect loop. Handlers are
// registered once before Run; push methods (PushPluginStatus,
// OpenPluginLogPush) are safe to call any time after the first
// successful register — they no-op gracefully if the session is
// currently down.
type Client struct {
	serverAddr    string
	clusterToken  string
	clusterDomain string

	// diagPort is the local 127.0.0.1 port the worker's diag mux is
	// bound on. Reported on register so the server can reverse-proxy
	// /debug/runtime + /debug/pprof through the tunnel. Atomic so
	// SetDiagPort can be called from main.go after the listener
	// binds but before Run starts.
	diagPort atomic.Uint32

	// Diagnostic counters surfaced via the diag package. Atomic so
	// collectors can read them lock-free from any goroutine.
	connectedAtNS  atomic.Int64  // unix-nano timestamp of current session start, 0 when down
	reconnectTotal atomic.Uint64 // count of successful registers since process start

	handlersMu sync.RWMutex
	handlers   Handlers

	// sess is the live yamux session, nil while disconnected
	// (between reconnect attempts) and during register handshake.
	// Atomic so PushPluginStatus / OpenPluginLogPush can probe
	// without locking the whole client.
	sess atomic.Pointer[transportv2.Session]

	// sessCtx exposes the ctx that ties the current session's
	// lifetime — fires Done when the session terminates (yamux
	// keepalive timeout, peer close, network drop, server kick).
	// Per-stream handlers derive their ctx from this so a session
	// drop unwinds all in-flight RPCs.
	sessCtxMu     sync.RWMutex
	sessCtx       context.Context
	sessCtxCancel context.CancelFunc
}

// NewClient constructs an unconnected Client. Call SetHandlers
// before Run — handlers registered after Run begins are picked
// up on the next inbound stream but races with currently-dispatching
// ones would see the old table.
func NewClient(serverAddr, clusterToken, clusterDomain string) *Client {
	return &Client{
		serverAddr:    serverAddr,
		clusterToken:  clusterToken,
		clusterDomain: clusterDomain,
	}
}

// SetHandlers replaces the per-kind handler table. Call once at
// startup before Run; per-kind nil means "stream of that kind
// is just closed (worker doesn't support this RPC)".
func (c *Client) SetHandlers(h Handlers) {
	c.handlersMu.Lock()
	c.handlers = h
	c.handlersMu.Unlock()
}

// SetDiagPort records the 127.0.0.1 port the worker's diag mux is
// listening on. Reported on the next (re)register handshake. Must be
// called before Run, otherwise the first register will report 0
// (server falls back to "diag unavailable").
func (c *Client) SetDiagPort(port uint32) {
	c.diagPort.Store(port)
}

// DiagStats reports the tunnel's current state for the worker's
// diag /snapshot endpoint. Lock-free (all values come from atomics
// or atomic-pointer chases) so a 1 Hz collector loop does not
// contend with the connect / accept hot paths.
type DiagStats struct {
	Connected       bool    `json:"connected"`
	SessionUptimeS  float64 `json:"session_uptime_seconds"`
	ReconnectTotal  uint64  `json:"reconnect_total"`
	StreamsOpen     int     `json:"streams_open"`
	ServerAddr      string  `json:"server_addr"`
}

func (c *Client) DiagStats() DiagStats {
	s := c.sess.Load()
	stats := DiagStats{
		ReconnectTotal: c.reconnectTotal.Load(),
		ServerAddr:     c.serverAddr,
	}
	if s != nil {
		stats.Connected = true
		stats.StreamsOpen = s.NumStreams()
	}
	if ns := c.connectedAtNS.Load(); ns > 0 {
		stats.SessionUptimeS = float64(time.Now().UnixNano()-ns) / 1e9
	}
	return stats
}

// SessionContext returns a context that fires Done when the
// current yamux session terminates. While disconnected (no
// session up), returns a pre-cancelled ctx. Handler code that
// outlives a single stream (e.g. log poller spawned inside a
// plugin install) should derive its ctx from this so a session
// drop unwinds it.
func (c *Client) SessionContext() context.Context {
	c.sessCtxMu.RLock()
	defer c.sessCtxMu.RUnlock()
	if c.sessCtx == nil {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		return ctx
	}
	return c.sessCtx
}

// Run dials the server, registers, accepts streams, reconnects
// on session drop. Blocks until ctx is cancelled or token is
// rejected.
func (c *Client) Run(ctx context.Context) error {
	delay := reconnectBaseDelay
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := c.connectOnce(ctx); err != nil {
			if errors.Is(err, ErrTokenRejected) {
				return err
			}
			// Add ±25% jitter so N workers reconnecting after a
			// shared server restart don't perfectly align their
			// retry windows and thundering-herd the listener.
			jittered := delay + time.Duration(rand.Int63n(int64(delay/2))) - delay/4
			log.Printf("[tunnel] connection lost: %v (retry in %s)", err, jittered)
			select {
			case <-time.After(jittered):
			case <-ctx.Done():
				return ctx.Err()
			}
			if delay < reconnectMaxDelay {
				delay *= 2
				if delay > reconnectMaxDelay {
					delay = reconnectMaxDelay
				}
			}
			continue
		}
		// connectOnce returned nil = session terminated cleanly
		// (e.g. peer closed). Treat same as error: reconnect with
		// reset backoff.
		delay = reconnectBaseDelay
	}
}

// connectOnce performs one dial+register+accept-loop cycle. Returns
// when the session terminates for any reason.
func (c *Client) connectOnce(ctx context.Context) error {
	dial, err := resolveServerAddr(c.serverAddr)
	if err != nil {
		return fmt.Errorf("resolve server addr: %w", err)
	}

	dialCtx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	conn, err := dialConn(dialCtx, dial)
	if err != nil {
		return fmt.Errorf("dial %s: %w", dial.host, err)
	}

	sess, err := transportv2.NewClientSession(conn, nil)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("yamux client: %w", err)
	}

	// Register handshake.
	regCtx, regCancel := context.WithTimeout(ctx, registerTimeout)
	defer regCancel()
	if err := c.doRegister(regCtx, sess); err != nil {
		_ = sess.Close()
		_ = conn.Close()
		return err
	}
	log.Printf("[tunnel] registered with server %s", dial.host)

	// Publish session.
	sessCtx, sessCancel := context.WithCancel(ctx)
	c.sessCtxMu.Lock()
	c.sessCtx = sessCtx
	c.sessCtxCancel = sessCancel
	c.sessCtxMu.Unlock()
	c.sess.Store(sess)
	c.connectedAtNS.Store(time.Now().UnixNano())
	c.reconnectTotal.Add(1)

	// Accept loop.
	loopErr := c.acceptLoop(sessCtx, sess)

	// Tear down. Clear pointer first so push helpers stop using
	// the dying session.
	c.sess.Store(nil)
	c.connectedAtNS.Store(0)
	sessCancel()
	c.sessCtxMu.Lock()
	c.sessCtx = nil
	c.sessCtxCancel = nil
	c.sessCtxMu.Unlock()
	_ = sess.Close()
	_ = conn.Close()
	if loopErr != nil {
		return loopErr
	}
	return errors.New("session closed")
}

// dialConn performs the TCP dial + optional TLS handshake.
func dialConn(ctx context.Context, d dialResult) (net.Conn, error) {
	dialer := &net.Dialer{}
	if !d.useTLS {
		return dialer.DialContext(ctx, "tcp", d.host)
	}
	tlsCfg := &tls.Config{ServerName: d.tlsName}
	tlsDialer := &tls.Dialer{NetDialer: dialer, Config: tlsCfg}
	return tlsDialer.DialContext(ctx, "tcp", d.host)
}

// doRegister opens STREAM_REGISTER, writes RegisterRequest, reads
// RegisterAck. Returns ErrTokenRejected when the server reports
// success=false with a token-related message.
func (c *Client) doRegister(ctx context.Context, sess *transportv2.Session) error {
	st, err := sess.Open(ctx, pbv2.StreamKind_STREAM_REGISTER, "", false /*gzip*/)
	if err != nil {
		return fmt.Errorf("open register: %w", err)
	}
	defer st.Close()

	if err := st.WriteMsg(&pbv2.RegisterRequest{
		ClusterToken:  c.clusterToken,
		WorkerVersion: version.Version,
		ClusterDomain: c.clusterDomain,
		DiagPort:      c.diagPort.Load(),
	}); err != nil {
		return fmt.Errorf("write register: %w", err)
	}
	if err := st.CloseWrite(); err != nil {
		return fmt.Errorf("half-close register: %w", err)
	}
	var ack pbv2.RegisterAck
	if err := st.ReadMsg(&ack); err != nil {
		return fmt.Errorf("read ack: %w", err)
	}
	if !ack.GetSuccess() {
		msg := ack.GetMessage()
		if strings.Contains(strings.ToLower(msg), "token") ||
			strings.Contains(strings.ToLower(msg), "missing cluster_token") {
			return fmt.Errorf("%w: %s", ErrTokenRejected, msg)
		}
		return fmt.Errorf("register rejected: %s", msg)
	}
	return nil
}

// acceptLoop accepts inbound streams from the server and dispatches
// each to its per-kind handler in a goroutine. Returns when the
// session terminates.
func (c *Client) acceptLoop(ctx context.Context, sess *transportv2.Session) error {
	for {
		st, err := sess.Accept()
		if err != nil {
			if errors.Is(err, transportv2.ErrSessionClosed) {
				return nil
			}
			return fmt.Errorf("accept stream: %w", err)
		}
		go c.dispatch(ctx, st)
	}
}

// dispatch routes one accepted stream to its handler based on the
// StreamHeader's Kind.
func (c *Client) dispatch(ctx context.Context, st *transportv2.Stream) {
	c.handlersMu.RLock()
	h := c.handlers
	c.handlersMu.RUnlock()

	var fn func(context.Context, *transportv2.Stream)
	switch st.Kind() {
	case pbv2.StreamKind_STREAM_RESOURCE_REQUEST:
		fn = h.OnResource
	case pbv2.StreamKind_STREAM_HTTP_REQUEST:
		fn = h.OnHTTP
	case pbv2.StreamKind_STREAM_PLUGIN_COMMAND:
		fn = h.OnPlugin
	case pbv2.StreamKind_STREAM_POD_LOGS:
		fn = h.OnPodLogs
	case pbv2.StreamKind_STREAM_POD_EXEC:
		fn = h.OnPodExec
	case pbv2.StreamKind_STREAM_WS_PROXY:
		fn = h.OnWSProxy
	default:
		log.Printf("[tunnel] unknown stream kind: %v", st.Kind())
		_ = st.Close()
		return
	}
	if fn == nil {
		log.Printf("[tunnel] no handler for stream kind %v — closing", st.Kind())
		_ = st.Close()
		return
	}
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[tunnel] handler panic: kind=%v request=%s panic=%v",
				st.Kind(), st.RequestID(), r)
			_ = st.Close()
		}
	}()
	fn(ctx, st)
}

// PushPluginStatus opens a one-shot STREAM_PLUGIN_STATUS_PUSH
// stream, writes the status, closes. No-op + nil error when the
// session is currently down (status pushes are best-effort —
// the next reconnect will trigger a fresh observe pass anyway).
func (c *Client) PushPluginStatus(p *pbv2.PluginStatusPush) error {
	sess := c.sess.Load()
	if sess == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(c.SessionContext(), 10*time.Second)
	defer cancel()
	st, err := sess.Open(ctx, pbv2.StreamKind_STREAM_PLUGIN_STATUS_PUSH, "", false)
	if err != nil {
		return fmt.Errorf("open status push: %w", err)
	}
	defer st.Close()
	if err := st.WriteMsg(p); err != nil {
		return fmt.Errorf("write status: %w", err)
	}
	return st.CloseWrite()
}

// PushPluginLogLine opens a one-shot STREAM_PLUGIN_LOG_PUSH stream
// and writes a single PluginLogChunk, then closes.
//
// Server contract: a stream that closes WITHOUT emitting the
// sentinel (zero-payload PluginLogChunk) + PluginLogEnd pair is
// treated as "more chunks coming on a future stream" — the
// session stays open server-side, the buffer accumulates entries
// across streams. End-of-install is signalled separately by
// PushPluginLogEnd (called once by the reconciler when Helm
// install/upgrade/uninstall returns).
//
// Earlier (until 2026-05): this method also wrote sentinel +
// PluginLogEnd{Success:true}, which (1) hard-coded a lie about
// success on every line, and (2) flipped sess.closed=true on the
// server, causing the NEXT line to hit the "previous session
// ended, this is a new install" branch — wiping the buffer and
// firing a `reset` frame at every UI subscriber per log line.
//
// Per-line stream open cost: ~80 µs SYN-ACK + ~10 KB peak memory,
// streams don't overlap in practice (each closes after one chunk).
// A 200-line umbrella-chart install spends ~16 ms total opening
// streams — well within yamux's capacity. Per-crd stream
// coalescing is a future micro-optimization.
func (c *Client) PushPluginLogLine(crdName, level, message string, ts int64) error {
	sess := c.sess.Load()
	if sess == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(c.SessionContext(), 10*time.Second)
	defer cancel()
	st, err := sess.Open(ctx, pbv2.StreamKind_STREAM_PLUGIN_LOG_PUSH, "", false)
	if err != nil {
		return fmt.Errorf("open log push: %w", err)
	}
	defer st.Close()
	return st.WriteMsg(&pbv2.PluginLogChunk{
		CrdName: crdName,
		Level:   level,
		Message: message,
		Ts:      ts,
	})
}

// PushPluginLogEnd emits a terminal "install done" marker. Same
// per-frame stream open pattern as PushPluginLogLine; carries
// success + summary.
func (c *Client) PushPluginLogEnd(crdName string, success bool, summary string) error {
	sess := c.sess.Load()
	if sess == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(c.SessionContext(), 10*time.Second)
	defer cancel()
	st, err := sess.Open(ctx, pbv2.StreamKind_STREAM_PLUGIN_LOG_PUSH, "", false)
	if err != nil {
		return fmt.Errorf("open log push: %w", err)
	}
	defer st.Close()
	if err := st.WriteMsg(&pbv2.PluginLogChunk{}); err != nil {
		return err
	}
	return st.WriteMsg(&pbv2.PluginLogEnd{
		CrdName: crdName,
		Success: success,
		Summary: summary,
	})
}

