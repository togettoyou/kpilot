// Package handler — log search panels.
//
// Two endpoints back the /clusters/:id/logging page:
//
//   /logs/search    — return at most `limit` matching log lines
//   /logs/histogram — bucketed counts of matching lines over time
//
// The frontend renders the histogram above the search results so a
// user can see the rough shape of log volume before scrolling. Both
// endpoints share the same query + time range; the frontend fires
// them in parallel.
//
// Hard requirement: victoria-logs plugin. RESOURCE_NOT_AVAILABLE 404
// when it's missing — same pattern as the Compute VM-backed pages.
package handler

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// logsMetaPayload fires as the very first SSE event on a streaming
// search. Echoes back the resolved query parameters so the frontend
// can render the "showing N lines from <from> to <to>" caption
// before any line arrives. Helps users tell "no matches" from "the
// query is slow" — the caption proves the request reached the
// server and parsed cleanly.
type logsMetaPayload struct {
	Query       string `json:"query"`
	From        string `json:"from"`
	To          string `json:"to"`
	GeneratedAt string `json:"generatedAt"`
	Limit       int    `json:"limit"`
}

// logsResultPayload is the terminal SSE event of a streaming
// search. By the time it fires the frontend has already received
// `total` `line` events (or fewer if Truncated/EndErr fired
// early), so we don't need to ship lines[] here — just the
// summary.
type logsResultPayload struct {
	Total     int    `json:"total"`
	Truncated bool   `json:"truncated"`
	ElapsedMs int64  `json:"elapsedMs"`
	// EndErr is non-empty when the worker reported the upstream
	// connection failed partway through (truncated VL response).
	// The frontend shows a "results may be incomplete" banner
	// alongside whatever lines DID arrive.
	EndErr string `json:"endErr,omitempty"`
}

// parseTimeWindow extracts from / to / limit from the URL query.
// from / to default to (now-1h, now). Limit defaults to 200, capped at
// 10000 — VictoriaLogs itself has no hard upper bound on `limit`, but
// beyond ~10k lines the browser DOM rendering becomes the bottleneck
// and an investigator should narrow the search instead of paginating.
// 10k × ~2 KiB/line keeps the chunked response in the single-digit MiB
// range, which the worker tunnel handles in <1s.
func parseTimeWindow(c *gin.Context) (from, to time.Time, limit int, ok bool) {
	to = time.Now()
	from = to.Add(-time.Hour)

	if s := c.Query("from"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		from = t
	}
	if s := c.Query("to"); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		to = t
	}
	if !to.After(from) {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return
	}

	limit = 200
	if s := c.Query("limit"); s != "" {
		v, err := strconv.Atoi(s)
		if err != nil || v <= 0 || v > 50000 {
			// Cap bumped from 10k → 50k after the search path was
			// rewired to true streaming. The old cap protected the
			// browser from a 10k-row dump landing in one shot;
			// streaming + virtuoso + the Stop button mean users
			// can comfortably handle larger result sets and bail
			// mid-stream if they don't need them all.
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		limit = v
	}
	ok = true
	return
}

// GetLogsSearch serves /api/v1/clusters/:id/logs/search?query=…&from=…&to=…&limit=…
//
// Response is Server-Sent Events (text/event-stream), NOT JSON. The
// frontend opens it with EventSource and listens for five events:
//
//   meta      — fires once on connection open before any line.
//               Echoes back the resolved query parameters so the
//               UI can render the caption "showing N lines from X
//               to Y" before the first line lands.
//   progress  — heartbeat every ~25 s while the query is in flight.
//               payload {"elapsedMs": <ms since handler start>}
//   line      — one per upstream NDJSON record, fired LIVE as the
//               worker tunnel streams chunks. payload = vmLogLine.
//               High-frequency on busy queries — the frontend
//               batches into virtuoso (50 ms / 100 rows) to keep
//               render cost bounded.
//   result    — terminal success event with the run summary.
//               payload = logsResultPayload {total, truncated,
//               elapsedMs, endErr?}. NO lines[] — they all flew
//               via `line` events already.
//   error     — terminal failure event for dispatch-level errors
//               (cluster offline, VL missing, …).
//
// Why SSE: managed HTTPS ingresses RST connections that send no
// bytes for ~60–300 s. The progress keepalive prevents that, and
// streaming `line` events keep activity flowing anyway during busy
// queries.
func GetLogsSearch(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		query := c.Query("query")
		// DIAG: trace logs-search lifecycle to chase the "browser
		// Stop hangs everything" report. Remove once root cause is
		// locked.
		dbgID := time.Now().UnixNano() % 1_000_000
		log.Printf("[diag-logs] ENTER req=%d cluster=%s query=%q", dbgID, clusterID, query)
		defer log.Printf("[diag-logs] EXIT req=%d", dbgID)
		if query == "" {
			// Empty query == "everything in the window". The frontend
			// presents an empty search box as "all logs"; mirroring
			// that here keeps the API forgiving and matches LogsQL's
			// own catch-all syntax.
			query = "*"
		}
		// parseTimeWindow writes a regular 4xx and returns ok=false on
		// validation failure — we let that go out as a plain non-SSE
		// 400 because EventSource's initial response status is the
		// signal the browser uses; sending an SSE error event over a
		// 200 OK would hide the request being malformed.
		from, to, limit, ok := parseTimeWindow(c)
		if !ok {
			return
		}

		sse := startSSE(c)
		if sse == nil {
			return
		}
		stopKeepalive := sse.startKeepalive()
		defer stopKeepalive()

		vlURL, code, err := resolveVMLogsURL(gw, clusterID)
		if err != nil {
			if code != "" {
				if code == CodePluginNotFound || code == CodePluginNotEnabled || code == CodePluginNotRunning {
					sse.sendError(CodeResourceNotAvailable, "", http.StatusNotFound)
					return
				}
				sse.sendError(code, "", http.StatusServiceUnavailable)
				return
			}
			sse.sendInternalError(err)
			return
		}

		// Emit meta FIRST so the UI has parameters to render before
		// any line arrives. send() failure here means the client
		// already disconnected — bail rather than continue running
		// the expensive query.
		if err := sse.send("meta", logsMetaPayload{
			Query:       query,
			From:        from.UTC().Format(time.RFC3339),
			To:          to.UTC().Format(time.RFC3339),
			GeneratedAt: time.Now().UTC().Format(time.RFC3339),
			Limit:       limit,
		}); err != nil {
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), vmlogsTimeout)
		defer cancel()

		start := time.Now()
		log.Printf("[diag-logs] start streamVMLogs req=%d limit=%d", dbgID, limit)
		total, endErr, sErr := streamVMLogs(ctx, gw, clusterID, vlURL,
			query, from, to, limit,
			func(ln vmLogLine) error {
				return sse.send("line", ln)
			})
		log.Printf("[diag-logs] streamVMLogs returned req=%d total=%d endErr=%q sErr=%v ctxErr=%v",
			dbgID, total, endErr, sErr, ctx.Err())
		if sErr != nil {
			if errors.Is(sErr, context.Canceled) {
				return
			}
			sse.sendInternalError(sErr)
			return
		}
		_ = sse.send("result", logsResultPayload{
			Total:     total,
			Truncated: limit > 0 && total >= limit,
			ElapsedMs: time.Since(start).Milliseconds(),
			EndErr:    endErr,
		})
	}
}

type logsHistogramResponse struct {
	Query       string                 `json:"query"`
	From        string                 `json:"from"`
	To          string                 `json:"to"`
	GeneratedAt string                 `json:"generatedAt"`
	StepSeconds int                    `json:"stepSeconds"`
	Points      []vmLogsHistogramPoint `json:"points"`
	// Total matches across the window — handy for the "M results in N
	// minutes" caption.
	Total int64 `json:"total"`
}

// histogramStep picks a bucket width that produces ~50 points over the
// window. Smaller windows want finer granularity; larger ones want
// coarse buckets so the chart doesn't render thousands of bars.
func histogramStep(d time.Duration) time.Duration {
	step := d / 50
	if step < time.Second {
		return time.Second
	}
	if step > time.Hour {
		return time.Hour
	}
	return step
}

// GetLogsHistogram serves /api/v1/clusters/:id/logs/histogram?…
//
// Same SSE protocol as GetLogsSearch — see that handler's doc comment.
// Histogram responses are smaller than search results (only bucket
// counts, not log lines), but we mirror the SSE shape so the frontend
// has a single code path for both endpoints.
func GetLogsHistogram(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		query := c.Query("query")
		if query == "" {
			query = "*"
		}
		from, to, _, ok := parseTimeWindow(c)
		if !ok {
			return
		}

		sse := startSSE(c)
		if sse == nil {
			return
		}
		stopKeepalive := sse.startKeepalive()
		defer stopKeepalive()

		vlURL, code, err := resolveVMLogsURL(gw, clusterID)
		if err != nil {
			if code != "" {
				if code == CodePluginNotFound || code == CodePluginNotEnabled || code == CodePluginNotRunning {
					sse.sendError(CodeResourceNotAvailable, "", http.StatusNotFound)
					return
				}
				sse.sendError(code, "", http.StatusServiceUnavailable)
				return
			}
			sse.sendInternalError(err)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), vmlogsTimeout)
		defer cancel()
		step := histogramStep(to.Sub(from))
		points, err := queryVMLogsHistogram(ctx, gw, clusterID, vlURL, query, from, to, step)
		if err != nil {
			sse.sendInternalError(err)
			return
		}
		var total int64
		for _, p := range points {
			total += p.Count
		}
		_ = sse.send("result", logsHistogramResponse{
			Query:       query,
			From:        from.UTC().Format(time.RFC3339),
			To:          to.UTC().Format(time.RFC3339),
			GeneratedAt: time.Now().UTC().Format(time.RFC3339),
			StepSeconds: int(step.Seconds()),
			Points:      points,
			Total:       total,
		})
	}
}
