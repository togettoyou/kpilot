package main

import (
	"log"
	"net"

	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/keepalive"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/api"
	"github.com/togettoyou/kpilot/pkg/server/config"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

func main() {
	cfg := config.Load()

	if err := store.Init(cfg.DSN); err != nil {
		log.Fatalf("db init: %v", err)
	}
	log.Println("database connected")
	if err := store.ResetAllClustersOffline(); err != nil {
		log.Fatalf("reset cluster status: %v", err)
	}

	// gRPC server. Liveness is enforced via HTTP/2 keepalive PINGs at the
	// transport layer (not via the application-level Heartbeat message),
	// so a long data-plane burst on the stream can never starve the
	// liveness signal. MinTime gates the worker's allowed ping cadence;
	// 5s leaves headroom over the worker's 20s ping interval.
	const (
		grpcMaxMsgSize   = 64 << 20 // 64 MiB — accommodates large chart blobs assembled from chunks.
		grpcInitialWnd   = 4 << 20  // 4 MiB stream flow-control window — see worker tunnel for rationale.
		grpcInitialConn  = 4 << 20  // 4 MiB connection flow-control window.
	)
	lis, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		log.Fatalf("grpc listen %s: %v", cfg.GRPCAddr, err)
	}
	grpcSrv := grpc.NewServer(
		grpc.MaxRecvMsgSize(grpcMaxMsgSize),
		grpc.MaxSendMsgSize(grpcMaxMsgSize),
		grpc.InitialWindowSize(grpcInitialWnd),
		grpc.InitialConnWindowSize(grpcInitialConn),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             5 * time.Second,
			PermitWithoutStream: true,
		}),
		grpc.KeepaliveParams(keepalive.ServerParameters{
			// Send a PING every 20s if no other traffic; drop the
			// connection if no ACK in 10s. Mirrors the worker side.
			Time:    20 * time.Second,
			Timeout: 10 * time.Second,
		}),
	)
	gw := gateway.NewGatewayServer()
	proto.RegisterPilotServiceServer(grpcSrv, gw)
	log.Printf("gRPC listening on %s", cfg.GRPCAddr)
	go func() {
		if err := grpcSrv.Serve(lis); err != nil {
			log.Fatalf("grpc serve: %v", err)
		}
	}()

	// HTTP server
	router := api.NewRouter(cfg, gw)
	log.Printf("HTTP listening on %s", cfg.HTTPAddr)
	if err := router.Run(cfg.HTTPAddr); err != nil {
		log.Fatalf("http serve: %v", err)
	}
}
