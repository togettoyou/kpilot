package main

import (
	"context"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/go-logr/logr"
	"go.uber.org/automaxprocs/maxprocs"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	ctrl "sigs.k8s.io/controller-runtime"
	ctrlcfg "sigs.k8s.io/controller-runtime/pkg/client/config"

	"github.com/togettoyou/kpilot/pkg/common/version"
	"github.com/togettoyou/kpilot/pkg/diag"
	kpilotv1alpha1 "github.com/togettoyou/kpilot/pkg/worker/apis/v1alpha1"
	"github.com/togettoyou/kpilot/pkg/worker/config"
	workerdiag "github.com/togettoyou/kpilot/pkg/worker/diag"
	"github.com/togettoyou/kpilot/pkg/worker/plugin"
	"github.com/togettoyou/kpilot/pkg/worker/proxy"
	"github.com/togettoyou/kpilot/pkg/worker/tunnel"

	kplog "github.com/togettoyou/kpilot/pkg/log"
)

var mainLog = kplog.L("worker")

func main() {
	// Match GOMAXPROCS to the cgroup CPU quota when running in a
	// container — see the matching call in cmd/server/main.go for
	// the full rationale.
	_, _ = maxprocs.Set(maxprocs.Logger(func(format string, args ...any) {
		mainLog.Infof(format, args...)
	}))

	cfg := config.Load()

	if cfg.ClusterToken == "" {
		mainLog.Fatal("CLUSTER_TOKEN is required")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	ctrl.SetLogger(logr.Discard())
	resolvedDataDir, _ := filepath.Abs(cfg.DataDir)
	mainLog.Infof("starting: server=%s data_dir=%s", cfg.ServerAddr, resolvedDataDir)

	tunnelClient := tunnel.NewClient(cfg.ServerAddr, cfg.ClusterToken, cfg.ClusterDomain)

	// Self-monitoring surface (pkg/diag + worker-specific collectors).
	// Mount runtime/metrics + pprof on a 127.0.0.1-bound listener;
	// server reverse-proxies through the tunnel when an operator
	// opens the system-monitoring UI. ClusterName is unknown at
	// startup (server assigns ClusterID via STREAM_REGISTER), so
	// identity Name carries the human-friendly server addr instead.
	diagInst := diag.New("worker", cfg.ServerAddr, version.Version)
	diagInst.Register(workerdiag.TunnelCollector{Client: tunnelClient})
	diagPort, err := workerdiag.Serve(ctx, diagInst)
	if err != nil {
		mainLog.Fatalf("diag serve: %v", err)
	}
	tunnelClient.SetDiagPort(diagPort)

	// Set up controller-runtime Manager. Skipped gracefully when no
	// kubeconfig is available (e.g. local dev without a cluster).
	k8sCfg, err := ctrlcfg.GetConfig()
	if err != nil {
		mainLog.Infof("no kubeconfig available, node + plugin features disabled: %v", err)
	} else {
		// client-go default QPS=5 burst=10 throttles every K8s API
		// call we proxy. With KPilot fronting bursty operator traffic
		// (the cluster page lists pods + deployments + nodes in
		// parallel; multiple operators do this concurrently) the
		// default is the limiter, not the apiserver. Stress test saw
		// 93.8% 503s at c=256 /workloads/pods — every request
		// queued behind the 5 QPS bucket, timed out, then bubbled
		// up to handleWorkerErr → CLUSTER_NOT_CONNECTED. Lift the
		// limits to something that lets the apiserver itself be the
		// admission control: a single k3s/kube-apiserver routinely
		// handles 100s of QPS per client.
		k8sCfg.QPS = 100
		k8sCfg.Burst = 200
		scheme := runtime.NewScheme()
		if err := clientgoscheme.AddToScheme(scheme); err != nil {
			mainLog.Fatalf("failed to add k8s scheme: %v", err)
		}
		if err := kpilotv1alpha1.AddToScheme(scheme); err != nil {
			mainLog.Fatalf("failed to add plugin scheme: %v", err)
		}
		if err := plugin.EnsurePluginCRD(ctx, k8sCfg); err != nil {
			mainLog.Fatalf("failed to install plugin CRD: %v", err)
		}

		mgr, err := ctrl.NewManager(k8sCfg, ctrl.Options{
			Scheme:                 scheme,
			Metrics:                metricsserver.Options{BindAddress: "0"},
			HealthProbeBindAddress: "0",
		})
		if err != nil {
			mainLog.Fatalf("failed to create manager: %v", err)
		}

		clientset, err := kubernetes.NewForConfig(k8sCfg)
		if err != nil {
			mainLog.Fatalf("failed to create clientset: %v", err)
		}

		// Resource proxy — owns K8s API call dispatch.
		p, err := proxy.New(k8sCfg, mgr.GetRESTMapper())
		if err != nil {
			mainLog.Fatalf("failed to create proxy: %v", err)
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
			mainLog.Fatalf("chart cache init: %v", err)
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
			mainLog.Fatalf("plugin reconciler setup: %v", err)
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

		// Register proxy + router collectors now that the managers
		// exist. Tunnel collector was registered above (it has no
		// K8s dependency).
		diagInst.Register(workerdiag.ProxyCollector{
			Resource: p, HTTP: httpProxy, Logs: logsMgr, Exec: execMgr, WS: wsMgr,
		})
		diagInst.Register(workerdiag.RouterCollector{Router: router})

		go func() {
			if err := mgr.Start(ctx); err != nil {
				mainLog.Warnf("manager error: %v", err)
			}
		}()
	}

	if err := tunnelClient.Run(ctx); err != nil {
		mainLog.Fatalf("fatal: %v", err)
	}

	mainLog.Info("worker stopped")
}

