package tunnel

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	// Blank import registers the gzip codec on the global codec registry
	// (init() in the package). Required so the worker can advertise
	// `grpc-encoding: gzip` on outbound Sends and the server can decode it.
	_ "google.golang.org/grpc/encoding/gzip"
	"google.golang.org/grpc/keepalive"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/common/version"
)

// resolveServerAddr accepts a SERVER_ADDR in either bare host:port form
// (legacy, plaintext) or with an explicit URL scheme — grpcs:// / https://
// for TLS, grpc:// / http:// for plaintext — and returns a gRPC target
// plus matching transport credentials.
func resolveServerAddr(addr string) (string, credentials.TransportCredentials, error) {
	if !strings.Contains(addr, "://") {
		return addr, insecure.NewCredentials(), nil
	}
	u, err := url.Parse(addr)
	if err != nil {
		return "", nil, fmt.Errorf("parse SERVER_ADDR %q: %w", addr, err)
	}
	if u.Host == "" {
		return "", nil, fmt.Errorf("SERVER_ADDR %q has no host", addr)
	}
	scheme := strings.ToLower(u.Scheme)
	host := u.Host
	tlsEnabled := false
	defaultPort := ""
	switch scheme {
	case "grpcs", "https":
		tlsEnabled, defaultPort = true, "443"
	case "grpc", "http":
		tlsEnabled, defaultPort = false, "80"
	default:
		return "", nil, fmt.Errorf("SERVER_ADDR %q has unsupported scheme %q (use grpcs://, grpc://, or bare host:port)", addr, u.Scheme)
	}
	if _, _, err := net.SplitHostPort(host); err != nil {
		host = net.JoinHostPort(host, defaultPort)
	}
	if !tlsEnabled {
		return host, insecure.NewCredentials(), nil
	}
	serverName, _, err := net.SplitHostPort(host)
	if err != nil {
		serverName = host
	}
	return host, credentials.NewTLS(&tls.Config{ServerName: serverName}), nil
}

const (
	reconnectBaseDelay = 3 * time.Second
	reconnectMaxDelay  = 60 * time.Second
	heartbeatInterval  = 10 * time.Second
	connectTimeout     = 15 * time.Second

	// maxGRPCMessageSize caps any single gRPC message. After chunked
	// transport (see chunked.go) the largest single message is a
	// BodyChunk (256 KiB) + envelope overhead, so this ceiling is the
	// safety margin for legacy small messages and edge cases.
	maxGRPCMessageSize = 64 * 1024 * 1024

	// initialWindowSize bumps gRPC HTTP/2 stream/connection flow-control
	// windows from the 64 KiB default to 4 MiB. Each window-exhaust →
	// WINDOW_UPDATE round-trip costs one RTT; at default windows a
	// 1 MiB body chunk on a 50 ms-RTT link wastes ~50 ms × 16 ≈ 800 ms
	// in flow-control alone. 4 MiB lets a full BodyChunk slip through
	// without flow-control stalls.
	initialWindowSize     = 4 * 1024 * 1024
	initialConnWindowSize = 4 * 1024 * 1024
)

// ErrTokenRejected is returned when the server explicitly rejects the cluster
// token. Fatal — retrying is pointless until reconfigured.
var ErrTokenRejected = errors.New("token rejected by server")

type Client struct {
	serverAddr      string
	clusterToken    string
	clusterDomain   string
	resourceHandler func(requestID string, req *ResourceRequest)
	pluginHandler   func(cmd *PluginCommand) error

	// Streaming session handlers — invoked when the corresponding ServerMessage
	// payload arrives. Start handlers spawn their own goroutine; small-frame
	// handlers (stdin/resize/cancel/frame/end) must hand off quickly.
	logsStartHandler  func(sessionID string, req *proto.LogsStartRequest)
	logsCancelHandler func(sessionID string)
	execStartHandler  func(sessionID string, req *proto.ExecStartRequest)
	execStdinHandler  func(sessionID string, data []byte)
	execResizeHandler func(sessionID string, cols, rows uint32)
	execCancelHandler func(sessionID string)
	httpHandler       func(requestID string, req *HTTPRequest)
	wsStartHandler    func(sessionID string, req *proto.WSStartRequest)
	wsFrameHandler    func(sessionID string, frame *proto.WSFrame)
	wsEndHandler      func(sessionID string, end *proto.WSEnd)

	// senderMu guards `sender` swap on reconnect. The sender itself is
	// goroutine-safe via its own channel send semantics.
	senderMu sync.RWMutex
	sender   *prioritySender

	// rxAsm collects per-request_id inbound chunks (HTTPRequest /
	// ResourceRequest / PluginCommand bodies) until BodyEnd fires the
	// registered handler with the fully assembled message.
	rxAsm *rxAssemblers

	// streamCtx is bound to the *current* gRPC stream's lifetime.
	// Cancelled when connect() returns (any reason). Long-lived
	// per-session goroutines (Pod logs, exec, ws-proxy) derive their
	// own context from StreamContext() so they tear down promptly on
	// disconnect.
	streamCtxMu     sync.RWMutex
	streamCtx       context.Context
	streamCtxCancel context.CancelFunc
}

// StreamContext returns a context tied to the current gRPC stream.
// Cancelled when the worker disconnects (or before a connection is
// established).
func (c *Client) StreamContext() context.Context {
	c.streamCtxMu.RLock()
	ctx := c.streamCtx
	c.streamCtxMu.RUnlock()
	if ctx == nil {
		dead, cancel := context.WithCancel(context.Background())
		cancel()
		return dead
	}
	return ctx
}

func (c *Client) currentSender() *prioritySender {
	c.senderMu.RLock()
	s := c.sender
	c.senderMu.RUnlock()
	return s
}

func NewClient(serverAddr, clusterToken, clusterDomain string) *Client {
	return &Client{
		serverAddr:    serverAddr,
		clusterToken:  clusterToken,
		clusterDomain: clusterDomain,
		rxAsm:         newRxAssemblers(),
	}
}

// SetResourceHandler registers the callback invoked once a complete
// ResourceRequest (Start + body chunks + End) has arrived. Runs in its
// own goroutine.
func (c *Client) SetResourceHandler(fn func(requestID string, req *ResourceRequest)) {
	c.resourceHandler = fn
}

// SetHTTPHandler registers the callback invoked once a complete
// HTTPRequest has arrived. Runs in its own goroutine.
func (c *Client) SetHTTPHandler(fn func(requestID string, req *HTTPRequest)) {
	c.httpHandler = fn
}

// SendHTTPResponse splits the reverse-proxy response across
// HTTPResponseStart + BodyChunk* + BodyEnd frames. All frames go on the
// slow lane so Heartbeat is never blocked. Best-effort — silently drops
// if the tunnel is down (Server will surface "worker disconnected" to
// the caller).
func (c *Client) SendHTTPResponse(requestID string, status int32, headers []*proto.HTTPHeader, body []byte, errMsg string) {
	if err := c.sendChunkedHTTPResponse(c.StreamContext(), requestID, status, headers, body, errMsg); err != nil {
		log.Printf("[tunnel] http response send failed: request=%s err=%v", requestID, err)
	}
}

// SetWSHandlers wires up the reverse-proxy WebSocket dispatch.
func (c *Client) SetWSHandlers(
	start func(sessionID string, req *proto.WSStartRequest),
	frame func(sessionID string, frame *proto.WSFrame),
	end func(sessionID string, end *proto.WSEnd),
) {
	c.wsStartHandler = start
	c.wsFrameHandler = frame
	c.wsEndHandler = end
}

// SendWSFrame forwards a worker → server WebSocket frame for the
// reverse-proxy session.
func (c *Client) SendWSFrame(sessionID string, frame *proto.WSFrame) error {
	s := c.currentSender()
	if s == nil {
		return fmt.Errorf("not connected")
	}
	return s.sendSlow(c.StreamContext(), &proto.WorkerMessage{
		RequestId: sessionID,
		Payload:   &proto.WorkerMessage_WsFrameRecv{WsFrameRecv: frame},
	})
}

// SendWSEnd notifies the Server that the upstream WS closed.
func (c *Client) SendWSEnd(sessionID string, end *proto.WSEnd) error {
	s := c.currentSender()
	if s == nil {
		return fmt.Errorf("not connected")
	}
	return s.sendSlow(c.StreamContext(), &proto.WorkerMessage{
		RequestId: sessionID,
		Payload:   &proto.WorkerMessage_WsEndRecv{WsEndRecv: end},
	})
}

// SetPluginHandler registers the callback invoked once a complete
// PluginCommand has arrived (Start + optional chart blob + End).
func (c *Client) SetPluginHandler(fn func(cmd *PluginCommand) error) {
	c.pluginHandler = fn
}

// PushPluginStatus emits a PluginStatusPush message back to the Server.
func (c *Client) PushPluginStatus(crdName string, st *proto.PluginStatusPush) {
	s := c.currentSender()
	if s == nil {
		return
	}
	st.CrdName = crdName
	_ = s.sendSlow(c.StreamContext(), &proto.WorkerMessage{
		Payload: &proto.WorkerMessage_PluginStatus{PluginStatus: st},
	})
}

// PushPluginLog forwards one line of install / upgrade / uninstall
// progress.
func (c *Client) PushPluginLog(crdName, level, message string, ts int64) {
	s := c.currentSender()
	if s == nil {
		return
	}
	_ = s.sendSlow(c.StreamContext(), &proto.WorkerMessage{
		Payload: &proto.WorkerMessage_PluginLog{PluginLog: &proto.PluginLogChunk{
			CrdName: crdName,
			Level:   level,
			Ts:      ts,
			Message: message,
		}},
	})
}

// PushPluginLogEnd closes the log session for a plugin reconcile.
func (c *Client) PushPluginLogEnd(crdName string, success bool, summary string) {
	s := c.currentSender()
	if s == nil {
		return
	}
	_ = s.sendSlow(c.StreamContext(), &proto.WorkerMessage{
		Payload: &proto.WorkerMessage_PluginLogEnd{PluginLogEnd: &proto.PluginLogEnd{
			CrdName: crdName,
			Success: success,
			Summary: summary,
		}},
	})
}

// SetStreamHandlers registers callbacks for streaming sessions (Pod logs
// and Exec).
func (c *Client) SetStreamHandlers(
	logsStart func(sessionID string, req *proto.LogsStartRequest),
	logsCancel func(sessionID string),
	execStart func(sessionID string, req *proto.ExecStartRequest),
	execStdin func(sessionID string, data []byte),
	execResize func(sessionID string, cols, rows uint32),
	execCancel func(sessionID string),
) {
	c.logsStartHandler = logsStart
	c.logsCancelHandler = logsCancel
	c.execStartHandler = execStart
	c.execStdinHandler = execStdin
	c.execResizeHandler = execResize
	c.execCancelHandler = execCancel
}

// SendStreamMessage forwards a worker → server stream frame (LogsChunk,
// LogsEnd, ExecOutput, ExecEnd) tagged with the given session id.
func (c *Client) SendStreamMessage(sessionID string, payload any) error {
	s := c.currentSender()
	if s == nil {
		return fmt.Errorf("not connected")
	}

	msg := &proto.WorkerMessage{RequestId: sessionID}
	switch p := payload.(type) {
	case *proto.LogsChunk:
		msg.Payload = &proto.WorkerMessage_LogsChunk{LogsChunk: p}
	case *proto.LogsEnd:
		msg.Payload = &proto.WorkerMessage_LogsEnd{LogsEnd: p}
	case *proto.ExecOutput:
		msg.Payload = &proto.WorkerMessage_ExecOutput{ExecOutput: p}
	case *proto.ExecEnd:
		msg.Payload = &proto.WorkerMessage_ExecEnd{ExecEnd: p}
	default:
		return fmt.Errorf("unsupported stream payload type: %T", payload)
	}
	return s.sendSlow(c.StreamContext(), msg)
}

// SendResourceResponse sends a ResourceResponse back to the Server after
// the proxy has finished executing a K8s operation. data is the JSON
// payload (chunked over the wire).
func (c *Client) SendResourceResponse(requestID string, success bool, errMsg string, data []byte) {
	if err := c.sendChunkedResourceResponse(c.StreamContext(), requestID, success, errMsg, data); err != nil {
		log.Printf("[tunnel] resource response send failed: request=%s err=%v", requestID, err)
	}
}

// Run blocks and reconnects automatically. Returns ErrTokenRejected on fatal
// token rejection.
func (c *Client) Run(ctx context.Context) error {
	delay := reconnectBaseDelay
	for {
		// Reset backoff once Register succeeds.
		err := c.connect(ctx, func() { delay = reconnectBaseDelay })
		if err == nil {
			continue
		}
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, ErrTokenRejected) {
			return err
		}
		log.Printf("[tunnel] disconnected: %v, retry in %s", err, delay)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
		delay = min(delay*2, reconnectMaxDelay)
	}
}

func (c *Client) connect(ctx context.Context, onConnected func()) (retErr error) {
	target, transportCreds, err := resolveServerAddr(c.serverAddr)
	if err != nil {
		return err
	}
	conn, err := grpc.NewClient(target,
		grpc.WithTransportCredentials(transportCreds),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                20 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: true,
		}),
		grpc.WithConnectParams(grpc.ConnectParams{
			MinConnectTimeout: connectTimeout,
		}),
		grpc.WithInitialWindowSize(initialWindowSize),
		grpc.WithInitialConnWindowSize(initialConnWindowSize),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(maxGRPCMessageSize),
			grpc.MaxCallSendMsgSize(maxGRPCMessageSize),
			// gzip every outbound message on this stream. Body chunks are
			// 256 KiB JSON / unstructured payloads with 5–8× compressibility
			// — critical for cross-WAN deployments where the worker→server
			// upstream can run at <50 KB/s. CPU cost on the worker is
			// negligible relative to network savings.
			grpc.UseCompressor("gzip"),
		),
	)
	if err != nil {
		return err
	}
	defer conn.Close()

	grpcClient := proto.NewPilotServiceClient(conn)
	stream, err := grpcClient.Connect(ctx)
	if err != nil {
		return err
	}

	// Register goes synchronously on the raw stream before the sender
	// goroutine starts (no other goroutine is touching Send yet).
	if err = stream.Send(&proto.WorkerMessage{
		Payload: &proto.WorkerMessage_Register{
			Register: &proto.RegisterRequest{
				ClusterToken:  c.clusterToken,
				WorkerVersion: version.Version,
				ClusterDomain: c.clusterDomain,
			},
		},
	}); err != nil {
		return err
	}

	// Wait for RegisterAck before exposing the stream to anyone else.
	ack, err := stream.Recv()
	if err != nil {
		return err
	}
	regAck, ok := ack.Payload.(*proto.ServerMessage_RegisterAck)
	if !ok || !regAck.RegisterAck.Success {
		msg := "register failed"
		if ok {
			msg = regAck.RegisterAck.Message
		}
		log.Printf("[tunnel] register rejected: %s", msg)
		return fmt.Errorf("%w: %s", ErrTokenRejected, msg)
	}
	log.Printf("[tunnel] registered: cluster=%s", regAck.RegisterAck.ClusterId)
	if onConnected != nil {
		onConnected()
	}

	// streamCtx is parented to the Run() ctx so SIGTERM also tears it
	// down. Cancelling on connect() exit is the primary signal — heartbeat,
	// sender, per-session goroutines all derive from this.
	streamCtx, streamCtxCancel := context.WithCancel(ctx)
	c.streamCtxMu.Lock()
	c.streamCtx, c.streamCtxCancel = streamCtx, streamCtxCancel
	c.streamCtxMu.Unlock()

	// Spin up the prioritySender on this stream. All future Send calls go
	// through it. Sender exits when streamCtx cancels (deferred below).
	sender := newPrioritySender()
	c.senderMu.Lock()
	c.sender = sender
	c.senderMu.Unlock()
	senderErrCh := make(chan error, 1)
	go func() { senderErrCh <- sender.run(streamCtx, stream) }()

	defer func() {
		streamCtxCancel()
		c.senderMu.Lock()
		c.sender = nil
		c.senderMu.Unlock()
		c.streamCtxMu.Lock()
		c.streamCtx, c.streamCtxCancel = nil, nil
		c.streamCtxMu.Unlock()
		// Drop any half-assembled inbound requests so reconnect starts
		// from a clean slate.
		c.rxAsm.reset()
	}()

	go c.heartbeat(streamCtx)

	// Recover from handler panics so a malformed server frame can't
	// crash the entire worker process. Sets retErr (named return) so
	// the outer Run loop reconnects with backoff rather than tight-
	// looping on a deterministic panic.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[tunnel] recv panic, reconnecting: panic=%v", r)
			retErr = fmt.Errorf("recv panic: %v", r)
		}
	}()

	for {
		msg, err := stream.Recv()
		if err != nil {
			return err
		}
		c.handleServerMessage(msg)
	}
}

// heartbeat fires every heartbeatInterval, sending via the FAST lane so
// data-plane chunks never starve it. If the sender lane is closed (stream
// dying) the send returns ErrSenderClosed and the loop exits via ctx.Done.
func (c *Client) heartbeat(ctx context.Context) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s := c.currentSender()
			if s == nil {
				return
			}
			if err := s.sendFast(ctx, &proto.WorkerMessage{
				Payload: &proto.WorkerMessage_Heartbeat{
					Heartbeat: &proto.HeartbeatRequest{
						Timestamp: time.Now().Unix(),
					},
				},
			}); err != nil {
				return
			}
		}
	}
}

func (c *Client) handleServerMessage(msg *proto.ServerMessage) {
	switch p := msg.Payload.(type) {
	case *proto.ServerMessage_ResourceReqStart:
		// Open an accumulator; ResourceRequest body (if any) arrives in
		// following BodyChunk frames, BodyEnd dispatches the handler.
		c.rxAsm.open(msg.RequestId, kindResource, p.ResourceReqStart)
	case *proto.ServerMessage_PluginCmdStart:
		c.rxAsm.open(msg.RequestId, kindPlugin, p.PluginCmdStart)
	case *proto.ServerMessage_HttpReqStart:
		c.rxAsm.open(msg.RequestId, kindHTTP, p.HttpReqStart)
	case *proto.ServerMessage_BodyChunk:
		c.rxAsm.appendChunk(msg.RequestId, p.BodyChunk.Data)
	case *proto.ServerMessage_BodyEnd:
		asm := c.rxAsm.finalize(msg.RequestId, p.BodyEnd.Error)
		if asm != nil {
			c.dispatchAssembled(msg.RequestId, asm)
		}
	case *proto.ServerMessage_LogsStart:
		if c.logsStartHandler != nil {
			go c.logsStartHandler(msg.RequestId, p.LogsStart)
		}
	case *proto.ServerMessage_LogsCancel:
		if c.logsCancelHandler != nil {
			c.logsCancelHandler(msg.RequestId)
		}
	case *proto.ServerMessage_ExecStart:
		if c.execStartHandler != nil {
			go c.execStartHandler(msg.RequestId, p.ExecStart)
		}
	case *proto.ServerMessage_ExecStdin:
		if c.execStdinHandler != nil {
			c.execStdinHandler(msg.RequestId, p.ExecStdin.Data)
		}
	case *proto.ServerMessage_ExecResize:
		if c.execResizeHandler != nil {
			c.execResizeHandler(msg.RequestId, p.ExecResize.Cols, p.ExecResize.Rows)
		}
	case *proto.ServerMessage_ExecCancel:
		if c.execCancelHandler != nil {
			c.execCancelHandler(msg.RequestId)
		}
	case *proto.ServerMessage_WsStart:
		if c.wsStartHandler != nil {
			go c.wsStartHandler(msg.RequestId, p.WsStart)
		}
	case *proto.ServerMessage_WsFrameSend:
		if c.wsFrameHandler != nil {
			c.wsFrameHandler(msg.RequestId, p.WsFrameSend)
		}
	case *proto.ServerMessage_WsEndSend:
		if c.wsEndHandler != nil {
			c.wsEndHandler(msg.RequestId, p.WsEndSend)
		}
	}
}

// dispatchAssembled hands a fully-assembled chunked request to its
// registered handler. Runs each handler in a fresh goroutine so the
// recv-dispatch loop never blocks. When BodyEnd carried an error
// (asm.failed non-empty), the body is potentially incomplete — drop
// the request rather than executing it with partial data. Currently
// the server never sets BodyEnd.error, but this guards a future
// streaming-from-Reader path.
func (c *Client) dispatchAssembled(requestID string, asm *inboundAssembler) {
	if asm.failed != "" {
		log.Printf("[tunnel] dropping chunked request with body error: request=%s kind=%d err=%s",
			requestID, asm.kind, asm.failed)
		return
	}
	switch asm.kind {
	case kindHTTP:
		start := asm.start.(*proto.HTTPRequestStart)
		if c.httpHandler == nil {
			return
		}
		req := &HTTPRequest{
			Method:  start.Method,
			URL:     start.Url,
			Headers: start.Headers,
			Body:    asm.body,
		}
		go c.httpHandler(requestID, req)
	case kindResource:
		start := asm.start.(*proto.ResourceRequestStart)
		if c.resourceHandler == nil {
			return
		}
		req := &ResourceRequest{
			Action:        start.Action,
			Group:         start.Group,
			Version:       start.Version,
			Kind:          start.Kind,
			Namespace:     start.Namespace,
			Name:          start.Name,
			Body:          asm.body,
			Limit:         start.Limit,
			ContinueToken: start.ContinueToken,
		}
		go c.resourceHandler(requestID, req)
	case kindPlugin:
		start := asm.start.(*proto.PluginCommandStart)
		if c.pluginHandler == nil {
			return
		}
		cmd := &PluginCommand{
			Action:    start.Action,
			CrdName:   start.CrdName,
			Spec:      start.Spec,
			ChartBlob: asm.body,
		}
		go func() {
			if err := c.pluginHandler(cmd); err != nil {
				log.Printf("[tunnel] plugin handler: action=%s name=%s err=%v",
					cmd.Action, cmd.CrdName, err)
			}
		}()
	}
}

func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
