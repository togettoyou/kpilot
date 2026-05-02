package handler

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// wsCloseGrace is how long we wait for the worker to drain a final LogsEnd
// after the client disconnects before tearing down the session.
const wsCloseGrace = 2 * time.Second

// upgrader for Pod logs / Exec WS endpoints. Origins are validated by the
// existing CORS middleware applied at the router level; browsers also send
// the auth cookie automatically with the WS upgrade so the JWT middleware
// runs first and aborts on missing/invalid tokens.
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	CheckOrigin:     func(*http.Request) bool { return true },
}

// PodLogs streams Pod logs from the cluster Worker to the browser over a WS.
// Query params: container, follow (default true), tail (default 100),
// previous (default false), since (seconds, default 0).
func PodLogs(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		namespace := c.Param("namespace")
		pod := c.Param("name")

		req := &proto.LogsStartRequest{
			Namespace: namespace,
			Pod:       pod,
			Container: c.Query("container"),
			Follow:    queryBool(c, "follow", true),
			Previous:  queryBool(c, "previous", false),
			TailLines: queryInt64(c, "tail", 100),
		}
		if since := queryInt64(c, "since", 0); since > 0 {
			req.SinceSeconds = since
		}

		stream, err := gw.OpenStream(clusterID)
		if err != nil {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}

		rawConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			stream.Close()
			return
		}
		conn := newWSConn(rawConn)
		defer rawConn.Close()
		defer stream.Close()

		hbCtx, hbCancel := context.WithCancel(c.Request.Context())
		defer hbCancel()
		conn.startHeartbeat(hbCtx)

		if err := stream.Send(req); err != nil {
			_ = conn.WriteMessage(websocket.TextMessage, []byte("[error] "+err.Error()))
			return
		}

		// Goroutine: detect client disconnect or read-deadline timeout (no pong)
		// → cancel worker side. The read deadline is refreshed by the pong
		// handler, so a healthy peer keeps NextReader blocked indefinitely.
		clientGone := make(chan struct{})
		go func() {
			defer close(clientGone)
			for {
				if _, _, err := rawConn.NextReader(); err != nil {
					return
				}
			}
		}()

		// Forward worker frames → WS until end-of-stream or disconnect.
		for {
			select {
			case <-clientGone:
				_ = stream.Send(&proto.LogsCancelRequest{})
				// Drain a final LogsEnd briefly so the worker side cleans up.
				select {
				case <-stream.Recv():
				case <-time.After(wsCloseGrace):
				}
				return

			case msg, ok := <-stream.Recv():
				if !ok {
					return
				}
				switch p := msg.Payload.(type) {
				case *proto.WorkerMessage_LogsChunk:
					if err := conn.WriteMessage(websocket.TextMessage, p.LogsChunk.Data); err != nil {
						log.Printf("[pod-logs] write failed: %v", err)
						return
					}
				case *proto.WorkerMessage_LogsEnd:
					if p.LogsEnd.Error != "" {
						_ = conn.WriteMessage(websocket.TextMessage, []byte("\n[stream ended: "+p.LogsEnd.Error+"]"))
					}
					_ = conn.WriteMessage(websocket.CloseMessage,
						websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
					return
				}
			}
		}
	}
}

// PodExec opens an interactive exec session over a WebSocket. The Browser
// sends binary frames where the first byte is a type tag:
//
//	0 = stdin (rest is raw bytes)
//	1 = resize (rest is JSON: {"cols":N,"rows":N})
//
// The server sends binary frames where the first byte is:
//
//	1 = stdout (rest is bytes)
//	2 = stderr (rest is bytes)
//	3 = end    (rest is utf-8 error string; empty = clean exit)
//
// Query params: container, command (comma-separated; default "/bin/sh"),
// cols, rows.
func PodExec(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		namespace := c.Param("namespace")
		pod := c.Param("name")

		cols := uint32(queryInt64(c, "cols", 80))
		rows := uint32(queryInt64(c, "rows", 24))

		// Empty command → leave Command nil so the worker picks the default
		// (bash with auto-fallback to sh). Only override if the caller sent a
		// custom command explicitly.
		var cmd []string
		if cmdStr := c.Query("command"); cmdStr != "" {
			cmd = strings.Split(cmdStr, ",")
		}

		req := &proto.ExecStartRequest{
			Namespace: namespace,
			Pod:       pod,
			Container: c.Query("container"),
			Command:   cmd,
			Tty:       true,
			Cols:      cols,
			Rows:      rows,
		}

		stream, err := gw.OpenStream(clusterID)
		if err != nil {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}

		rawConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			stream.Close()
			return
		}
		conn := newWSConn(rawConn)
		defer rawConn.Close()
		defer stream.Close()

		hbCtx, hbCancel := context.WithCancel(c.Request.Context())
		defer hbCancel()
		conn.startHeartbeat(hbCtx)

		if err := stream.Send(req); err != nil {
			_ = conn.WriteMessage(websocket.BinaryMessage, append([]byte{3}, []byte(err.Error())...))
			return
		}

		// Browser → server pump: parse type-tagged frames into stdin/resize.
		// Read deadline is refreshed by the pong handler — if the peer goes
		// silent for >pongWait, ReadMessage returns an error and we tear down.
		clientGone := make(chan struct{})
		go func() {
			defer close(clientGone)
			for {
				_, data, err := rawConn.ReadMessage()
				if err != nil {
					return
				}
				if len(data) == 0 {
					continue
				}
				switch data[0] {
				case 0: // stdin
					if len(data) > 1 {
						_ = stream.Send(&proto.ExecStdin{Data: data[1:]})
					}
				case 1: // resize
					var sz struct {
						Cols uint32 `json:"cols"`
						Rows uint32 `json:"rows"`
					}
					if err := json.Unmarshal(data[1:], &sz); err == nil && sz.Cols > 0 && sz.Rows > 0 {
						_ = stream.Send(&proto.ExecResize{Cols: sz.Cols, Rows: sz.Rows})
					}
				}
			}
		}()

		// Worker → browser pump.
		for {
			select {
			case <-clientGone:
				_ = stream.Send(&proto.ExecCancelRequest{})
				select {
				case <-stream.Recv():
				case <-time.After(wsCloseGrace):
				}
				return

			case msg, ok := <-stream.Recv():
				if !ok {
					return
				}
				switch p := msg.Payload.(type) {
				case *proto.WorkerMessage_ExecOutput:
					out := p.ExecOutput
					tag := byte(out.Stream) // 1 stdout, 2 stderr
					frame := append([]byte{tag}, out.Data...)
					if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
						log.Printf("[pod-exec] write failed: %v", err)
						return
					}
				case *proto.WorkerMessage_ExecEnd:
					end := p.ExecEnd
					payload := append([]byte{3}, []byte(end.Error)...)
					_ = conn.WriteMessage(websocket.BinaryMessage, payload)
					_ = conn.WriteMessage(websocket.CloseMessage,
						websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
					return
				}
			}
		}
	}
}

func queryBool(c *gin.Context, key string, def bool) bool {
	v := c.Query(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func queryInt64(c *gin.Context, key string, def int64) int64 {
	v := c.Query(key)
	if v == "" {
		return def
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return def
	}
	return n
}

