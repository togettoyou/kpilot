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
	workerVersion      = "v0.1.0"
)

// ErrTokenRejected is returned when the server explicitly rejects the cluster
// token. This is a fatal condition — retrying is pointless until the token is
// reconfigured, so the worker should exit.
var ErrTokenRejected = errors.New("token rejected by server")

type Client struct {
	serverAddr   string
	clusterToken string
	onConnected  func(context.Context) // called in a goroutine after each successful registration

	mu     sync.Mutex
	stream proto.PilotService_ConnectClient // 当前活跃的流，断线时为 nil
}

func NewClient(serverAddr, clusterToken string) *Client {
	return &Client{
		serverAddr:   serverAddr,
		clusterToken: clusterToken,
	}
}

// SetOnConnected registers a callback that is invoked (in a new goroutine) each
// time the Worker successfully registers with the Server. Use this to trigger an
// immediate node push after every reconnect.
func (c *Client) SetOnConnected(fn func(context.Context)) {
	c.onConnected = fn
}

// PushNodes 由 collector 调用，通过当前流上报节点信息
func (c *Client) PushNodes(nodes []*proto.NodeInfo) {
	c.mu.Lock()
	s := c.stream
	c.mu.Unlock()
	if s == nil {
		return
	}
	_ = s.Send(&proto.WorkerMessage{
		Payload: &proto.WorkerMessage_NodeList{
			NodeList: &proto.NodeListPush{Nodes: nodes},
		},
	})
}

// Run 阻塞运行，自动断线重连。若 Token 被拒绝则返回 ErrTokenRejected，调用方应退出进程。
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
	if err = stream.Send(&proto.WorkerMessage{
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
			_ = stream.Send(&proto.WorkerMessage{
				Payload: &proto.WorkerMessage_Heartbeat{
					Heartbeat: &proto.HeartbeatRequest{
						Timestamp: time.Now().Unix(),
					},
				},
			})
		}
	}
}

func (c *Client) handleServerMessage(msg *proto.ServerMessage) {
	switch msg.Payload.(type) {
	case *proto.ServerMessage_ResourceReq:
		// TODO P3
	case *proto.ServerMessage_PluginCmd:
		// TODO P4
	}
}

func min(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
