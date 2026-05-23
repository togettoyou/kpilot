package main

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"time"

	"github.com/togettoyou/kpilot/pkg/common/version"
	"github.com/togettoyou/kpilot/pkg/diag"
	"github.com/togettoyou/kpilot/pkg/server/api"
	"github.com/togettoyou/kpilot/pkg/server/config"
	serverdiag "github.com/togettoyou/kpilot/pkg/server/diag"
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

	diagPort, err := serveDiag(ctx, diagInst)
	if err != nil {
		log.Fatalf("[server-diag] serve: %v", err)
	}
	// Hand the diag port to the handler package so /api/v1/system/server/*
	// knows where to reverse-proxy. Worker diag ports come from the
	// gateway's ConnectedWorker.DiagPort field.
	api.SetServerDiagPort(diagPort)

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
		if err := gw.AcceptYamux(ctx, ylis); err != nil {
			log.Fatalf("[yamux] accept loop failed: %v", err)
		}
	}()

	// HTTP server (REST API + WebSocket endpoints).
	router := api.NewRouter(cfg, gw, httpCollector)
	log.Printf("HTTP listening on %s", cfg.HTTPAddr)
	if err := router.Run(cfg.HTTPAddr); err != nil {
		log.Fatalf("http serve: %v", err)
	}
}

// serveDiag binds the server's diag mux on 127.0.0.1:0 (loopback,
// OS-assigned port) and returns the chosen port. Mirrors
// pkg/worker/diag/serve.go — kept inline here to avoid pulling the
// worker subtree into the server binary just for one helper.
func serveDiag(ctx context.Context, d *diag.Diag) (uint32, error) {
	mux := http.NewServeMux()
	d.Mount(mux, "/debug")

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
		log.Printf("[server-diag] listening on 127.0.0.1:%d", port)
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("[server-diag] serve error: %v", err)
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
