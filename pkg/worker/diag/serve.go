package diag

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/togettoyou/kpilot/pkg/diag"

	kplog "github.com/togettoyou/kpilot/pkg/log"
)

var serveLog = kplog.L("worker-diag")

// Serve binds an HTTP server on 127.0.0.1:0 (OS-assigned port) and
// mounts d under /debug. Returns the chosen port; the caller passes
// it to tunnel.Client.SetDiagPort so the server learns where to
// reverse-proxy. The HTTP server runs in its own goroutine until
// ctx is done, then shuts down with a 2-second grace period.
//
// Bound strictly to 127.0.0.1 — the security boundary for the diag
// surface is the loopback interface, not application-layer auth.
// External access reaches it through the yamux tunnel (server-side
// JWT middleware is the auth check before the request even leaves
// the operator's browser).
func Serve(ctx context.Context, d *diag.Diag) (uint32, error) {
	mux := http.NewServeMux()
	d.Mount(mux, "/debug")

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("bind diag listener: %w", err)
	}
	port := uint32(ln.Addr().(*net.TCPAddr).Port)

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		// IdleTimeout 60s — tunnel HTTP proxy opens fresh conns per
		// snapshot pull (no keep-alive needed); CPU profile takes 30s,
		// so 60s is generous enough not to truncate one.
		IdleTimeout: 60 * time.Second,
	}

	go func() {
		serveLog.Infof("listening on 127.0.0.1:%d", port)
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveLog.Warnf("serve error: %v", err)
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
