package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"

	"go.uber.org/automaxprocs/maxprocs"

	"github.com/togettoyou/kpilot/pkg/common/version"
	"github.com/togettoyou/kpilot/pkg/diag"
	"github.com/togettoyou/kpilot/pkg/server/api"
	"github.com/togettoyou/kpilot/pkg/server/api/handler"
	"github.com/togettoyou/kpilot/pkg/server/config"
	serverdiag "github.com/togettoyou/kpilot/pkg/server/diag"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"

	kplog "github.com/togettoyou/kpilot/pkg/log"
)

var mainLog = kplog.L("server")

func main() {
	// In a container with a CPU limit (cgroup quota), runtime.NumCPU()
	// returns the HOST's CPU count, not the container's allowance.
	// GOMAXPROCS defaults to NumCPU, so the scheduler over-parallelises
	// and ends up throttled by the kernel — and our `/system/monitor`
	// CPU% reports denominator = wall × host-CPUs instead of × the
	// effective container CPUs, making the value useless on a bounded
	// pod. Setting GOMAXPROCS to the cgroup limit at startup fixes
	// both. On non-container hosts (macOS dev, bare-metal) maxprocs
	// detects no cgroup and leaves GOMAXPROCS at NumCPU.
	_, _ = maxprocs.Set(maxprocs.Logger(func(format string, args ...any) {
		mainLog.Infof(format, args...)
	}))

	cfg := config.Load()

	if err := store.Init(cfg.DSN); err != nil {
		mainLog.Fatalf("db init: %v", err)
	}
	mainLog.Info("database connected")
	if err := store.ResetAllClustersOffline(); err != nil {
		mainLog.Fatalf("reset cluster status: %v", err)
	}
	if cfg.BootstrapLocalClusterToken != "" {
		if err := store.BootstrapLocalCluster(
			cfg.BootstrapLocalClusterName,
			cfg.BootstrapLocalClusterToken,
			"Auto-created at server bootstrap (helm bundled worker).",
		); err != nil {
			mainLog.Fatalf("bootstrap local cluster: %v", err)
		}
	}

	gw := gateway.NewGatewayServer()

	// Self-monitoring (pkg/diag + server-specific collectors). Same
	// pattern as the worker: bind a 127.0.0.1-only HTTP mux carrying
	// runtime/metrics + pprof. The handler/system endpoint reverse-
	// proxies to it (so the auth boundary is the main HTTP server's
	// JWT middleware, not the diag mux itself).
	ctx, stop := context.WithCancel(context.Background())
	defer stop()

	diagInst := diag.New("server", "control-plane", version.Version)
	httpCollector := serverdiag.NewHTTPCollector()
	httpCollector.RotateLoop(ctx)
	diagInst.Register(serverdiag.YamuxCollector{Gateway: gw})
	diagInst.Register(serverdiag.DBCollector{})
	diagInst.Register(httpCollector)
	diagInst.Register(serverdiag.InferenceCollector{})
	diagInst.Register(serverdiag.CachesCollector{
		PluginResolve:  handler.PluginResolveCacheSize,
		ProxySemaphore: handler.ProxySemaphoreCount,
		VMResponse:     handler.VMResponseCacheSize,
	})

	diagPort, err := serveDiag(ctx, diagInst)
	if err != nil {
		mainLog.Fatalf("serve: %v", err)
	}
	// Hand the diag port to the handler package so /api/v1/system/server/*
	// knows where to reverse-proxy. Worker diag ports come from the
	// gateway's ConnectedWorker.DiagPort field.
	api.SetServerDiagPort(diagPort)

	// Diag poller — the SINGLE writer to system_snapshots. Polls the
	// server and every registered cluster's worker every 15 s, INSERTs
	// the snapshot, and runs a TTL janitor that trims rows older than
	// ~1 h. Handlers in pkg/server/api/handler/system.go are pure
	// readers against the table — strict R/W split keeps the dashboard
	// cheap and survives server restarts (history is in PG).
	pollerInst := serverdiag.NewPoller(gw, diagPort)
	pollerInst.Start(ctx)

	// Logs poller — sister of the snapshot poller, but for log lines.
	// Pulls /debug/logs from every node every 5 s, batch-INSERTs into
	// system_logs, TTL-trims > 25 h. 5 s cadence is tighter than the
	// 15 s snapshot cadence because logs are bursty: at 15 s we'd
	// routinely drop hundreds of lines off the ring buffer under load.
	logsPollerInst := serverdiag.NewLogsPoller(gw, diagPort)
	logsPollerInst.Start(ctx)

	// Transport v2 (docs/transport-v2.md): TCP + hashicorp/yamux
	// session-per-worker. One yamux stream per RPC / streaming
	// session — flow control, fair scheduling, and cancellation all
	// come from yamux natively.
	ylis, err := net.Listen("tcp", cfg.YamuxAddr)
	if err != nil {
		mainLog.Fatalf("yamux listen %s: %v", cfg.YamuxAddr, err)
	}
	mainLog.Infof("yamux listening on %s", cfg.YamuxAddr)
	go func() {
		if err := gw.AcceptYamux(ctx, ylis); err != nil {
			mainLog.Fatalf("accept loop failed: %v", err)
		}
	}()

	// HTTP server (REST API + WebSocket endpoints).
	router := api.NewRouter(cfg, gw, httpCollector)
	mainLog.Infof("HTTP listening on %s", cfg.HTTPAddr)
	if err := router.Run(cfg.HTTPAddr); err != nil {
		mainLog.Fatalf("http serve: %v", err)
	}
}

// serveDiag binds the server's diag mux on 127.0.0.1:0 (loopback,
// OS-assigned port) and returns the chosen port. Mirrors
// pkg/worker/diag/serve.go — kept inline here to avoid pulling the
// worker subtree into the server binary just for one helper.
func serveDiag(ctx context.Context, d *diag.Diag) (uint32, error) {
	mux := http.NewServeMux()
	d.Mount(mux, "/debug")
	// In-process log ring buffer (pkg/log). The LogsPoller pulls this
	// every 5 s and persists to PG system_logs alongside snapshots.
	mux.Handle("/debug/logs", kplog.LogsHandler())

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := uint32(ln.Addr().(*net.TCPAddr).Port)
	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		mainLog.Infof("listening on 127.0.0.1:%d", port)
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			mainLog.Warnf("serve error: %v", err)
		}
	}()
	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	}()
	return port, nil
}
