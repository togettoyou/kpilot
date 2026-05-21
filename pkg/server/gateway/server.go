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
	"google.golang.org/grpc"
	// Blank import registers the gzip codec on the global codec registry.
	// The Connect handler enables it per-stream via SetSendCompressor so
	// server→worker frames are also compressed (worker→server is handled
	// by the worker's UseCompressor call option).
	_ "google.golang.org/grpc/encoding/gzip"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/store"
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
	// Heartbeat. Kept as a debug counter only — application heartbeat
	// is NOT used for liveness judgment anymore. Liveness now flows
	// from gRPC HTTP/2 keepalive PINGs via stream.Context().Done(),
	// which can't be starved by application data on the same stream.
	lastSeenNS atomic.Int64

	cancelOnce sync.Once
	done       chan struct{}

	// sender owns the single Send-caller goroutine on this stream.
	// Producers call sender.sendSlow/sendFast; the sender drains a
	// fast lane before slow so future high-priority frames (if any)
	// never starve. Created in Connect; nil after disconnect.
	sender *prioritySender

	// rxAsm accumulates per-request_id inbound chunks (HTTPResponseStart
	// + BodyChunk* + BodyEnd, or ResourceResponseStart + chunks).
	rxAsm *rxAccumulators
}

func (w *ConnectedWorker) markSeen() { w.lastSeenNS.Store(time.Now().UnixNano()) }
func (w *ConnectedWorker) lastSeen() time.Time {
	return time.Unix(0, w.lastSeenNS.Load())
}

type GatewayServer struct {
	proto.UnimplementedPilotServiceServer

	mu      sync.RWMutex
	workers map[string]*ConnectedWorker

	// pendingMu guards the pending ResourceRequest response map.
	pendingMu sync.Mutex
	pending   map[string]chan *ResourceResponse

	// pendingHTTPMu guards request-response for the reverse-proxy
	// (Server → Worker → in-cluster Service).
	pendingHTTPMu sync.Mutex
	pendingHTTP   map[string]chan *HTTPResponse

	// streamMu guards active streaming sessions (Pod logs / Exec / WS).
	streamMu sync.Mutex
	streams  map[string]*Stream

	// pluginLogMu guards the per-(cluster, plugin) install-log buffers
	// + their subscriber sets. See plugin_log.go.
	pluginLogMu       sync.Mutex
	pluginLogSessions map[string]*pluginLogSession
}

func NewGatewayServer() *GatewayServer {
	g := &GatewayServer{
		workers:           make(map[string]*ConnectedWorker),
		pending:           make(map[string]chan *ResourceResponse),
		pendingHTTP:       make(map[string]chan *HTTPResponse),
		streams:           make(map[string]*Stream),
		pluginLogSessions: make(map[string]*pluginLogSession),
	}
	go g.reapPluginLogs()
	return g
}

func (g *GatewayServer) Connect(stream proto.PilotService_ConnectServer) error {
	// Enable gzip on server→worker frames for this stream. Worker side
	// uses grpc.UseCompressor("gzip") as a call option so its outbound
	// is already compressed; this covers the reverse direction (chart
	// blobs, large apply YAML bodies, etc.). Failure is non-fatal —
	// stream just runs uncompressed if codec isn't registered.
	if err := grpc.SetSendCompressor(stream.Context(), "gzip"); err != nil {
		log.Printf("[gateway] enable send compressor failed: err=%v", err)
	}

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
	// Same rationale as before: take-over loops on auto-reconnect when
	// two clients share a token. Heartbeat timeout used to free the
	// slot — now stream.Context().Done() (driven by gRPC keepalive)
	// does, on a similar ~30s window.
	// Build the worker + sender BEFORE publishing to g.workers, so
	// concurrent HTTP handlers never see a worker with sender=nil.
	streamCtx, streamCtxCancel := context.WithCancel(stream.Context())
	defer streamCtxCancel()
	sender := newPrioritySender()
	worker := &ConnectedWorker{
		ClusterID:     cluster.ID,
		ClusterDomain: reg.Register.ClusterDomain,
		Stream:        stream,
		done:          make(chan struct{}),
		rxAsm:         newRxAccumulators(),
		sender:        sender,
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
	if err := store.UpdateClusterStatus(cluster.ID, store.ClusterStatusOnline); err != nil {
		log.Printf("[gateway] update cluster online failed: cluster=%s err=%v", cluster.ID, err)
	}
	defer g.unregister(worker)

	// Start the sender goroutine. Producers calling sendSlow / sendFast
	// before this goroutine starts simply block in the channel send
	// until the sender drains the first frame — order is preserved.
	senderDone := make(chan error, 1)
	go func() { senderDone <- sender.run(streamCtx, stream) }()

	// RegisterAck goes via the sender like everything else, so any other
	// frames a producer queued (e.g. a fast incoming HTTP request that
	// landed before RegisterAck) come out in FIFO order.
	if err := sender.sendSlow(streamCtx, &proto.ServerMessage{
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
	// worker session may have lost.
	go g.replayPendingPluginCommands(cluster.ID)

	recvErr := make(chan error, 1)
	go func() {
		defer func() {
			// A panic in handleWorkerMessage (proto type assertion, map
			// access, etc.) would otherwise crash the entire gateway
			// process and take every other cluster's connection with it.
			// Recover into a synthetic disconnect for THIS worker only.
			if r := recover(); r != nil {
				log.Printf("[gateway] recv panic, dropping worker: cluster=%s panic=%v", worker.ClusterID, r)
				select {
				case recvErr <- fmt.Errorf("recv panic: %v", r):
				default:
				}
			}
		}()
		for {
			m, err := stream.Recv()
			if err != nil {
				recvErr <- err
				return
			}
			g.handleWorkerMessage(worker, m)
		}
	}()

	// Liveness now flows from the gRPC stream context (driven by HTTP/2
	// keepalive PINGs configured on the server). The old
	// "lastSeen > 35s" check is gone — it was prone to false positives
	// when a long data-plane response held the sendMu and starved the
	// application Heartbeat. The PING path can't be starved that way
	// because it lives at the HTTP/2 connection layer, below stream-
	// level send serialisation.
	for {
		select {
		case err := <-recvErr:
			return err
		case err := <-senderDone:
			// Sender goroutine bailed — Stream.Send returned an error
			// (peer-side close or transport issue). Surface as the
			// disconnect cause.
			if err == nil {
				err = io.EOF
			}
			return err
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
		// Kept for observability (debug snapshot exposes lastSeen),
		// no longer used for liveness — gRPC keepalive owns that.
		w.markSeen()
	case *proto.WorkerMessage_PluginStatus:
		g.handlePluginStatus(w, p.PluginStatus)
	case *proto.WorkerMessage_PluginLog:
		g.recordPluginLog(w.ClusterID, p.PluginLog)
	case *proto.WorkerMessage_PluginLogEnd:
		g.recordPluginLogEnd(w.ClusterID, p.PluginLogEnd)

	// Chunked inbound responses: HTTPResponse / ResourceResponse arrive as
	// *Start → BodyChunk* → BodyEnd. The accumulator holds per-request_id
	// state until BodyEnd; only then do we deliver to the pending channel.
	case *proto.WorkerMessage_HttpRespStart:
		w.rxAsm.open(msg.RequestId, rxKindHTTP, p.HttpRespStart)
	case *proto.WorkerMessage_ResourceRespStart:
		w.rxAsm.open(msg.RequestId, rxKindResource, p.ResourceRespStart)
	case *proto.WorkerMessage_BodyChunk:
		w.rxAsm.appendChunk(msg.RequestId, p.BodyChunk.Data)
	case *proto.WorkerMessage_BodyEnd:
		g.finalizeChunkedResponse(w, msg.RequestId, p.BodyEnd.Error)

	case *proto.WorkerMessage_LogsChunk, *proto.WorkerMessage_LogsEnd,
		*proto.WorkerMessage_ExecOutput, *proto.WorkerMessage_ExecEnd,
		*proto.WorkerMessage_WsFrameRecv, *proto.WorkerMessage_WsEndRecv:
		g.routeStreamMessage(msg)

	default:
		// Unknown oneof variant — almost certainly a Worker built from a
		// newer proto. Log so a missing handler doesn't silently swallow
		// new functionality.
		log.Printf("[gateway] unhandled worker message variant: cluster=%s payload=%T",
			w.ClusterID, msg.Payload)
	}
}

// finalizeChunkedResponse picks the assembled response out of the per-worker
// accumulator and delivers it to the pending channel registered by the
// originating SendHTTPRequest / SendResourceRequest call.
func (g *GatewayServer) finalizeChunkedResponse(w *ConnectedWorker, requestID, endErr string) {
	asm := w.rxAsm.finalize(requestID)
	if asm == nil {
		// Orphan End — caller already gave up. Silently drop.
		return
	}
	switch asm.kind {
	case rxKindHTTP:
		start := asm.start.(*proto.HTTPResponseStart)
		resp := &HTTPResponse{
			Status:  start.Status,
			Headers: start.Headers,
			Body:    asm.body,
			Error:   start.Error,
		}
		if endErr != "" && resp.Error == "" {
			// Worker hit an upstream body-read error mid-stream — surface
			// it so the caller gets a 502 rather than a truncated payload.
			resp.Error = endErr
		}
		g.pendingHTTPMu.Lock()
		ch, ok := g.pendingHTTP[requestID]
		g.pendingHTTPMu.Unlock()
		if ok {
			select {
			case ch <- resp:
			default:
			}
		}
	case rxKindResource:
		start := asm.start.(*proto.ResourceResponseStart)
		resp := &ResourceResponse{
			Success: start.Success,
			Error:   start.Error,
			Data:    asm.body,
		}
		if endErr != "" && resp.Error == "" {
			resp.Error = endErr
			resp.Success = false
		}
		g.pendingMu.Lock()
		ch, ok := g.pending[requestID]
		g.pendingMu.Unlock()
		if ok {
			select {
			case ch <- resp:
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
	s.deliver(msg)
}

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
	g.closeClusterStreams(clusterID)
	// Drop any half-assembled inbound responses so reconnect starts clean.
	if w.rxAsm != nil {
		w.rxAsm.reset()
	}
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

// SendResourceRequest sends a chunked ResourceRequest to the connected
// Worker for the given cluster and blocks until the Worker writes back
// the assembled ResourceResponse (Start + chunks + End) or ctx is
// cancelled. req.Body (apply/update/patch JSON payload) is chunked
// over the wire; nil/empty for list/get/delete.
func (g *GatewayServer) SendResourceRequest(ctx context.Context, clusterID string, req *ResourceRequest) (*ResourceResponse, error) {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return nil, fmt.Errorf("cluster %s not connected", clusterID)
	}

	requestID := uuid.New().String()
	ch := make(chan *ResourceResponse, 1)

	g.pendingMu.Lock()
	g.pending[requestID] = ch
	g.pendingMu.Unlock()
	defer func() {
		g.pendingMu.Lock()
		delete(g.pending, requestID)
		g.pendingMu.Unlock()
	}()

	start := &proto.ResourceRequestStart{
		Action:        req.Action,
		Group:         req.Group,
		Version:       req.Version,
		Kind:          req.Kind,
		Namespace:     req.Namespace,
		Name:          req.Name,
		Limit:         req.Limit,
		ContinueToken: req.ContinueToken,
		LabelSelector: req.LabelSelector,
	}
	if err := sendChunkedResourceRequest(ctx, w, requestID, start, req.Body); err != nil {
		return nil, fmt.Errorf("send to worker: %w", err)
	}

	select {
	case resp := <-ch:
		return resp, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-w.Stream.Context().Done():
		return nil, fmt.Errorf("worker disconnected: cluster=%s", clusterID)
	}
}

// MetricsSnapshot — see field comments.
type MetricsSnapshot struct {
	Workers           int            `json:"workers"`
	PerClusterStreams map[string]int `json:"perClusterStreams"`
	Pending           int            `json:"pending"`
	PendingHTTP       int            `json:"pendingHTTP"`
	Streams           int            `json:"streams"`
	PluginLogSessions int            `json:"pluginLogSessions"`
}

func (g *GatewayServer) MetricsSnapshot() MetricsSnapshot {
	snap := MetricsSnapshot{
		PerClusterStreams: make(map[string]int),
	}
	g.mu.RLock()
	snap.Workers = len(g.workers)
	g.mu.RUnlock()

	g.pendingMu.Lock()
	snap.Pending = len(g.pending)
	g.pendingMu.Unlock()

	g.pendingHTTPMu.Lock()
	snap.PendingHTTP = len(g.pendingHTTP)
	g.pendingHTTPMu.Unlock()

	g.streamMu.Lock()
	snap.Streams = len(g.streams)
	for _, s := range g.streams {
		snap.PerClusterStreams[s.clusterID]++
	}
	g.streamMu.Unlock()

	g.pluginLogMu.Lock()
	snap.PluginLogSessions = len(g.pluginLogSessions)
	g.pluginLogMu.Unlock()

	return snap
}

// SendHTTPRequest forwards an HTTP request through the Worker to an
// in-cluster Service and blocks until the Worker writes back the
// assembled HTTPResponse or ctx is cancelled. req.Body (POST/PUT)
// is chunked over the wire — each chunk's Send takes < 1 ms, so a 32
// MiB upload never starves Heartbeat on either side.
func (g *GatewayServer) SendHTTPRequest(ctx context.Context, clusterID string, req *HTTPRequest) (*HTTPResponse, error) {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return nil, fmt.Errorf("cluster %s not connected", clusterID)
	}

	requestID := uuid.New().String()
	ch := make(chan *HTTPResponse, 1)

	g.pendingHTTPMu.Lock()
	g.pendingHTTP[requestID] = ch
	g.pendingHTTPMu.Unlock()
	defer func() {
		g.pendingHTTPMu.Lock()
		delete(g.pendingHTTP, requestID)
		g.pendingHTTPMu.Unlock()
	}()

	if err := sendChunkedHTTPRequest(ctx, w, requestID, req.Method, req.URL, req.Headers, req.Body); err != nil {
		return nil, fmt.Errorf("send to worker: %w", err)
	}

	select {
	case resp := <-ch:
		return resp, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-w.Stream.Context().Done():
		return nil, fmt.Errorf("worker disconnected: cluster=%s", clusterID)
	}
}
