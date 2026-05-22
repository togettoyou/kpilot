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

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// wsCloseGrace is how long we wait for the worker to drain a final LogsEnd
// after the client disconnects before tearing down the session.
const wsCloseGrace = 2 * time.Second

// upgrader for Pod logs / Exec / plugin install-log WS endpoints.
// Origin is validated via the package-shared checkWSOrigin so cross-
// site WebSocket hijacking is blocked (SameSite=Lax cookies still ride
// the upgrade, so we cannot rely on cookie scoping alone).
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	CheckOrigin:     checkWSOrigin,
}

// PodLogs streams Pod logs from the cluster Worker to the browser over a WS.
// Query params: container, follow (default true), tail (default 100),
// previous (default false), since (seconds, default 0).
func PodLogs(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		namespace := c.Param("namespace")
		pod := c.Param("name")

		req := &pbv2.LogsStartRequest{
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

		stream, err := gw.OpenLogsStream(c.Request.Context(), clusterID, req)
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

		// Client-gone watcher: a NextReader error means peer closed
		// or pong timed out. We then stream.Close() — yamux FIN
		// propagates to the worker as "cancel kubectl logs".
		clientGone := make(chan struct{})
		go func() {
			defer close(clientGone)
			for {
				if _, _, err := rawConn.NextReader(); err != nil {
					return
				}
			}
		}()
		go func() {
			<-clientGone
			stream.Close()
		}()

		// Worker → browser pump. Recv blocks; on stream.Close
		// triggered by clientGone above, Recv returns io.EOF and
		// we exit cleanly.
		for {
			chunk, end, rerr := stream.Recv()
			if rerr != nil {
				return
			}
			if chunk != nil {
				if err := conn.WriteMessage(websocket.TextMessage, chunk.GetData()); err != nil {
					log.Printf("[pod-logs] write failed: %v", err)
					return
				}
				continue
			}
			if end != nil {
				if end.GetError() != "" {
					_ = conn.WriteMessage(websocket.TextMessage, []byte("\n[stream ended: "+end.GetError()+"]"))
				}
				_ = conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				return
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

		req := &pbv2.ExecStartRequest{
			Namespace: namespace,
			Pod:       pod,
			Container: c.Query("container"),
			Command:   cmd,
			Tty:       true,
			Cols:      cols,
			Rows:      rows,
		}

		stream, err := gw.OpenExecStream(c.Request.Context(), clusterID, req)
		if err != nil {
			apiErr(c, http.StatusServiceUnavailable, CodeClusterNotConnected)
			return
		}

		rawConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			stream.Close()
			return
		}
		rawConn.SetReadLimit(1 << 20)
		conn := newWSConn(rawConn)
		defer rawConn.Close()
		defer stream.Close()

		hbCtx, hbCancel := context.WithCancel(c.Request.Context())
		defer hbCancel()
		conn.startHeartbeat(hbCtx)

		// Browser → server pump.
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
						_ = stream.SendStdin(data[1:])
					}
				case 1: // resize
					var sz struct {
						Cols uint32 `json:"cols"`
						Rows uint32 `json:"rows"`
					}
					if err := json.Unmarshal(data[1:], &sz); err == nil && sz.Cols > 0 && sz.Rows > 0 {
						_ = stream.SendResize(sz.Cols, sz.Rows)
					}
				}
			}
		}()
		// Client-gone watcher: close the stream so the worker's
		// kubectl-exec stream tears down and Recv returns.
		go func() {
			<-clientGone
			stream.Close()
		}()

		// Worker → browser pump.
		for {
			out, end, rerr := stream.Recv()
			if rerr != nil {
				return
			}
			if out != nil {
				tag := byte(out.GetStream()) // 1 stdout, 2 stderr
				frame := append([]byte{tag}, out.GetData()...)
				if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
					log.Printf("[pod-exec] write failed: %v", err)
					return
				}
				continue
			}
			if end != nil {
				payload := append([]byte{3}, []byte(end.GetError())...)
				_ = conn.WriteMessage(websocket.BinaryMessage, payload)
				_ = conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				return
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

