package tunnel

import (
	"context"
	"log"
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

type Client struct {
	serverAddr   string
	clusterToken string
}

func NewClient(serverAddr, clusterToken string) *Client {
	return &Client{
		serverAddr:   serverAddr,
		clusterToken: clusterToken,
	}
}

// Run 阻塞运行，自动断线重连
func (c *Client) Run(ctx context.Context) {
	delay := reconnectBaseDelay
	for {
		if err := c.connect(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("[tunnel] disconnected: %v, retry in %s", err, delay)
			select {
			case <-ctx.Done():
				return
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

	client := proto.NewPilotServiceClient(conn)
	stream, err := client.Connect(ctx)
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
		return nil // 不重试无效 token
	}
	log.Printf("[tunnel] registered: cluster=%s", regAck.RegisterAck.ClusterId)

	// 心跳
	go c.heartbeat(ctx, stream)

	// 接收 Server 命令（P3/P4 再实现具体处理）
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
