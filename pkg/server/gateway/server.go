package gateway

import (
	"context"
	"fmt"
	"io"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

const (
	heartbeatTimeout       = 35 * time.Second // worker 每 10s 发一次心跳，3 次未收到即判定离线
	heartbeatCheckInterval = 10 * time.Second
)

// ConnectedWorker represents a live Worker connection.
type ConnectedWorker struct {
	ClusterID string
	// ClusterDomain is the K8s DNS suffix Worker reported on register
	// (e.g. "cluster.local"). The reverse proxy uses it to build the
	// FQDN of the in-cluster Service it forwards to.
	ClusterDomain string
	Stream        proto.PilotService_ConnectServer
	// lastSeenNS holds the unix-nano timestamp of the most recent
	// heartbeat. Read from the heartbeat-check ticker on Connect's
	// goroutine, written from the recv goroutine — atomic access is
	// required to avoid a torn read of time.Time (two-word struct).
	lastSeenNS atomic.Int64
	cancelOnce sync.Once
	done       chan struct{}
	sendMu     sync.Mutex // serializes concurrent Send calls; gRPC streams are not thread-safe for Send
}

func (w *ConnectedWorker) markSeen()    { w.lastSeenNS.Store(time.Now().UnixNano()) }
func (w *ConnectedWorker) lastSeen() time.Time {
	return time.Unix(0, w.lastSeenNS.Load())
}

type GatewayServer struct {
	proto.UnimplementedPilotServiceServer

	mu      sync.RWMutex
	workers map[string]*ConnectedWorker

	// pendingMu guards the pending request-response map used by P3.
	pendingMu sync.Mutex
	pending   map[string]chan *proto.ResourceResponse

	// pendingHTTPMu guards request-response for the reverse-proxy
	// (Server → Worker → in-cluster Service). Separate from pending
	// so a slow HTTP forward can't head-of-line a list/get on the same
	// gateway.
	pendingHTTPMu sync.Mutex
	pendingHTTP   map[string]chan *proto.HTTPResponse

	// streamMu guards active streaming sessions (Pod logs / Exec).
	// Keyed by session_id (which is sent as request_id on the wire).
	streamMu sync.Mutex
	streams  map[string]*Stream
}

func NewGatewayServer() *GatewayServer {
	return &GatewayServer{
		workers:     make(map[string]*ConnectedWorker),
		pending:     make(map[string]chan *proto.ResourceResponse),
		pendingHTTP: make(map[string]chan *proto.HTTPResponse),
		streams:     make(map[string]*Stream),
	}
}

func (g *GatewayServer) Connect(stream proto.PilotService_ConnectServer) error {
	// 第一条消息必须是 Register
	msg, err := stream.Recv()
	if err != nil {
		return err
	}
	reg, ok := msg.Payload.(*proto.WorkerMessage_Register)
	if !ok {
		return io.ErrUnexpectedEOF
	}

	cluster, err := store.GetClusterByToken(reg.Register.ClusterToken)
	if err != nil {
		_ = stream.Send(&proto.ServerMessage{
			RequestId: msg.RequestId,
			Payload: &proto.ServerMessage_RegisterAck{
				RegisterAck: &proto.RegisterAck{
					Success: false,
					Message: "invalid token",
				},
			},
		})
		return err
	}

	// Reject if another worker is already connected for this cluster.
	// Take-over (kick the old, register the new) was tried first and
	// regressed: with worker auto-reconnect, two concurrently-alive
	// workers using the same token kicked each other in a tight loop.
	// Rejection lets the incumbent keep its slot; if the incumbent is
	// actually dead, the heartbeat timeout (~35s) frees the slot and
	// the next reconnect attempt by the (legitimate) replacement wins.
	//
	// Check + claim under one Lock (not RLock-then-Lock) so two
	// simultaneous registers with the same token can't both pass an
	// "occupied=false" snapshot and have the second silently overwrite
	// the first — that would orphan the first worker's stream while
	// the gateway map still routed messages to it.
	worker := &ConnectedWorker{
		ClusterID:     cluster.ID,
		ClusterDomain: reg.Register.ClusterDomain,
		Stream:        stream,
		done:          make(chan struct{}),
	}
	worker.markSeen()
	g.mu.Lock()
	if _, occupied := g.workers[cluster.ID]; occupied {
		g.mu.Unlock()
		_ = stream.Send(&proto.ServerMessage{
			RequestId: msg.RequestId,
			Payload: &proto.ServerMessage_RegisterAck{
				RegisterAck: &proto.RegisterAck{
					Success: false,
					Message: "another worker is already connected for this cluster",
				},
			},
		})
		log.Printf("[gateway] worker rejected, slot occupied: cluster=%s", cluster.ID)
		return fmt.Errorf("cluster %s already connected", cluster.ID)
	}
	g.workers[cluster.ID] = worker
	g.mu.Unlock()
	// Cluster row → online (best-effort; a DB blip here doesn't unwind
	// the connection — the next status push or restart will fix it).
	if err := store.UpdateClusterStatus(cluster.ID, store.ClusterStatusOnline); err != nil {
		log.Printf("[gateway] update cluster online failed: cluster=%s err=%v", cluster.ID, err)
	}
	defer g.unregister(worker)

	if err = stream.Send(&proto.ServerMessage{
		RequestId: msg.RequestId,
		Payload: &proto.ServerMessage_RegisterAck{
			RegisterAck: &proto.RegisterAck{
				Success:   true,
				ClusterId: cluster.ID,
				Message:   "registered",
			},
		},
	}); err != nil {
		return err
	}

	log.Printf("[gateway] worker connected: cluster=%s", cluster.ID)

	// Reconcile-on-reconnect: replay any plugin commands the previous
	// worker session may have lost. Without this, a Disable / Enable
	// click that landed while the worker was being restarted gets
	// stranded — UI sits forever at Uninstalling / Pending while the
	// new worker has no idea the user wanted anything. Run in a
	// goroutine so a slow replay doesn't block this connection's
	// recv loop from starting.
	go g.replayPendingPluginCommands(cluster.ID)

	timer := time.NewTicker(heartbeatCheckInterval)
	defer timer.Stop()

	recvErr := make(chan error, 1)
	go func() {
		for {
			m, err := stream.Recv()
			if err != nil {
				recvErr <- err
				return
			}
			g.handleWorkerMessage(worker, m)
		}
	}()

	for {
		select {
		case err := <-recvErr:
			return err
		case <-timer.C:
			if time.Since(worker.lastSeen()) > heartbeatTimeout {
				log.Printf("[gateway] worker heartbeat timeout: cluster=%s", cluster.ID)
				return nil
			}
		case <-stream.Context().Done():
			return stream.Context().Err()
		case <-worker.done:
			log.Printf("[gateway] worker kicked: cluster=%s", cluster.ID)
			return nil
		}
	}
}

func (g *GatewayServer) handleWorkerMessage(w *ConnectedWorker, msg *proto.WorkerMessage) {
	switch p := msg.Payload.(type) {
	case *proto.WorkerMessage_Heartbeat:
		w.markSeen()
		_ = p
	case *proto.WorkerMessage_PluginStatus:
		g.handlePluginStatus(w, p.PluginStatus)
	case *proto.WorkerMessage_ResourceResp:
		resp := p.ResourceResp
		g.pendingMu.Lock()
		ch, ok := g.pending[msg.RequestId]
		g.pendingMu.Unlock()
		if ok {
			// Non-blocking send: channel is buffered size 1, so on the happy
			// path this is a no-wait. If the requester already gave up (ctx
			// cancelled before delete) the buffer might still be empty but
			// the receiver's gone — fall through silently rather than block
			// the gateway's recv loop on a duplicate or stale response.
			select {
			case ch <- resp:
			default:
			}
		}
	case *proto.WorkerMessage_LogsChunk, *proto.WorkerMessage_LogsEnd,
		*proto.WorkerMessage_ExecOutput, *proto.WorkerMessage_ExecEnd,
		*proto.WorkerMessage_WsFrameRecv, *proto.WorkerMessage_WsEndRecv:
		g.routeStreamMessage(msg)
	case *proto.WorkerMessage_HttpResp:
		g.pendingHTTPMu.Lock()
		ch, ok := g.pendingHTTP[msg.RequestId]
		g.pendingHTTPMu.Unlock()
		if ok {
			// Same non-blocking pattern as ResourceResp — buffered chan
			// of size 1, late/duplicate frames silently dropped if the
			// caller already moved on.
			select {
			case ch <- p.HttpResp:
			default:
			}
		}
	}
}

func (g *GatewayServer) routeStreamMessage(msg *proto.WorkerMessage) {
	g.streamMu.Lock()
	s, ok := g.streams[msg.RequestId]
	g.streamMu.Unlock()
	if !ok {
		// Session already closed by the WS side — silently drop late frames.
		return
	}
	// deliver internally guards against send-on-closed-channel.
	s.deliver(msg)
}

func (g *GatewayServer) unregister(w *ConnectedWorker) {
	clusterID := w.ClusterID

	// Identity check: only delete the map entry if it still points to *this*
	// worker. If a newer connection has taken over (register() above kicked
	// us), we must not blow away the new entry on our way out.
	g.mu.Lock()
	cur, ok := g.workers[clusterID]
	wasCurrent := ok && cur == w
	if wasCurrent {
		delete(g.workers, clusterID)
	}
	g.mu.Unlock()

	if !wasCurrent {
		// We were already kicked by a newer registration. The new worker
		// owns the cluster slot and its streams; don't touch them.
		log.Printf("[gateway] worker exited (already replaced): cluster=%s", clusterID)
		return
	}

	if err := store.UpdateClusterStatus(clusterID, store.ClusterStatusOffline); err != nil {
		log.Printf("[gateway] update cluster offline failed: cluster=%s err=%v", clusterID, err)
	}
	// Close any active streams (Pod logs / exec) bound to this worker so the
	// WS handlers unblock from <-stream.Recv() instead of hanging forever.
	g.closeClusterStreams(clusterID)
	log.Printf("[gateway] worker disconnected: cluster=%s", clusterID)
}

func (g *GatewayServer) closeClusterStreams(clusterID string) {
	g.streamMu.Lock()
	victims := make([]*Stream, 0)
	for _, s := range g.streams {
		if s.clusterID == clusterID {
			victims = append(victims, s)
		}
	}
	g.streamMu.Unlock()
	for _, s := range victims {
		s.Close()
	}
}

func (g *GatewayServer) KickWorker(clusterID string) {
	g.mu.RLock()
	w, ok := g.workers[clusterID]
	g.mu.RUnlock()
	if ok {
		w.cancelOnce.Do(func() { close(w.done) })
	}
}

func (g *GatewayServer) GetWorker(clusterID string) (*ConnectedWorker, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	w, ok := g.workers[clusterID]
	return w, ok
}

// SendResourceRequest sends a ResourceRequest to the connected Worker for the
// given cluster and blocks until the Worker responds or ctx is cancelled.
// This is the primary entry point for P3 workload operations.
func (g *GatewayServer) SendResourceRequest(ctx context.Context, clusterID string, req *proto.ResourceRequest) (*proto.ResourceResponse, error) {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return nil, fmt.Errorf("cluster %s not connected", clusterID)
	}

	requestID := uuid.New().String()
	ch := make(chan *proto.ResourceResponse, 1)

	g.pendingMu.Lock()
	g.pending[requestID] = ch
	g.pendingMu.Unlock()
	defer func() {
		g.pendingMu.Lock()
		delete(g.pending, requestID)
		g.pendingMu.Unlock()
	}()

	w.sendMu.Lock()
	err := w.Stream.Send(&proto.ServerMessage{
		RequestId: requestID,
		Payload: &proto.ServerMessage_ResourceReq{
			ResourceReq: req,
		},
	})
	w.sendMu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("send to worker: %w", err)
	}

	// Watch the worker's stream context too: when the worker disconnects,
	// gRPC tears the stream down and Stream.Context() is cancelled. Without
	// this case the caller would block until ctx (typically 30-60s) — long
	// after the answer is impossible.
	select {
	case resp := <-ch:
		return resp, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-w.Stream.Context().Done():
		return nil, fmt.Errorf("worker disconnected: cluster=%s", clusterID)
	}
}

// SendHTTPRequest forwards an HTTP request through the Worker to an in-
// cluster Service and blocks until the Worker writes back HTTPResponse or
// ctx is cancelled. Used by the reverse-proxy handler that embeds Grafana
// (and similar plugin UIs) inside KPilot.
func (g *GatewayServer) SendHTTPRequest(ctx context.Context, clusterID string, req *proto.HTTPRequest) (*proto.HTTPResponse, error) {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return nil, fmt.Errorf("cluster %s not connected", clusterID)
	}

	requestID := uuid.New().String()
	ch := make(chan *proto.HTTPResponse, 1)

	g.pendingHTTPMu.Lock()
	g.pendingHTTP[requestID] = ch
	g.pendingHTTPMu.Unlock()
	defer func() {
		g.pendingHTTPMu.Lock()
		delete(g.pendingHTTP, requestID)
		g.pendingHTTPMu.Unlock()
	}()

	w.sendMu.Lock()
	err := w.Stream.Send(&proto.ServerMessage{
		RequestId: requestID,
		Payload:   &proto.ServerMessage_HttpReq{HttpReq: req},
	})
	w.sendMu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("send to worker: %w", err)
	}

	// Same disconnect-unblocks-pending pattern as SendResourceRequest:
	// without watching the stream context, an iframe asset request would
	// hang the full proxyTimeout (60s) every time the worker dies.
	select {
	case resp := <-ch:
		return resp, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-w.Stream.Context().Done():
		return nil, fmt.Errorf("worker disconnected: cluster=%s", clusterID)
	}
}
