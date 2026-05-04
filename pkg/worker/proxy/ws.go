package proxy

import (
	"context"
	"errors"
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
// unit tests if we add them later.
type WSPusher interface {
	SendWSFrame(sessionID string, frame *proto.WSFrame) error
	SendWSEnd(sessionID string, end *proto.WSEnd) error
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

type wsSession struct {
	conn   *websocket.Conn
	cancel context.CancelFunc

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

	ctx, cancel := context.WithCancel(context.Background())
	conn, _, err := m.dialer.DialContext(ctx, req.Url, header)
	if err != nil {
		log.Printf("[ws-proxy] dial failed: url=%s err=%v", req.Url, err)
		cancel()
		_ = m.pusher.SendWSEnd(sessionID, &proto.WSEnd{
			Reason: "dial: " + err.Error(),
		})
		return
	}

	sess := &wsSession{conn: conn, cancel: cancel}
	m.mu.Lock()
	m.sessions[sessionID] = sess
	m.mu.Unlock()

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

// Frame writes a browser-originated frame to the upstream WS.
func (m *WSManager) Frame(sessionID string, frame *proto.WSFrame) {
	m.mu.Lock()
	sess, ok := m.sessions[sessionID]
	m.mu.Unlock()
	if !ok {
		return
	}
	// Default opcode 1 (text) when zero — older clients may send unset.
	op := int(frame.Opcode)
	if op == 0 {
		op = websocket.TextMessage
	}
	_ = sess.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := sess.conn.WriteMessage(op, frame.Data); err != nil {
		// On write failure tear the session down — the pump goroutine
		// will emit the WSEnd from the read side.
		m.End(sessionID, &proto.WSEnd{Reason: "upstream write: " + err.Error()})
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
		// down regardless.
		if end != nil && end.Code != 0 {
			_ = sess.conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(int(end.Code), truncate(end.Reason, 100)),
				time.Now().Add(time.Second),
			)
		}
		_ = sess.conn.Close()
		sess.cancel()
	})
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
