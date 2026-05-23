package proxy

import (
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// InClusterRouter caches the per-Worker decision on how to reach
// in-cluster Services (Grafana, VictoriaMetrics, VictoriaLogs, etc.).
// Both the HTTP and WebSocket reverse-proxies consult the same
// instance so they don't probe twice — Worker is 1:1 with cluster
// and the "can I dial Service DNS directly" answer is the same for
// every protocol.
//
// Two states are cached:
//
//   - routingDirect: direct DNS dial of `<svc>.<ns>.svc.<cluster.local>:<port>`
//     works. Production case where the Worker runs as an in-cluster Pod.
//     Every subsequent request bypasses the API server entirely.
//   - routingProxy:  direct dial fails at the DNS layer (NXDOMAIN /
//     resolver timeout). Worker reaches the cluster only through
//     kubeconfig — local-dev SSH-tunneled setup is the canonical
//     example. Every request is rerouted through the K8s API server's
//     service-proxy subresource.
//
// routingUnknown (cache miss / expired) triggers a re-probe on the
// next request. The TTL is 24h — short enough to self-heal from a
// network reconfiguration within a day, long enough that every
// metric / log poll under steady state hits a warm cache.
type routingMode int

const (
	routingUnknown routingMode = iota
	routingDirect
	routingProxy
)

// routingServiceProxy is a more descriptive alias used by the Stats
// projection; keeps "proxy" inside this package for readability while
// surfacing the public form upstream.
const routingServiceProxy = routingProxy

const routingCacheTTL = 24 * time.Hour

// InClusterRouter holds the cached routing decision. Constructed once
// in cmd/worker/main.go and passed to both NewHTTPProxy and
// NewWSManager. Concurrent reads dominate (every proxied request),
// writes happen only on the probe path (once per TTL).
type InClusterRouter struct {
	mu        sync.RWMutex
	mode      routingMode
	decidedAt time.Time

	// Diagnostic counters. hits = Mode() returned a cached non-unknown
	// answer; misses = cold or expired and the caller had to probe.
	// Atomic so collectors can read lock-free.
	hits   atomic.Uint64
	misses atomic.Uint64
}

func NewInClusterRouter() *InClusterRouter {
	return &InClusterRouter{}
}

// Mode returns the cached routing decision or routingUnknown when
// the cache is cold or stale. Updates the hits/misses counters.
func (r *InClusterRouter) Mode() routingMode {
	r.mu.RLock()
	mode := r.mode
	expired := r.mode != routingUnknown && time.Since(r.decidedAt) >= routingCacheTTL
	r.mu.RUnlock()
	if mode == routingUnknown || expired {
		r.misses.Add(1)
		return routingUnknown
	}
	r.hits.Add(1)
	return mode
}

// RouterStats is the shape exposed via the diag /snapshot endpoint.
type RouterStats struct {
	Mode       string  `json:"mode"`         // "direct" / "service-proxy" / "unknown"
	AgeSeconds float64 `json:"age_seconds"`  // since last probe, 0 when unknown
	Hits       uint64  `json:"hits"`
	Misses     uint64  `json:"misses"`
	HitRate    float64 `json:"hit_rate"`     // hits / (hits+misses), 0 when no traffic
}

// Stats returns a copy of the router's current observability snapshot.
// Lock-free for the counters (atomics) + one RLock for the mode/age
// pair. Caller never holds Stats's internal state.
func (r *InClusterRouter) Stats() RouterStats {
	r.mu.RLock()
	mode := r.mode
	age := time.Since(r.decidedAt).Seconds()
	r.mu.RUnlock()
	if mode == routingUnknown {
		age = 0
	}
	h := r.hits.Load()
	m := r.misses.Load()
	var rate float64
	if total := h + m; total > 0 {
		rate = float64(h) / float64(total)
	}
	return RouterStats{
		Mode:       routerModeString(mode),
		AgeSeconds: age,
		Hits:       h,
		Misses:     m,
		HitRate:    rate,
	}
}

func routerModeString(m routingMode) string {
	switch m {
	case routingDirect:
		return "direct"
	case routingServiceProxy:
		return "service-proxy"
	default:
		return "unknown"
	}
}

// SetMode writes the probe result into the cache. Both successful
// direct-dial and successful fallback-after-DNS-failure stamp the
// same now() timestamp; the TTL is uniform regardless of which
// branch won.
func (r *InClusterRouter) SetMode(m routingMode) {
	r.mu.Lock()
	r.mode = m
	r.decidedAt = time.Now()
	r.mu.Unlock()
}

// isDNSFailure detects the "Worker is not on the cluster network"
// signal — NXDOMAIN, no nameserver configured, DNS lookup timeout.
//
// Explicitly does NOT match connection-refused / no-route errors:
// those mean DNS already resolved (so the Worker IS on the cluster
// network), but the Service has no endpoints or a NetworkPolicy
// blocks. Treating those as routing failures would silently hide
// real upstream problems behind a service-proxy retry that fails
// the same way one layer deeper. Surface them as-is and leave the
// routing cache untouched.
func isDNSFailure(err error) bool {
	if err == nil {
		return false
	}
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr)
}
