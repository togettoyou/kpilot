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
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/togettoyou/kpilot/pkg/server/gateway"
)

// logSearchResponse mirrors the shape the frontend renders directly.
type logSearchResponse struct {
	Query       string      `json:"query"`
	From        string      `json:"from"`
	To          string      `json:"to"`
	GeneratedAt string      `json:"generatedAt"`
	Limit       int         `json:"limit"`
	Lines       []vmLogLine `json:"lines"`
	// Truncated=true when len(Lines) hit the limit so the frontend
	// can show a "results may be truncated" banner — VL doesn't tell
	// us total matches without a separate stats query.
	Truncated bool `json:"truncated"`
}

// parseTimeWindow extracts from / to / limit from the URL query.
// from / to default to (now-1h, now). Limit defaults to 200, capped at
// 1000 so a curl with limit=999999 can't drag huge payloads through
// the gateway.
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
		if err != nil || v <= 0 || v > 1000 {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		limit = v
	}
	ok = true
	return
}

// GetLogsSearch serves /api/v1/clusters/:id/logs/search?query=…&from=…&to=…&limit=…
func GetLogsSearch(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		query := c.Query("query")
		if query == "" {
			// LogsQL requires a query; an empty string matches
			// nothing — return a friendlier 400 rather than confusing
			// the user with an empty result set.
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		from, to, limit, ok := parseTimeWindow(c)
		if !ok {
			return
		}

		vlURL, code, err := resolveVMLogsURL(gw, clusterID)
		if err != nil {
			if code != "" {
				if code == CodePluginNotFound || code == CodePluginNotEnabled || code == CodePluginNotRunning {
					apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
					return
				}
				apiErr(c, http.StatusServiceUnavailable, code)
				return
			}
			apiErrInternal(c, err)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), vmlogsTimeout)
		defer cancel()
		lines, err := queryVMLogs(ctx, gw, clusterID, vlURL, query, from, to, limit)
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		c.JSON(http.StatusOK, logSearchResponse{
			Query:       query,
			From:        from.UTC().Format(time.RFC3339),
			To:          to.UTC().Format(time.RFC3339),
			GeneratedAt: time.Now().UTC().Format(time.RFC3339),
			Limit:       limit,
			Lines:       lines,
			Truncated:   len(lines) >= limit,
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
func GetLogsHistogram(gw *gateway.GatewayServer) gin.HandlerFunc {
	return func(c *gin.Context) {
		clusterID := c.Param("id")
		query := c.Query("query")
		if query == "" {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return
		}
		from, to, _, ok := parseTimeWindow(c)
		if !ok {
			return
		}

		vlURL, code, err := resolveVMLogsURL(gw, clusterID)
		if err != nil {
			if code != "" {
				if code == CodePluginNotFound || code == CodePluginNotEnabled || code == CodePluginNotRunning {
					apiErr(c, http.StatusNotFound, CodeResourceNotAvailable)
					return
				}
				apiErr(c, http.StatusServiceUnavailable, code)
				return
			}
			apiErrInternal(c, err)
			return
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), vmlogsTimeout)
		defer cancel()
		step := histogramStep(to.Sub(from))
		points, err := queryVMLogsHistogram(ctx, gw, clusterID, vlURL, query, from, to, step)
		if err != nil {
			apiErrInternal(c, err)
			return
		}
		var total int64
		for _, p := range points {
			total += p.Count
		}
		c.JSON(http.StatusOK, logsHistogramResponse{
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
