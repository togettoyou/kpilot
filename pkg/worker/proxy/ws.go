package proxy

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// WSPusher is the subset of the tunnel.Client this manager needs. Defining it
// as an interface keeps the worker side decoupled and lets us swap a fake in
// unit tests if we add them later. StreamContext is included so per-session
// ctxes can be derived from the live tunnel — a disconnect cancels the
// upstream dial + read/write pumps instead of leaking them up to the per-
// session timeout.
type WSPusher interface {
	SendWSFrame(sessionID string, frame *proto.WSFrame) error
	SendWSEnd(sessionID string, end *proto.WSEnd) error
	StreamContext() context.Context
}

// WSManager owns active reverse-proxy WebSocket sessions on the worker side.
// Lifecycle per session:
//   1. Server sends WSStartRequest → Start(): we Dial the upstream URL.
//   2. On dial success: spin up a pump goroutine that reads from the upstream
//      and SendWSFrame's each frame back to Server.
//   3. Frames coming from Server (browser → upstream) flow through Frame().
//   4. End from either side (or transport errors) tears the session down
//      with a best-effort SendWSEnd.
type WSManager struct {
	pusher WSPusher
	dialer *websocket.Dialer

	mu       sync.Mutex
	sessions map[string]*wsSession
}

// wsSessionWriteBuf is the per-session backlog of browser-originated frames
// waiting to be written to the upstream conn. Sized big enough that a brief
// upstream stall doesn't drop frames, small enough that a permanently slow
// upstream backpressures the tunnel rather than buffering megabytes per
// session. Grafana Live frames are kilobytes — 64 is generous.
const wsSessionWriteBuf = 64

type wsSession struct {
	conn   *websocket.Conn
	cancel context.CancelFunc

	// writeCh fan-ins browser-originated frames so the tunnel dispatcher
	// (Frame()) doesn't block on conn.WriteMessage — a slow upstream would
	// otherwise stall every other session's messages on the same tunnel.
	writeCh chan *proto.WSFrame

	// closeOnce + closed serialize the teardown so a second End from the
	// dispatcher / pump / dial-failed path can't double-close conn.
	closeOnce sync.Once
}

func NewWSManager(pusher WSPusher) *WSManager {
	return &WSManager{
		pusher: pusher,
		dialer: &websocket.Dialer{
			HandshakeTimeout: 10 * time.Second,
			// Match the WSManager-side max frame; default 4 KiB read buffer
			// is fine for Grafana Live (each frame is a JSON event, kilobytes
			// max). 32 KB write buffer covers the largest frame the browser
			// might forward.
			ReadBufferSize:  4 * 1024,
			WriteBufferSize: 32 * 1024,
		},
		sessions: make(map[string]*wsSession),
	}
}

// Start opens the upstream WebSocket dial and (on success) launches the
// upstream → Server pump. On dial failure it sends a single WSEnd back to
// Server so the embedded UI knows the upgrade failed.
func (m *WSManager) Start(sessionID string, req *proto.WSStartRequest) {
	if req.Url == "" {
		_ = m.pusher.SendWSEnd(sessionID, &proto.WSEnd{Reason: "url required"})
		return
	}
	// Defense-in-depth: the only legitimate upstream schemes for a WS
	// reverse proxy are ws / wss / http / https (gorilla/websocket accepts
	// the http variants and upgrades them). Reject anything else so a
	// regression in the Server-side URL builder can't make us dial unix://
	// or file:// transports.
	if scheme, ok := schemeOf(req.Url); !ok ||
		(scheme != "ws" && scheme != "wss" && scheme != "http" && scheme != "https") {
		_ = m.pusher.SendWSEnd(sessionID, &proto.WSEnd{Reason: "unsupported url scheme"})
		return
	}

	header := http.Header{}
	for _, h := range req.Headers {
		header.Add(h.Name, h.Value)
	}
	// gorilla/websocket sets these itself based on the URL; remove if
	// Server forwarded them so the dial isn't rejected by upstream
	// strict-Origin checks.
	for _, drop := range []string{
		"Sec-Websocket-Version", "Sec-Websocket-Key",
		"Sec-Websocket-Extensions", "Connection", "Upgrade",
		"Host",
	} {
		header.Del(drop)
	}

	// Parent on the tunnel stream ctx so a tunnel disconnect cancels
	// the dial + pump goroutines immediately; otherwise they leak
	// waiting for the upstream's own timeouts.
	ctx, cancel := context.WithCancel(m.pusher.StreamContext())
	conn, dialResp, err := m.dialer.DialContext(ctx, req.Url, header)
	if err != nil {
		// gorilla/websocket reports any non-101 as the generic
		// "websocket: bad handshake" — useless for diagnosis. The
		// actual upstream response is available on dialResp; pull
		// status + a body excerpt so we can see whether the upstream
		// returned 401 (auth proxy not honored), 403 (Origin check
		// rejected — see [live] allowed_origins), 404 (wrong path),
		// or some other failure.
		extra := ""
		if dialResp != nil {
			body := readDialBodyExcerpt(dialResp.Body)
			extra = fmt.Sprintf(" status=%d body=%q", dialResp.StatusCode, body)
		}
		log.Printf("[ws-proxy] dial failed: url=%s err=%v%s", req.Url, err, extra)
		cancel()
		_ = m.pusher.SendWSEnd(sessionID, &proto.WSEnd{
			Reason: "dial: " + err.Error(),
		})
		return
	}

	sess := &wsSession{
		conn:    conn,
		cancel:  cancel,
		writeCh: make(chan *proto.WSFrame, wsSessionWriteBuf),
	}
	// Replace any pre-existing entry under the same sessionID — across
	// a reconnect the Server may replay a Start whose id collides with
	// an old session. Without this, the old goroutine's cancel is
	// orphaned and the old conn keeps draining frames into nothing.
	m.mu.Lock()
	if old, ok := m.sessions[sessionID]; ok {
		old.closeOnce.Do(func() {
			old.cancel()
			_ = old.conn.Close()
		})
	}
	m.sessions[sessionID] = sess
	m.mu.Unlock()

	// Browser → upstream writer. Pulls frames Frame() pushed onto writeCh
	// and writes them to the upstream conn. Exits when ctx is cancelled
	// (End() called). A write error tears the session down via End() so
	// the upstream-read pump's WSEnd push reaches Server.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case frame, ok := <-sess.writeCh:
				if !ok {
					return
				}
				op := int(frame.Opcode)
				if op == 0 {
					op = websocket.TextMessage
				}
				_ = sess.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := sess.conn.WriteMessage(op, frame.Data); err != nil {
					m.End(sessionID, &proto.WSEnd{
						Reason: "upstream write: " + err.Error(),
					})
					return
				}
			}
		}
	}()

	// Upstream → Server pump. Exits when the upstream sends a close, the
	// underlying transport breaks, or End() drops the session and closes
	// the conn underneath us.
	go func() {
		defer m.End(sessionID, nil)
		for {
			opcode, data, err := conn.ReadMessage()
			if err != nil {
				// CloseError carries a real RFC 6455 close code; transport
				// errors (read on closed conn / network gone) report 0 +
				// the underlying string. Either way Server hands off to
				// the browser via its own WS write, then closes.
				var ce *websocket.CloseError
				if errors.As(err, &ce) {
					_ = m.pusher.SendWSEnd(sessionID, &proto.WSEnd{
						Code:   int32(ce.Code),
						Reason: ce.Text,
					})
				} else {
					_ = m.pusher.SendWSEnd(sessionID, &proto.WSEnd{
						Reason: err.Error(),
					})
				}
				return
			}
			if err := m.pusher.SendWSFrame(sessionID, &proto.WSFrame{
				Opcode: int32(opcode),
				Data:   data,
			}); err != nil {
				// Server-side stream gone — let the deferred End close
				// upstream cleanly.
				return
			}
		}
	}()
}

// Frame queues a browser-originated frame for the per-session writer
// goroutine. Returns immediately — the dispatcher MUST NOT block, or it
// would head-of-line every other tunnel message (other sessions' frames,
// resource responses, plugin status) for the duration of an upstream stall.
//
// If the writer's backlog is full we tear the session down rather than
// silently drop, so the browser sees a fail-fast close instead of mysterious
// dropped frames.
func (m *WSManager) Frame(sessionID string, frame *proto.WSFrame) {
	m.mu.Lock()
	sess, ok := m.sessions[sessionID]
	m.mu.Unlock()
	if !ok {
		return
	}
	select {
	case sess.writeCh <- frame:
	default:
		log.Printf("[ws-proxy] write backlog full, dropping session: id=%s", sessionID)
		m.End(sessionID, &proto.WSEnd{Reason: "upstream too slow"})
	}
}

// End closes the session. Safe to call from the pump goroutine, the End
// dispatcher (Server → Worker browser-close), and the Frame write-error path
// — closeOnce makes it idempotent. If `end` is provided it's also pushed back
// to Server so the browser learns the close code.
func (m *WSManager) End(sessionID string, end *proto.WSEnd) {
	m.mu.Lock()
	sess, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()
	if !ok {
		return
	}
	sess.closeOnce.Do(func() {
		// Best-effort polite close; ignore errors since we're shutting
		// down regardless. WriteControl is documented as concurrency-safe
		// with WriteMessage, so the writer goroutine racing on a final
		// frame can't deadlock here.
		if end != nil && end.Code != 0 {
			_ = sess.conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(int(end.Code), truncate(end.Reason, 100)),
				time.Now().Add(time.Second),
			)
		}
		_ = sess.conn.Close()
		sess.cancel()
		// Don't close(sess.writeCh) — the writer goroutine exits via the
		// ctx case in its select, and a closed channel would panic any
		// dispatcher Frame() that races with us. Leaving it un-closed is
		// safe: the GC reaps it once nothing references the session.
	})
}

// readDialBodyExcerpt grabs up to 512 bytes of the upstream's response body
// for diagnostics. Bad-handshake failures often come with a JSON or HTML
// error page that explains exactly why the upstream refused the upgrade
// (Grafana Live "origin not allowed", auth.proxy "missing header", etc.).
func readDialBodyExcerpt(body io.ReadCloser) string {
	if body == nil {
		return ""
	}
	defer body.Close()
	const max = 512
	buf, _ := io.ReadAll(io.LimitReader(body, max+1))
	if len(buf) > max {
		return string(buf[:max]) + "...(truncated)"
	}
	return string(buf)
}

// truncate keeps the WS close-frame Reason inside RFC 6455's 123-byte payload
// limit (we leave headroom for the 2-byte code).
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	// Avoid splitting in the middle of a UTF-8 sequence — the close frame
	// is binary, but Grafana / browsers expect valid UTF-8 in Reason.
	return strings.ToValidUTF8(s[:max], "")
}
