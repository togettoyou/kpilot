package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/togettoyou/kpilot/pkg/worker/collector"
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

	// 节点采集器（无 kubeconfig 时自动跳过）
	nc := collector.NewNodeCollector(client.PushNodes)
	if nc != nil {
		go nc.Run(ctx)
	}

	client.Run(ctx)

	log.Println("worker stopped")
}
