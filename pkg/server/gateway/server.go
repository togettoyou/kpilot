package gateway

import (
	"io"
	"log"
	"sync"
	"time"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

const heartbeatTimeout = 30 * time.Second

// ConnectedWorker 表示一个已连接的 Worker
type ConnectedWorker struct {
	ClusterID  string
	Stream     proto.PilotService_ConnectServer
	LastSeen   time.Time
	cancelOnce sync.Once
	done       chan struct{}
}

type GatewayServer struct {
	proto.UnimplementedPilotServiceServer

	mu        sync.RWMutex
	workers   map[string]*ConnectedWorker  // clusterID → worker
	nodeCache map[string][]*proto.NodeInfo // clusterID → nodes
}

func NewGatewayServer() *GatewayServer {
	return &GatewayServer{
		workers:   make(map[string]*ConnectedWorker),
		nodeCache: make(map[string][]*proto.NodeInfo),
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

	worker := &ConnectedWorker{
		ClusterID: cluster.ID,
		Stream:    stream,
		LastSeen:  time.Now(),
		done:      make(chan struct{}),
	}
	g.register(worker)
	defer g.unregister(cluster.ID)

	log.Printf("[gateway] worker connected: cluster=%s", cluster.ID)

	// 心跳超时检测
	timer := time.NewTicker(10 * time.Second)
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
			if time.Since(worker.LastSeen) > heartbeatTimeout {
				log.Printf("[gateway] worker heartbeat timeout: cluster=%s", cluster.ID)
				return nil
			}
		case <-stream.Context().Done():
			return stream.Context().Err()
		}
	}
}

func (g *GatewayServer) handleWorkerMessage(w *ConnectedWorker, msg *proto.WorkerMessage) {
	switch p := msg.Payload.(type) {
	case *proto.WorkerMessage_Heartbeat:
		w.LastSeen = time.Now()
		_ = p
	case *proto.WorkerMessage_NodeList:
		g.mu.Lock()
		g.nodeCache[w.ClusterID] = p.NodeList.Nodes
		g.mu.Unlock()
	case *proto.WorkerMessage_PluginStatus:
		// TODO P4: 更新插件状态
		_ = p
	case *proto.WorkerMessage_ResourceResp:
		// TODO P3: 路由响应到等待中的 HTTP 请求
		_ = p
	}
}

func (g *GatewayServer) register(w *ConnectedWorker) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.workers[w.ClusterID] = w
	_ = store.UpdateClusterStatus(w.ClusterID, store.ClusterStatusOnline)
}

func (g *GatewayServer) unregister(clusterID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.workers, clusterID)
	_ = store.UpdateClusterStatus(clusterID, store.ClusterStatusOffline)
	log.Printf("[gateway] worker disconnected: cluster=%s", clusterID)
}

func (g *GatewayServer) GetWorker(clusterID string) (*ConnectedWorker, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()
	w, ok := g.workers[clusterID]
	return w, ok
}

func (g *GatewayServer) GetNodes(clusterID string) []*proto.NodeInfo {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.nodeCache[clusterID]
}
