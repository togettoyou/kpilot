// Package diag provides KPilot server-specific custom collectors for
// the generic pkg/diag layer. Each collector here reads atomic /
// lock-free state owned by an existing server subsystem so a 1 Hz
// snapshot does not contend with hot-path traffic.
package diag

import (
	"context"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
)

// HTTPCollector exposes server-side HTTP traffic metrics with O(1)
// lock-free hot-path cost:
//
//   - in_flight              — current concurrent request count
//   - requests_total         — lifetime counter
//   - requests_per_sec       — completed-last-second rate
//   - status_5xx_per_sec     — completed-last-second 5xx rate
//   - latency_p50/p90/p99_ms — last-second power-of-2 histogram
//
// Sliding "last second" uses the classic live + prev double-buffer:
// hot path increments live; a janitor goroutine rotates `prev =
// live.Swap(0)` once per second. Reader returns prev (the last
// completed second). This costs one atomic.Add per request per
// metric, no CAS loop, no mutex — RPS contention does not degrade
// because there is exactly one shared counter per metric.
//
// Latency uses the same pattern over a 24-bucket power-of-2
// histogram (1 ms → ~16 s).
type HTTPCollector struct {
	inFlight  atomic.Int32
	totalReqs atomic.Uint64
	total5xx  atomic.Uint64

	liveReqs atomic.Uint64
	prevReqs atomic.Uint64
	live5xx  atomic.Uint64
	prev5xx  atomic.Uint64

	liveLat [latBucketsN]atomic.Uint64
	prevLat [latBucketsN]atomic.Uint64

	rotateOnce sync.Once
}

const (
	latBucketsN  = 24
	maxLatencyMs = 1 << (latBucketsN - 1) // ~16 s
)

// NewHTTPCollector returns a fresh collector. The caller should
// register it with the Gin engine via Middleware() AND start its
// rotation loop with RotateLoop(ctx) — without the latter, sliding
// "per second" counters never roll over and the dashboard reports 0.
func NewHTTPCollector() *HTTPCollector {
	return &HTTPCollector{}
}

// Middleware returns a Gin handler that updates the collector on
// each request. Hot path:
//
//   - Add(1) / Add(-1) on inFlight
//   - Add(1) on totalReqs
//   - Add(1) on liveReqs
//   - if 5xx: Add(1) on total5xx + live5xx
//   - Add(1) on liveLat[bucket]
//
// = 5–7 atomic ops per request, no allocations.
func (h *HTTPCollector) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		h.inFlight.Add(1)
		start := time.Now()
		defer func() {
			h.inFlight.Add(-1)
			h.totalReqs.Add(1)
			h.liveReqs.Add(1)
			status := c.Writer.Status()
			if status >= 500 && status < 600 {
				h.total5xx.Add(1)
				h.live5xx.Add(1)
			}
			ms := time.Since(start).Milliseconds()
			if ms < 0 {
				ms = 0
			}
			h.liveLat[latencyBucket(ms)].Add(1)
		}()
		c.Next()
	}
}

// RotateLoop rotates the live → prev buffers once per second so the
// "per_sec" / latency-p99 readers see a fixed 1-second window. Safe
// to call multiple times; only the first call spawns a goroutine.
// Goroutine exits when ctx is done.
func (h *HTTPCollector) RotateLoop(ctx context.Context) {
	h.rotateOnce.Do(func() {
		go func() {
			t := time.NewTicker(time.Second)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
					h.prevReqs.Store(h.liveReqs.Swap(0))
					h.prev5xx.Store(h.live5xx.Swap(0))
					for i := range h.liveLat {
						h.prevLat[i].Store(h.liveLat[i].Swap(0))
					}
				}
			}
		}()
	})
}

// latencyBucket maps a millisecond duration to a power-of-2 bucket
// index. Bucket i covers [2^(i-1), 2^i) for i > 0; bucket 0 = "≤ 1 ms".
func latencyBucket(ms int64) int {
	if ms <= 1 {
		return 0
	}
	if ms >= maxLatencyMs {
		return latBucketsN - 1
	}
	b := 0
	for x := ms; x > 0; x >>= 1 {
		b++
	}
	if b >= latBucketsN {
		b = latBucketsN - 1
	}
	return b
}

// Name implements diag.Collector.
func (h *HTTPCollector) Name() string { return "http" }

// Collect implements diag.Collector.
func (h *HTTPCollector) Collect() map[string]any {
	// Snapshot the latency buckets once; percentile math runs over
	// the local copy with no further atomic loads.
	var lat [latBucketsN]uint64
	for i := range lat {
		lat[i] = h.prevLat[i].Load()
	}
	var total uint64
	for _, v := range lat {
		total += v
	}

	pct := func(p float64) float64 {
		if total == 0 {
			return 0
		}
		target := uint64(math.Ceil(float64(total) * p))
		if target == 0 {
			target = 1
		}
		var acc uint64
		for i, v := range lat {
			acc += v
			if acc >= target {
				if i == 0 {
					return 1
				}
				lo := float64(int64(1) << (i - 1))
				hi := float64(int64(1) << i)
				return (lo + hi) / 2
			}
		}
		return float64(maxLatencyMs)
	}

	return map[string]any{
		"in_flight":          h.inFlight.Load(),
		"requests_total":     h.totalReqs.Load(),
		"requests_per_sec":   h.prevReqs.Load(),
		"status_5xx_total":   h.total5xx.Load(),
		"status_5xx_per_sec": h.prev5xx.Load(),
		"latency_p50_ms":     pct(0.5),
		"latency_p90_ms":     pct(0.9),
		"latency_p99_ms":     pct(0.99),
	}
}
