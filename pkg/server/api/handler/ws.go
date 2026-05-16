package handler

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// configuredWSOrigins is the allowed Origin set for WebSocket upgrades,
// populated at boot from cfg.CORSOrigins. Lives at package scope rather
// than threading cfg through every handler constructor — WS upgraders
// are var-declared at file scope (pod.go, proxy.go) and we want them
// to consult the same allow-list.
//
// devMode (empty list) matches the HTTP CORS middleware behavior in
// router.go: anything goes, suited for local development. Production
// MUST set CORS_ORIGINS or every browser session is exposed to cross-
// site WS hijacking.
var (
	configuredWSOrigins map[string]struct{}
	corsDevMode         = true
)

// SetCORSOrigins is called once during router setup with the parsed
// origin list from config. After init it's read-only — no locking
// needed for reads.
func SetCORSOrigins(origins []string) {
	configuredWSOrigins = make(map[string]struct{}, len(origins))
	for _, o := range origins {
		configuredWSOrigins[o] = struct{}{}
	}
	corsDevMode = len(configuredWSOrigins) == 0
}

// checkWSOrigin is the CheckOrigin callback shared across all gorilla
// WebSocket upgraders in the handler package. Same-origin (no Origin
// header) is accepted; otherwise the Origin must appear in the
// configured set. In dev mode any Origin is accepted to match the HTTP
// CORS middleware.
//
// Why this matters: gorilla's default CheckOrigin allows only same-
// origin, but the handlers were overriding to `return true` which
// opens cross-site WebSocket hijacking — any malicious page on any
// origin can open ws:// against KPilot and the browser will attach
// the kpilot_token cookie (SameSite=Lax does NOT block WS handshakes
// — those are treated as cross-site subresources).
func checkWSOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// Non-browser client (curl, native ws) or same-origin without
		// the header. Accept — the JWT cookie / Authorization header
		// is the actual access control.
		return true
	}
	if corsDevMode {
		return true
	}
	_, ok := configuredWSOrigins[origin]
	return ok
}

// wsHeartbeat tunes ping/pong intervals.
//   - pongWait: max time between pongs before the connection is considered dead.
//     The next Read on the conn will time out and return an error, unblocking the
//     handler so it can tear down.
//   - pingPeriod: how often the server sends Ping control frames. Must be less
//     than pongWait so a missed pong is followed by a retry before the deadline.
//   - writeWait: timeout for an individual WriteControl/WriteMessage; bounded so
//     a single hung send can't stall the pinger or main pump indefinitely.
const (
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
	writeWait  = 10 * time.Second
)

// wsConn wraps a *websocket.Conn to serialize concurrent writes (gorilla/
// websocket is NOT goroutine-safe for writes — pinger + main pump both write,
// so they need a shared mutex). Reads remain single-goroutine.
type wsConn struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
}

func newWSConn(conn *websocket.Conn) *wsConn {
	return &wsConn{conn: conn}
}

func (w *wsConn) WriteMessage(messageType int, data []byte) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	_ = w.conn.SetWriteDeadline(time.Now().Add(writeWait))
	return w.conn.WriteMessage(messageType, data)
}

func (w *wsConn) WriteControl(messageType int, data []byte, deadline time.Time) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	return w.conn.WriteControl(messageType, data, deadline)
}

// startHeartbeat installs a pong handler that refreshes the read deadline and
// kicks off a goroutine that sends Ping frames every pingPeriod. The goroutine
// stops when ctx is cancelled (caller cancels on handler return) or when a
// write fails (peer gone).
func (w *wsConn) startHeartbeat(ctx context.Context) {
	_ = w.conn.SetReadDeadline(time.Now().Add(pongWait))
	w.conn.SetPongHandler(func(string) error {
		_ = w.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := w.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait)); err != nil {
					return
				}
			}
		}
	}()
}
