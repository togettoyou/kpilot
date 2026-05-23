package gateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"time"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	"github.com/togettoyou/kpilot/pkg/server/store"
	transportv2 "github.com/togettoyou/kpilot/pkg/transport/yamux"
)

// AcceptYamux runs the v2 transport listener: plain TCP (TLS to
// be terminated at the ingress in production — same posture as
// the legacy grpcs:// path). Each accepted connection becomes one
// yamux session multiplexing N concurrent per-RPC streams; the
// first stream the worker opens carries the STREAM_REGISTER
// handshake. After register succeeds the session is stored on
// GatewayServer.workers[clusterID].Session and the public Send*
// methods route through Session.Open.
//
// Blocks until ctx is cancelled or the listener fails.
func (g *GatewayServer) AcceptYamux(ctx context.Context, lis net.Listener) error {
	go func() {
		<-ctx.Done()
		_ = lis.Close() // unblocks Accept below with an error
	}()
	log.Printf("[yamux] listening on %s", lis.Addr())
	for {
		conn, err := lis.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) || ctx.Err() != nil {
				return nil
			}
			log.Printf("[yamux] accept: %v", err)
			// Brief sleep prevents a hot loop on listener errors;
			// real fatal errors return through net.ErrClosed.
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go g.handleYamuxConn(ctx, conn)
	}
}

// handleYamuxConn wraps an accepted TCP conn in a yamux server
// session and waits for the worker to open its STREAM_REGISTER
// stream. Validates the cluster_token, persists the worker as
// online, then blocks until the session shuts down — when it does
// we mark the cluster offline + tear down any open per-RPC state.
//
// One goroutine per connection; spawns N more goroutines per
// inbound stream the worker opens (dispatchInboundStream).
func (g *GatewayServer) handleYamuxConn(ctx context.Context, conn net.Conn) {
	sess, err := transportv2.NewServerSession(conn, nil)
	if err != nil {
		log.Printf("[yamux] session: %v from %s", err, conn.RemoteAddr())
		_ = conn.Close()
		return
	}
	// Register handshake bounded so a silent dialer can't park a
	// goroutine forever. 30s is loose; a real worker handshakes
	// in ms.
	regCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cluster, w, err := g.acceptYamuxRegister(regCtx, sess, conn.RemoteAddr().String())
	if err != nil {
		log.Printf("[yamux] register failed from %s: %v", conn.RemoteAddr(), err)
		_ = sess.Close()
		_ = conn.Close()
		return
	}
	log.Printf("[yamux] cluster %s (%s) registered from %s", cluster.ID, cluster.Name, conn.RemoteAddr())

	if err := store.UpdateClusterStatus(cluster.ID, store.ClusterStatusOnline); err != nil {
		log.Printf("[yamux] mark online: %v", err)
	}

	// Re-push any pending plugin commands the previous session
	// couldn't deliver (e.g. worker crashed mid-Disable). Runs in a
	// goroutine so SendPluginCommand calls inside don't block the
	// accept loop — each command opens its own yamux stream.
	go g.replayPendingPluginCommands(cluster.ID)

	// Block until the session dies (worker disconnect, network drop,
	// yamux keepalive timeout, server-side Close on cluster delete).
	streamLoop := g.acceptYamuxStreams(ctx, w)
	select {
	case <-sess.CloseChan():
	case <-ctx.Done():
	case <-streamLoop:
	}
	g.unregister(w) // also flips cluster row to Offline
	_ = sess.Close()
	_ = conn.Close()
	log.Printf("[yamux] cluster %s disconnected", cluster.ID)
}

// acceptYamuxRegister waits for the worker to open its first stream
// (must be STREAM_REGISTER), reads the RegisterRequest, validates
// the cluster_token against store.GetClusterByToken, and writes
// RegisterAck. On success the ConnectedWorker is added to the
// gateway's workers map with Session set + Stream nil.
func (g *GatewayServer) acceptYamuxRegister(ctx context.Context, sess *transportv2.Session, remote string) (*store.Cluster, *ConnectedWorker, error) {
	type result struct {
		st  *transportv2.Stream
		err error
	}
	ch := make(chan result, 1)
	go func() {
		st, err := sess.Accept()
		ch <- result{st, err}
	}()
	var st *transportv2.Stream
	select {
	case r := <-ch:
		if r.err != nil {
			return nil, nil, fmt.Errorf("accept register stream: %w", r.err)
		}
		st = r.st
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	case <-sess.CloseChan():
		return nil, nil, transportv2.ErrSessionClosed
	}
	defer st.Close()

	if st.Kind() != pbv2.StreamKind_STREAM_REGISTER {
		return nil, nil, fmt.Errorf("first stream kind = %v, want STREAM_REGISTER", st.Kind())
	}

	var req pbv2.RegisterRequest
	if err := st.ReadMsg(&req); err != nil {
		return nil, nil, fmt.Errorf("read RegisterRequest: %w", err)
	}
	if req.GetClusterToken() == "" {
		_ = st.WriteMsg(&pbv2.RegisterAck{Success: false, Message: "missing cluster_token"})
		return nil, nil, errors.New("missing cluster_token")
	}
	cluster, err := store.GetClusterByToken(req.GetClusterToken())
	if err != nil {
		_ = st.WriteMsg(&pbv2.RegisterAck{Success: false, Message: "invalid token"})
		return nil, nil, fmt.Errorf("token lookup: %w", err)
	}

	// Reject a second concurrent connection for the same cluster —
	// matches v1 semantics. Caller will reconnect after the existing
	// session drops (heartbeat timeout or explicit Kick).
	g.mu.Lock()
	if _, occupied := g.workers[cluster.ID]; occupied {
		g.mu.Unlock()
		_ = st.WriteMsg(&pbv2.RegisterAck{Success: false, Message: "cluster already connected"})
		return nil, nil, fmt.Errorf("cluster %s already has an active session", cluster.ID)
	}
	w := &ConnectedWorker{
		ClusterID:     cluster.ID,
		ClusterDomain: req.GetClusterDomain(),
		DiagPort:      req.GetDiagPort(),
		Session:       sess,
		done:          make(chan struct{}),
	}
	w.markSeen()
	g.workers[cluster.ID] = w
	g.mu.Unlock()

	if err := st.WriteMsg(&pbv2.RegisterAck{
		Success:   true,
		ClusterId: cluster.ID,
	}); err != nil {
		// Undo the workers map entry on register-write failure.
		g.mu.Lock()
		delete(g.workers, cluster.ID)
		g.mu.Unlock()
		return nil, nil, fmt.Errorf("write RegisterAck: %w", err)
	}
	_ = st.CloseWrite()
	return cluster, w, nil
}

// acceptYamuxStreams runs the inbound-stream dispatch loop for one
// connected worker. Worker → server pushes (STREAM_PLUGIN_STATUS_PUSH,
// STREAM_PLUGIN_LOG_PUSH) are accepted here; per-RPC reply streams
// the server opened (HTTP / Resource / etc) don't come through here
// — those have their own per-call goroutine on the server side.
//
// Returns a channel that closes when the loop exits (either the
// session terminated or ctx cancelled).
func (g *GatewayServer) acceptYamuxStreams(ctx context.Context, w *ConnectedWorker) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if ctx.Err() != nil {
				return
			}
			st, err := w.Session.Accept()
			if err != nil {
				if errors.Is(err, transportv2.ErrSessionClosed) || errors.Is(err, io.EOF) {
					return
				}
				log.Printf("[yamux] accept stream cluster=%s: %v", w.ClusterID, err)
				return
			}
			go g.dispatchInboundStream(w, st)
		}
	}()
	return done
}

// dispatchInboundStream routes a worker-initiated stream to the
// right per-kind handler. Only push-style streams arrive here;
// per-RPC reply streams the server opened are handled inline by
// the Send* caller, not via this loop.
func (g *GatewayServer) dispatchInboundStream(w *ConnectedWorker, st *transportv2.Stream) {
	defer st.Close()
	switch st.Kind() {
	case pbv2.StreamKind_STREAM_PLUGIN_STATUS_PUSH:
		// One frame per stream — worker opens, writes a single
		// PluginStatusPush, closes. We read it and persist via
		// pluginservice.
		var p pbv2.PluginStatusPush
		if err := st.ReadMsg(&p); err != nil {
			log.Printf("[yamux] cluster=%s read plugin-status-push: %v", w.ClusterID, err)
			return
		}
		g.handlePluginStatus(w, &p)
	case pbv2.StreamKind_STREAM_PLUGIN_LOG_PUSH:
		// 1..N PluginLogChunk frames followed by a single
		// PluginLogEnd. Discriminator: zero-CrdName chunk
		// (impossible in real chunks) signals "next is end".
		// Simpler: keep reading chunks until first ReadMsg
		// returns a frame with Message="" + Level="" + Ts=0
		// — that's the end sentinel marker. Real chunks always
		// have a Level set.
		for {
			var chunk pbv2.PluginLogChunk
			if err := st.ReadMsg(&chunk); err != nil {
				return
			}
			if chunk.GetLevel() == "" && chunk.GetMessage() == "" && chunk.GetTs() == 0 {
				// Sentinel — next frame is PluginLogEnd.
				var end pbv2.PluginLogEnd
				if err := st.ReadMsg(&end); err != nil {
					return
				}
				g.recordPluginLogEnd(w.ClusterID, &end)
				return
			}
			g.recordPluginLog(w.ClusterID, &chunk)
		}
	default:
		log.Printf("[yamux] cluster=%s unexpected inbound stream kind: %v", w.ClusterID, st.Kind())
	}
}

