package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"

	"github.com/go-logr/logr"
	"k8s.io/client-go/kubernetes"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	ctrl "sigs.k8s.io/controller-runtime"
	ctrlcfg "sigs.k8s.io/controller-runtime/pkg/client/config"

	"github.com/togettoyou/kpilot/pkg/worker/collector"
	"github.com/togettoyou/kpilot/pkg/worker/config"
	"github.com/togettoyou/kpilot/pkg/worker/proxy"
	"github.com/togettoyou/kpilot/pkg/worker/tunnel"
)

func main() {
	cfg := config.Load()

	if cfg.ClusterToken == "" {
		log.Fatal("CLUSTER_TOKEN is required")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	ctrl.SetLogger(logr.Discard())
	log.Printf("worker starting, server=%s", cfg.ServerAddr)

	tunnelClient := tunnel.NewClient(cfg.ServerAddr, cfg.ClusterToken)

	// Set up controller-runtime Manager for node watching.
	// Skipped gracefully when no kubeconfig is available (e.g. local dev without a cluster).
	k8sCfg, err := ctrlcfg.GetConfig()
	if err != nil {
		log.Printf("[worker] no kubeconfig available, node collection disabled: %v", err)
	} else {
		mgr, err := ctrl.NewManager(k8sCfg, ctrl.Options{
			Metrics:                metricsserver.Options{BindAddress: "0"},
			HealthProbeBindAddress: "0",
		})
		if err != nil {
			log.Fatalf("[worker] failed to create manager: %v", err)
		}

		nc, err := collector.SetupNodeReconciler(mgr, tunnelClient.PushNodes)
		if err != nil {
			log.Fatalf("[worker] failed to setup node reconciler: %v", err)
		}
		tunnelClient.SetOnConnected(nc.Sync)

		p, err := proxy.New(k8sCfg, mgr.GetRESTMapper(), tunnelClient.SendResourceResponse)
		if err != nil {
			log.Fatalf("[worker] failed to create proxy: %v", err)
		}
		tunnelClient.SetResourceHandler(p.Handle)

		// Streaming sessions (Pod logs / Exec) need a typed clientset.
		clientset, err := kubernetes.NewForConfig(k8sCfg)
		if err != nil {
			log.Fatalf("[worker] failed to create clientset: %v", err)
		}
		logsMgr := proxy.NewLogsManager(clientset, tunnelClient)
		execMgr := proxy.NewExecManager(k8sCfg, clientset, tunnelClient)
		tunnelClient.SetStreamHandlers(
			logsMgr.Start,
			logsMgr.Cancel,
			execMgr.Start,
			execMgr.Stdin,
			execMgr.Resize,
			execMgr.Cancel,
		)

		go func() {
			if err := mgr.Start(ctx); err != nil {
				log.Printf("[worker] manager error: %v", err)
			}
		}()
	}

	if err := tunnelClient.Run(ctx); err != nil {
		log.Fatalf("[tunnel] fatal: %v", err)
	}

	log.Println("worker stopped")
}
