package handler

import (
	"log"
	"net/http"
	"strconv"
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
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error()})
			return
		}

		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			stream.Close()
			return
		}
		defer conn.Close()
		defer stream.Close()

		if err := stream.Send(req); err != nil {
			_ = conn.WriteMessage(websocket.TextMessage, []byte("[error] "+err.Error()))
			return
		}

		// Goroutine: detect client disconnect → cancel worker side.
		clientGone := make(chan struct{})
		go func() {
			defer close(clientGone)
			for {
				if _, _, err := conn.NextReader(); err != nil {
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

