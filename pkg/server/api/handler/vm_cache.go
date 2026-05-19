package handler

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

// vmResponseCache is the shared TTL cache for VM-backed query handlers
// (gpu-metrics, gpu-hour). Both endpoints fire on browser polling at 5s
// intervals, and at "5 open tabs × 50 clusters" the underlying fan-out
// to VictoriaMetrics through the gRPC tunnel becomes the heaviest
// outbound load on the platform. A sub-poll-interval TTL collapses N
// near-simultaneous callers into one real request while keeping data
// fresh enough that the chart still feels live.
//
// Cache stores JSON bytes (already-serialized response body) keyed by
// `(handlerTag, clusterID, range)`. Each handler picks its own tag +
// TTL so they don't collide. Serving from cache:
//
//   - sub-millisecond response time
//   - zero downstream work (no gRPC tunnel, no svc-proxy, no VM)
//   - byte-for-byte identical response so clients can't tell a hit
//     from a miss
//
// Bounded by (handlers × clusters × ranges); a few hundred entries max
// in realistic deployments. The reap goroutine drops expired entries
// every minute so the map doesn't grow forever in deployments that
// churn clusters.
type vmResponseCache struct {
	mu      sync.RWMutex
	entries map[string]vmCacheEntry
	// sf collapses concurrent cache-miss callers for the same key into
	// one underlying compute() invocation. Without it, N tabs polling
	// the same metric all fan out independently the first time the TTL
	// expires — the chart we ship has 10+ users at burst, so the
	// stampede was visible. singleflight.Do guarantees exactly one
	// in-flight call per key; the rest wait for its result.
	sf singleflight.Group
}

type vmCacheEntry struct {
	body      []byte
	expiresAt time.Time
}

var sharedVMResponseCache = func() *vmResponseCache {
	c := &vmResponseCache{entries: make(map[string]vmCacheEntry)}
	go c.reapForever(time.Minute)
	return c
}()

// Get returns the cached body if it exists and hasn't expired, or
// (nil, false) on miss.
func (c *vmResponseCache) Get(key string) ([]byte, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[key]
	if !ok || time.Now().After(e.expiresAt) {
		return nil, false
	}
	return e.body, true
}

// Put marshals v and stores it under key with the given TTL. Returns
// the marshalled bytes so the caller can also write them as the
// response (saves a second Marshal pass).
func (c *vmResponseCache) Put(key string, v any, ttl time.Duration) ([]byte, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.entries[key] = vmCacheEntry{body: body, expiresAt: time.Now().Add(ttl)}
	c.mu.Unlock()
	return body, nil
}

// GetOrCompute returns the cached body if it's still fresh, otherwise
// calls compute() (deduplicated across concurrent callers via
// singleflight) to build the response, caches the marshalled bytes
// with the given TTL, and returns. Callers should use this instead of
// the raw Get/Put pair when the compute step is expensive (PromQL
// fan-out through the tunnel) and a sub-poll-interval TTL leaves a
// burst window where a stampede would otherwise multiply load.
//
// compute() should return a JSON-marshallable value; the marshalled
// bytes go to both the cache and the caller. A compute() error is
// returned to all waiting callers without caching anything.
func (c *vmResponseCache) GetOrCompute(key string, ttl time.Duration, compute func() (any, error)) ([]byte, error) {
	if body, ok := c.Get(key); ok {
		return body, nil
	}
	v, err, _ := c.sf.Do(key, func() (any, error) {
		// Double-check under the singleflight gate — between our
		// Get above and entering Do, another caller may have
		// populated the cache. Skip the compute in that case.
		if body, ok := c.Get(key); ok {
			return body, nil
		}
		resp, err := compute()
		if err != nil {
			return nil, err
		}
		return c.Put(key, resp, ttl)
	})
	if err != nil {
		return nil, err
	}
	return v.([]byte), nil
}

// InvalidateCluster drops every entry whose key includes the given
// cluster id. Called from the DeleteCluster path so deleted clusters
// don't leak entries.
func (c *vmResponseCache) InvalidateCluster(clusterID string) {
	needle := "|" + clusterID + "|"
	c.mu.Lock()
	for k := range c.entries {
		if strings.Contains(k, needle) {
			delete(c.entries, k)
		}
	}
	c.mu.Unlock()
}

// Size returns the current entry count (including not-yet-reaped
// expired entries). Used by the /metrics endpoint.
func (c *vmResponseCache) Size() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.entries)
}

func (c *vmResponseCache) reapForever(interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for range t.C {
		now := time.Now()
		c.mu.Lock()
		for k, e := range c.entries {
			if now.After(e.expiresAt) {
				delete(c.entries, k)
			}
		}
		c.mu.Unlock()
	}
}

// vmCacheKey builds the cache key. Tag is the handler ("gpu-metrics" /
// "gpu-hour"); cluster is the resolved cluster id; suffix carries any
// extra dimensions (range parameter). The `|` separators are also used
// by InvalidateCluster to scope a delete.
func vmCacheKey(tag, clusterID, suffix string) string {
	return tag + "|" + clusterID + "|" + suffix
}
