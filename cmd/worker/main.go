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
	// Resolving DataDir to its absolute path here makes "cwd-dependent
	// .env didn't load" failures obvious in the log instead of showing
	// up later as a surprising EACCES on /var/lib/kpilot.
	resolvedDataDir, _ := filepath.Abs(cfg.DataDir)
	log.Printf("[worker] starting: server=%s data_dir=%s", cfg.ServerAddr, resolvedDataDir)

	tunnelClient := tunnel.NewClient(cfg.ServerAddr, cfg.ClusterToken, cfg.ClusterDomain)

	// Set up controller-runtime Manager. Skipped gracefully when no
	// kubeconfig is available (e.g. local dev without a cluster).
	k8sCfg, err := ctrlcfg.GetConfig()
	if err != nil {
		log.Printf("[worker] no kubeconfig available, node + plugin features disabled: %v", err)
	} else {
		// Build a scheme that includes both the standard k8s types and
		// our Plugin CRD; controller-runtime needs both registered before
		// the Manager starts so the Plugin reconciler can Watch and Get.
		// Use a fresh scheme rather than the package-global
		// clientgoscheme.Scheme so we don't leak the kpilot types into
		// any other code path that walks the default scheme.
		scheme := runtime.NewScheme()
		if err := clientgoscheme.AddToScheme(scheme); err != nil {
			log.Fatalf("[worker] failed to add k8s scheme: %v", err)
		}
		if err := kpilotv1alpha1.AddToScheme(scheme); err != nil {
			log.Fatalf("[worker] failed to add plugin scheme: %v", err)
		}

		// Install the Plugin CRD definition before the Manager Watch — we
		// don't ship a separate Worker Helm chart yet, so this is the only
		// place that registers the kind.
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

		// One typed clientset shared by Pod logs / Pod exec — building
		// one per consumer wastes connection pools on the same
		// kube-apiserver target.
		clientset, err := kubernetes.NewForConfig(k8sCfg)
		if err != nil {
			log.Fatalf("[worker] failed to create clientset: %v", err)
		}

		p, err := proxy.New(k8sCfg, mgr.GetRESTMapper(), func(requestID string, r *proxy.ResourceResponse) {
			tunnelClient.SendResourceResponse(requestID, r.Success, r.Error, r.Data)
		})
		if err != nil {
			log.Fatalf("[worker] failed to create proxy: %v", err)
		}
		tunnelClient.SetResourceHandler(p.Handle)

		// Shared in-cluster routing cache: on the first *.svc.* request
		// we try direct DNS dial; on DNS failure we fall back to the
		// K8s API server's service-proxy subresource and remember that
		// for 24h. Both the HTTP and WS reverse proxies consult the
		// same instance so they agree on the path without probing
		// independently.
		router := proxy.NewInClusterRouter()

		// Reverse-proxy HTTP forwarder (Server → in-cluster Service for
		// embedded plugin UIs like Grafana, plus VM / VictoriaLogs
		// PromQL / LogsQL queries from the monitoring / logging pages).
		httpProxy := proxy.NewHTTPProxy(
			func(requestID string, r *proxy.HTTPResponse) {
				tunnelClient.SendHTTPResponse(requestID, r.Status, r.Headers, r.Body, r.Error)
			},
			tunnelClient.StreamContext,
			k8sCfg,
			router,
		)
		tunnelClient.SetHTTPHandler(httpProxy.Handle)

		// WebSocket reverse proxy (Grafana Live, etc.) — sibling to the
		// HTTP forwarder. Owns one upstream WS conn per session. k8sCfg
		// is needed for the service-proxy WS fallback when direct dial
		// can't resolve cluster DNS (typical for local-dev workers).
		wsMgr := proxy.NewWSManager(tunnelClient, k8sCfg, router)
		tunnelClient.SetWSHandlers(wsMgr.Start, wsMgr.Frame, wsMgr.End)

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

		// ─── Plugin pipeline ────────────────────────────────────────────
		// Local Helm chart .tgz cache. CHART_CACHE_DIR should be on a PVC
		// so the cache survives Worker pod restarts.
		chartCache, err := plugin.NewChartCache(cfg.ChartCacheDir())
		if err != nil {
			log.Fatalf("[worker] chart cache init: %v", err)
		}
		statusPusher := plugin.NewPusherAdapter(tunnelClient)
		// Manager translates PluginCommand from gRPC into CRD writes;
		// it also pushes a Disabled status when handleDisable finds no
		// CRD to delete (covers Server rows stuck at Uninstalling).
		pluginMgr := plugin.NewManager(mgr.GetClient(), chartCache, statusPusher)
		tunnelClient.SetPluginHandler(func(cmd *tunnel.PluginCommand) error {
			return pluginMgr.Handle(ctx, cmd)
		})
		// Reconciler watches Plugin CRDs and drives Helm.
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
