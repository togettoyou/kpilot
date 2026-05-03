package tunnel

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

const (
	reconnectBaseDelay = 3 * time.Second
	reconnectMaxDelay  = 60 * time.Second
	heartbeatInterval  = 10 * time.Second
	connectTimeout     = 15 * time.Second
	workerVersion      = "v0.1.0"

	// gRPC client message-size cap. Must mirror the Server's 32 MB ceiling
	// so Worker can receive plugin chart blobs (up to 16 MB) and large
	// Table API responses without ResourceExhausted. Default is 4 MB.
	maxGRPCMessageSize = 32 * 1024 * 1024
)

// ErrTokenRejected is returned when the server explicitly rejects the cluster
// token. This is a fatal condition — retrying is pointless until the token is
// reconfigured, so the worker should exit.
var ErrTokenRejected = errors.New("token rejected by server")

type Client struct {
	serverAddr      string
	clusterToken    string
	onConnected     func(context.Context) // called in a goroutine after each successful registration
	resourceHandler func(requestID string, req *proto.ResourceRequest)

	// pluginHandler is invoked (in a new goroutine) when the Server pushes
	// a PluginCommand. The handler is expected to translate it into CRD
	// operations on the local cluster; reconciliation happens via the
	// controller-runtime watch loop, not here.
	pluginHandler func(cmd *proto.PluginCommand) error

	// Streaming session handlers — invoked when the corresponding ServerMessage
	// payload arrives. The handler is responsible for spawning its own
	// goroutine for long-lived sessions; this dispatcher only routes.
	logsStartHandler  func(sessionID string, req *proto.LogsStartRequest)
	logsCancelHandler func(sessionID string)
	execStartHandler  func(sessionID string, req *proto.ExecStartRequest)
	execStdinHandler  func(sessionID string, data []byte)
	execResizeHandler func(sessionID string, cols, rows uint32)
	execCancelHandler func(sessionID string)

	mu     sync.Mutex
	sendMu sync.Mutex // serializes concurrent Send calls on the active stream
	stream proto.PilotService_ConnectClient
}

func NewClient(serverAddr, clusterToken string) *Client {
	return &Client{
		serverAddr:   serverAddr,
		clusterToken: clusterToken,
	}
}

// SetOnConnected registers a callback invoked (in a new goroutine) each time
// the Worker successfully registers with the Server.
func (c *Client) SetOnConnected(fn func(context.Context)) {
	c.onConnected = fn
}

// SetResourceHandler registers a callback invoked (in a new goroutine) when
// the Server sends a ResourceRequest. Used by the P3 proxy layer.
func (c *Client) SetResourceHandler(fn func(requestID string, req *proto.ResourceRequest)) {
	c.resourceHandler = fn
}

// SetPluginHandler registers a callback invoked (in a new goroutine) when
// the Server sends a PluginCommand. Errors returned from the handler are
// logged but not propagated — the reconciler reports per-release outcomes
// via PluginStatusPush, which is the canonical channel for status.
func (c *Client) SetPluginHandler(fn func(cmd *proto.PluginCommand) error) {
	c.pluginHandler = fn
}

// PushPluginStatus emits a PluginStatusPush message back to the Server
// from the reconciler. Safe to call from any goroutine — the underlying
// stream Send is serialized via sendMu.
func (c *Client) PushPluginStatus(crdName string, st *proto.PluginStatusPush) {
	c.mu.Lock()
	s := c.stream
	c.mu.Unlock()
	if s == nil {
		return
	}
	st.CrdName = crdName
	_ = c.safeSend(s, &proto.WorkerMessage{
		Payload: &proto.WorkerMessage_PluginStatus{PluginStatus: st},
	})
}

// SetStreamHandlers registers callbacks for streaming sessions (Pod logs and
// Exec). Start handlers are invoked in a new goroutine — they own the
// session's lifetime and must consume their own follow-up frames (stdin,
// resize, cancel) by storing the sessionID and reading from a shared map.
// Stdin/resize/cancel handlers run on the dispatcher goroutine and should
// only forward the data to the owning session quickly.
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
	c.mu.Lock()
	s := c.stream
	c.mu.Unlock()
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
	return c.safeSend(s, msg)
}

// safeSend serializes concurrent Send calls; gRPC streams are not thread-safe for Send.
func (c *Client) safeSend(s proto.PilotService_ConnectClient, msg *proto.WorkerMessage) error {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	return s.Send(msg)
}

// SendResourceResponse sends a ResourceResponse back to the Server after
// the proxy has finished executing a K8s operation.
func (c *Client) SendResourceResponse(requestID string, resp *proto.ResourceResponse) {
	c.mu.Lock()
	s := c.stream
	c.mu.Unlock()
	if s == nil {
		return
	}
	_ = c.safeSend(s, &proto.WorkerMessage{
		RequestId: requestID,
		Payload: &proto.WorkerMessage_ResourceResp{
			ResourceResp: resp,
		},
	})
}

// PushNodes is called by the collector to push node info on the active stream.
func (c *Client) PushNodes(nodes []*proto.NodeInfo) {
	c.mu.Lock()
	s := c.stream
	c.mu.Unlock()
	if s == nil {
		return
	}
	_ = c.safeSend(s, &proto.WorkerMessage{
		Payload: &proto.WorkerMessage_NodeList{
			NodeList: &proto.NodeListPush{Nodes: nodes},
		},
	})
}

// Run blocks and reconnects automatically. Returns ErrTokenRejected on fatal
// token rejection; callers should exit the process.
func (c *Client) Run(ctx context.Context) error {
	delay := reconnectBaseDelay
	for {
		if err := c.connect(ctx); err != nil {
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
		} else {
			delay = reconnectBaseDelay
		}
	}
}

func (c *Client) connect(ctx context.Context) error {
	conn, err := grpc.NewClient(c.serverAddr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                20 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: true,
		}),
		grpc.WithConnectParams(grpc.ConnectParams{
			MinConnectTimeout: connectTimeout,
		}),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(maxGRPCMessageSize),
			grpc.MaxCallSendMsgSize(maxGRPCMessageSize),
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

	// 发送 Register
	if err = c.safeSend(stream, &proto.WorkerMessage{
		Payload: &proto.WorkerMessage_Register{
			Register: &proto.RegisterRequest{
				ClusterToken:  c.clusterToken,
				WorkerVersion: workerVersion,
			},
		},
	}); err != nil {
		return err
	}

	// 等待 RegisterAck
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

	c.mu.Lock()
	c.stream = stream
	c.mu.Unlock()

	if c.onConnected != nil {
		go c.onConnected(ctx)
	}
	defer func() {
		c.mu.Lock()
		c.stream = nil
		c.mu.Unlock()
	}()

	go c.heartbeat(ctx, stream)

	for {
		msg, err := stream.Recv()
		if err != nil {
			return err
		}
		c.handleServerMessage(msg)
	}
}

func (c *Client) heartbeat(ctx context.Context, stream proto.PilotService_ConnectClient) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := c.safeSend(stream, &proto.WorkerMessage{
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
	case *proto.ServerMessage_ResourceReq:
		if c.resourceHandler != nil {
			go c.resourceHandler(msg.RequestId, p.ResourceReq)
		}
	case *proto.ServerMessage_PluginCmd:
		if c.pluginHandler != nil {
			go func(cmd *proto.PluginCommand) {
				if err := c.pluginHandler(cmd); err != nil {
					log.Printf("[tunnel] plugin handler: action=%s name=%s err=%v",
						cmd.Action, cmd.CrdName, err)
				}
			}(p.PluginCmd)
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
	}
}

func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
