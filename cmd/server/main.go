package main

import (
	"context"
	"log"
	"net"

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
	if cfg.BootstrapLocalClusterToken != "" {
		if err := store.BootstrapLocalCluster(
			cfg.BootstrapLocalClusterName,
			cfg.BootstrapLocalClusterToken,
			"Auto-created at server bootstrap (helm bundled worker).",
		); err != nil {
			log.Fatalf("bootstrap local cluster: %v", err)
		}
	}

	gw := gateway.NewGatewayServer()

	// v2 transport (docs/transport-v2.md): plain TCP + hashicorp/yamux
	// per-conn session. Replaces the v1 bidi gRPC stream + chunked
	// framing + prioritySender stack with a SSH-style multiplexer
	// that handles per-stream flow control, fair scheduling, and
	// cancellation natively.
	//
	// Default port — YAMUX_ADDR may be set to override.
	yamuxAddr := cfg.YamuxAddr
	if yamuxAddr == "" {
		yamuxAddr = ":9090"
	}
	ylis, err := net.Listen("tcp", yamuxAddr)
	if err != nil {
		log.Fatalf("yamux listen %s: %v", yamuxAddr, err)
	}
	log.Printf("yamux listening on %s", yamuxAddr)
	go func() {
		if err := gw.AcceptYamux(context.Background(), ylis); err != nil {
			log.Fatalf("[yamux] accept loop failed: %v", err)
		}
	}()

	// HTTP server (REST API + WebSocket endpoints).
	router := api.NewRouter(cfg, gw)
	log.Printf("HTTP listening on %s", cfg.HTTPAddr)
	if err := router.Run(cfg.HTTPAddr); err != nil {
		log.Fatalf("http serve: %v", err)
	}
}
