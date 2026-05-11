package handler

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// PluginInstallLog streams the worker's Helm install / upgrade /
// uninstall progress for a specific plugin to the browser over a WS.
//
// Unlike Pod logs (PodLogs in pod.go), there's nothing to "start" on
// the worker — install logs are continuously emitted by the
// reconciler whenever a Plugin CRD reconciles. This handler just
// subscribes to the gateway's in-memory fan-out for the requested
// (cluster, plugin) pair, replays whatever's already in the ring
// buffer, then streams new entries until the client disconnects.
//
// Both `chunk` and `end` frames flow on the same WS as JSON
// (PluginLogEntry). The frontend renders chunks live and treats
// the `end` frame as the terminal-state banner.
func PluginInstallLog(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		crdName := c.Param("name")
		if clusterID == "" || crdName == "" {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}

		rawConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			return
		}
		conn := newWSConn(rawConn)
		defer rawConn.Close()

		hbCtx, hbCancel := context.WithCancel(c.Request.Context())
		defer hbCancel()
		conn.startHeartbeat(hbCtx)

		// Subscribe BEFORE writing the snapshot so any frames pushed
		// in the gap between snapshot capture and channel attach are
		// still delivered via the channel. SubscribePluginLog hands
		// back both in one critical section so this is race-free.
		snapshot, ch, unsubscribe := gw.SubscribePluginLog(clusterID, crdName)
		defer unsubscribe()

		// Replay buffered entries first.
		for i := range snapshot {
			if err := writePluginLog(conn, &snapshot[i]); err != nil {
				return
			}
		}

		// Detect client disconnect (close frame, broken transport, or
		// pong timeout via the heartbeat read deadline) so we can
		// stop pushing and clean up.
		clientGone := make(chan struct{})
		go func() {
			defer close(clientGone)
			for {
				if _, _, err := rawConn.NextReader(); err != nil {
					return
				}
			}
		}()

		for {
			select {
			case <-clientGone:
				return
			case entry, ok := <-ch:
				if !ok {
					return
				}
				if err := writePluginLog(conn, &entry); err != nil {
					return
				}
			}
		}
	}
}

// writePluginLog serializes a single PluginLogEntry as a TextMessage.
// Failure means the WS conn is gone — caller returns to defer
// unsubscribe.
func writePluginLog(conn *wsConn, entry *gateway.PluginLogEntry) error {
	buf, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, buf)
}
