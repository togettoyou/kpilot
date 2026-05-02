package handler

import (
	"context"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

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

// Underlying returns the raw *websocket.Conn for reads / handler hooks.
func (w *wsConn) Underlying() *websocket.Conn { return w.conn }

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
