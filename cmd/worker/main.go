package main

import (
	"context"
	"log"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/go-logr/logr"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	ctrl "sigs.k8s.io/controller-runtime"
	ctrlcfg "sigs.k8s.io/controller-runtime/pkg/client/config"

	kpilotv1alpha1 "github.com/togettoyou/kpilot/pkg/worker/apis/v1alpha1"
	"github.com/togettoyou/kpilot/pkg/worker/config"
	"github.com/togettoyou/kpilot/pkg/worker/plugin"
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
	resolvedDataDir, _ := filepath.Abs(cfg.DataDir)
	log.Printf("[worker] starting: server=%s data_dir=%s", cfg.ServerAddr, resolvedDataDir)

	tunnelClient := tunnel.NewClient(cfg.ServerAddr, cfg.ClusterToken, cfg.ClusterDomain)

	// Set up controller-runtime Manager. Skipped gracefully when no
	// kubeconfig is available (e.g. local dev without a cluster).
	k8sCfg, err := ctrlcfg.GetConfig()
	if err != nil {
		log.Printf("[worker] no kubeconfig available, node + plugin features disabled: %v", err)
	} else {
		scheme := runtime.NewScheme()
		if err := clientgoscheme.AddToScheme(scheme); err != nil {
			log.Fatalf("[worker] failed to add k8s scheme: %v", err)
		}
		if err := kpilotv1alpha1.AddToScheme(scheme); err != nil {
			log.Fatalf("[worker] failed to add plugin scheme: %v", err)
		}
		if err := plugin.EnsurePluginCRD(ctx, k8sCfg); err != nil {
			log.Fatalf("[worker] failed to install plugin CRD: %v", err)
		}

		mgr, err := ctrl.NewManager(k8sCfg, ctrl.Options{
			Scheme:                 scheme,
			Metrics:                metricsserver.Options{BindAddress: "0"},
			HealthProbeBindAddress: "0",
		})
		if err != nil {
			log.Fatalf("[worker] failed to create manager: %v", err)
		}

		clientset, err := kubernetes.NewForConfig(k8sCfg)
		if err != nil {
			log.Fatalf("[worker] failed to create clientset: %v", err)
		}

		// Resource proxy — owns K8s API call dispatch.
		p, err := proxy.New(k8sCfg, mgr.GetRESTMapper())
		if err != nil {
			log.Fatalf("[worker] failed to create proxy: %v", err)
		}

		// Shared routing cache between HTTP + WS proxies.
		router := proxy.NewInClusterRouter()

		// HTTP reverse proxy.
		httpProxy := proxy.NewHTTPProxy(k8sCfg, router)

		// WebSocket reverse proxy.
		wsMgr := proxy.NewWSManager(k8sCfg, router)

		// Pod logs / exec managers (no per-session registry in v2 —
		// each yamux stream is the session).
		logsMgr := proxy.NewLogsManager(clientset)
		execMgr := proxy.NewExecManager(k8sCfg, clientset)

		// Plugin pipeline.
		chartCache, err := plugin.NewChartCache(cfg.ChartCacheDir())
		if err != nil {
			log.Fatalf("[worker] chart cache init: %v", err)
		}
		statusPusher := plugin.NewPusherAdapter(tunnelClient)
		pluginMgr := plugin.NewManager(mgr.GetClient(), chartCache, statusPusher)
		reconciler := &plugin.Reconciler{
			Client: mgr.GetClient(),
			Helm:   plugin.NewHelmRunner(k8sCfg, cfg.DataDir),
			Cache:  chartCache,
			Push:   statusPusher,
			Scheme: scheme,
		}
		if err := reconciler.SetupWithManager(mgr); err != nil {
			log.Fatalf("[worker] plugin reconciler setup: %v", err)
		}

		// Wire the tunnel-dispatch table. Each handler is invoked
		// from the tunnel.Client accept goroutine, in its own
		// per-stream goroutine.
		tunnelClient.SetHandlers(tunnel.Handlers{
			OnResource: p.HandleStream,
			OnHTTP:     httpProxy.HandleStream,
			OnPlugin:   plugin.HandleStream(pluginMgr, chartCache),
			OnPodLogs:  logsMgr.HandleStream,
			OnPodExec:  execMgr.HandleStream,
			OnWSProxy:  wsMgr.HandleStream,
		})

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

