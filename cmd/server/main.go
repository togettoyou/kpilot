package main

import (
	"log"
	"net"

	"google.golang.org/grpc"

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

	// gRPC server
	lis, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		log.Fatalf("grpc listen %s: %v", cfg.GRPCAddr, err)
	}
	grpcSrv := grpc.NewServer()
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
