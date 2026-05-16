package handler

import (
	"encoding/json"
	"sync"
	"time"
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

// InvalidateCluster drops every entry whose key includes the given
// cluster id. Called from the DeleteCluster path so deleted clusters
// don't leak entries.
func (c *vmResponseCache) InvalidateCluster(clusterID string) {
	needle := "|" + clusterID + "|"
	c.mu.Lock()
	for k := range c.entries {
		if containsSubstr(k, needle) {
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

// containsSubstr is strings.Contains without pulling in the strings
// package — the cache hot path is small and we want to keep this file
// dependency-light.
func containsSubstr(s, sub string) bool {
	if len(sub) == 0 {
		return true
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
