// Package handler — shared time-range parsing for VM-backed pages.
//
// Every metrics handler accepts the same query-string vocabulary:
//
//   ?range=1h|24h|7d|30d         — preset window (default 1h)
//   ?from=<rfc3339>&to=<rfc3339> — explicit absolute range
//
// Custom range wins when both are present. The frontend's
// TimeRangePicker always sends explicit from/to when the user chose a
// custom window, and just `range=` when they hit a preset button.
package handler

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// maxCustomTimeRange caps explicit from/to spans. 31 days matches the
// upper end of the preset window and prevents accidental
// "since the beginning of time" queries that would OOM VictoriaMetrics
// or burn the 5-minute handler timeout for nothing.
const maxCustomTimeRange = 31 * 24 * time.Hour

// timeRangeSpec pairs a window duration with the PromQL step that
// gives roughly 100–500 points across the window. Tuned per page
// because chart panels and KPI snapshots want different resolutions.
type timeRangeSpec struct {
	duration time.Duration
	step     time.Duration
}

// resolvedTimeRange is what handler logic actually uses: concrete from/to,
// the step to pass to query_range, and a stable cacheSuffix for the
// shared VM response cache.
type resolvedTimeRange struct {
	duration    time.Duration
	step        time.Duration
	from        time.Time
	to          time.Time
	cacheSuffix string
}

// resolveTimeRange parses the request and returns a resolvedTimeRange,
// writing an error response to c on bad input. `presets` is the
// per-endpoint preset map (so cluster-metrics' 30s step at 1h doesn't
// have to match gpu-metrics' coarser default).
func resolveTimeRange(c *gin.Context, presets map[string]timeRangeSpec) (resolvedTimeRange, bool) {
	fromStr := c.Query("from")
	toStr := c.Query("to")
	if fromStr != "" && toStr != "" {
		from, err := time.Parse(time.RFC3339, fromStr)
		if err != nil {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return resolvedTimeRange{}, false
		}
		to, err := time.Parse(time.RFC3339, toStr)
		if err != nil {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return resolvedTimeRange{}, false
		}
		if !to.After(from) {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return resolvedTimeRange{}, false
		}
		duration := to.Sub(from)
		if duration > maxCustomTimeRange {
			apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
			return resolvedTimeRange{}, false
		}
		return resolvedTimeRange{
			duration:    duration,
			step:        autoStep(duration),
			from:        from,
			to:          to,
			// from/to are already RFC3339 — using them verbatim gives a
			// stable cache key that lines up with what the frontend
			// requested without re-formatting.
			cacheSuffix: "custom:" + fromStr + ":" + toStr,
		}, true
	}

	rangeKey := c.DefaultQuery("range", "1h")
	spec, ok := presets[rangeKey]
	if !ok {
		apiErr(c, http.StatusBadRequest, CodeInvalidRequest)
		return resolvedTimeRange{}, false
	}
	now := time.Now()
	return resolvedTimeRange{
		duration:    spec.duration,
		step:        spec.step,
		from:        now.Add(-spec.duration),
		to:          now,
		cacheSuffix: rangeKey,
	}, true
}

// autoStep mirrors the preset step tiers — keeps custom-range responses
// the same shape (point count) as their nearest preset, so the chart
// renders identically.
func autoStep(d time.Duration) time.Duration {
	switch {
	case d <= time.Hour:
		return 30 * time.Second
	case d <= 24*time.Hour:
		return 5 * time.Minute
	case d <= 7*24*time.Hour:
		return 30 * time.Minute
	default:
		return 2 * time.Hour
	}
}
