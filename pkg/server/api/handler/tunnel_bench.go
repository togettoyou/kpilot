// Package handler — tunnel bandwidth diagnostic.
//
// GET /api/v1/clusters/:id/debug/tunnel-bench?bytes=N times a single
// round-trip of N uncompressible bytes from the worker back to the
// server over the yamux tunnel. Surfaces the effective worker→server
// throughput — the direction that catastrophically degrades when the
// server and worker are on opposite sides of a slow WAN (e.g. control
// plane in one region, GPU cluster offshore). Operators run this
// after onboarding a cross-region worker to set realistic expectations
// (and decide whether logs/search `limit` defaults need lowering).
//
// The byte count rides in ResourceRequest.Limit so we don't need a
// dedicated proto message; worker's proxy.execute switches on
// Action="tunnel-bench" the same way it handles vgpu-snapshot.
package handler

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// tunnelBenchTimeout caps a single bench RPC. 100 MiB at 1 KB/s would
// take ~28 hours — well beyond any sane diagnostic. Capping at 10 min
// matches the worst-credible cross-WAN test (100 MiB at ~170 KB/s).
const tunnelBenchTimeout = 10 * time.Minute

// tunnelBenchDefaultBytes is what the endpoint generates when `bytes`
// is omitted. 4 MiB is large enough to amortise TCP slow-start + TLS
// handshake but small enough to complete in seconds on a local link.
const tunnelBenchDefaultBytes = 4 * 1024 * 1024

// tunnelBenchMaxBytes mirrors the worker-side cap (proxy.go). The
// server-side check rejects requests above the cap immediately rather
// than wasting a round-trip on a request the worker will refuse.
const tunnelBenchMaxBytes = 100 * 1024 * 1024

// tunnelBenchResponse is the JSON shape returned to the caller. kbps
// is computed server-side from `bytes * 8 / durationMs` so the operator
// doesn't have to redo the math.
type tunnelBenchResponse struct {
	Bytes      int     `json:"bytes"`
	DurationMs int64   `json:"durationMs"`
	Kbps       float64 `json:"kbps"`
}

// TunnelBench serves GET /api/v1/clusters/:id/debug/tunnel-bench
//
// Query params:
//
//	bytes — optional, integer, 1..100 MiB. Defaults to 4 MiB.
//
// Response: 200 OK with tunnelBenchResponse on success; 400 on bad
// input; 502/504 from handleWorkerErr on tunnel failure.
//
// The request itself is tiny (one ResourceRequestStart + BodyEnd),
// so the timing is dominated by the response chunked transport
// (worker → server). That's intentional: we're measuring the bad
// direction.
func TunnelBench(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		n := int64(tunnelBenchDefaultBytes)
		if s := c.Query("bytes"); s != "" {
			v, err := strconv.ParseInt(s, 10, 64)
			if err != nil || v <= 0 || v > tunnelBenchMaxBytes {
				apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
				return
			}
			n = v
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), tunnelBenchTimeout)
		defer cancel()

		start := time.Now()
		resp, err := gw.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{
			Action: "tunnel-bench",
			Limit:  n,
		})
		elapsed := time.Since(start)
		if err != nil {
			handleWorkerErr(c, err)
			return
		}
		if !resp.Success {
			apiErrWorker(c, resp.Error)
			return
		}

		// kbps = (bytes × 8) / (ms / 1000) / 1000
		//      = bytes × 8 / ms
		// Guard against the unlikely "completed in 0 ms" reading.
		kbps := 0.0
		if elapsed > 0 {
			kbps = float64(len(resp.Data)*8) / float64(elapsed.Milliseconds())
		}
		c.JSON(http.StatusOK, tunnelBenchResponse{
			Bytes:      len(resp.Data),
			DurationMs: elapsed.Milliseconds(),
			Kbps:       kbps,
		})
	}
}
