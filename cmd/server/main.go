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

	// Transport v2 (docs/transport-v2.md): TCP + hashicorp/yamux
	// session-per-worker. One yamux stream per RPC / streaming
	// session — flow control, fair scheduling, and cancellation all
	// come from yamux natively.
	ylis, err := net.Listen("tcp", cfg.YamuxAddr)
	if err != nil {
		log.Fatalf("yamux listen %s: %v", cfg.YamuxAddr, err)
	}
	log.Printf("yamux listening on %s", cfg.YamuxAddr)
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
