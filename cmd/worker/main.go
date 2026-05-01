package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/togettoyou/kpilot/pkg/worker/config"
	"github.com/togettoyou/kpilot/pkg/worker/tunnel"
)

func main() {
	cfg := config.Load()

	if cfg.ClusterToken == "" {
		log.Fatal("CLUSTER_TOKEN is required")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Printf("worker starting, server=%s", cfg.ServerAddr)

	client := tunnel.NewClient(cfg.ServerAddr, cfg.ClusterToken)
	client.Run(ctx)

	log.Println("worker stopped")
}
