// Package handler — shared plugin runtime resolver.
//
// The (cluster + plugin name) → release-namespace + Phase=Running
// validation was duplicated across the reverse proxy (proxy.go) and
// the VM-query handlers (vm_query.go, indirectly device_health /
// gpu_hour / gpu_metrics). Both paths used to re-issue the same 3 DB
// queries; only the proxy had a TTL cache. The compute platform's GPU
// pages fan out 6 VM queries per refresh, multiplied by N open
// clusters — without a shared cache the DB load scaled linearly.
//
// This file owns the resolver + cache. Both the proxy and the VM
// handlers consume it; cache invalidation is keyed by (cluster, plugin)
// and triggered by the plugin enable/disable handlers.
package handler

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"gorm.io/gorm"

	"github.com/togettoyou/kpilot/pkg/server/store"
)

// pluginResolveTTL is how long a (cluster, plugin) → Running lookup is
// reused without hitting the DB. Grafana dashboard loads fan out to 30+
// parallel asset requests; the GPU pages fan out 6 VM queries per
// refresh. 30s is short enough that disabling a plugin in one tab
// kicks in within a poll in another, and the enable/disable handlers
// also call InvalidatePluginResolve so the cache flushes immediately
// on intentional state changes.
const pluginResolveTTL = 30 * time.Second

// pluginResolveEntry is the cached resolved state.
type pluginResolveEntry struct {
	releaseNS string
	cachedAt  time.Time
}

var (
	pluginResolveMu    sync.RWMutex
	pluginResolveCache = make(map[string]pluginResolveEntry)
)

// pluginResolveReapInterval is how often the background reaper walks
// the cache and evicts expired entries. Without eviction the cache grows
// unbounded over time — deleted clusters' keys would linger forever
// (the explicit invalidate covers plugin enable/disable but not cluster
// removal). One minute is far below pluginResolveTTL so the window of
// stale-but-expired entries is small; the cost is one map scan per
// minute over what's expected to be a small map (one key per active
// (cluster, plugin) pair).
const pluginResolveReapInterval = time.Minute

func init() {
	go reapPluginResolveCache()
}

// reapPluginResolveCache drops entries past pluginResolveTTL on a
// pluginResolveReapInterval ticker. Long-lived process scope; the
// goroutine never exits, by design.
func reapPluginResolveCache() {
	t := time.NewTicker(pluginResolveReapInterval)
	defer t.Stop()
	for range t.C {
		cutoff := time.Now().Add(-pluginResolveTTL)
		pluginResolveMu.Lock()
		for k, e := range pluginResolveCache {
			if e.cachedAt.Before(cutoff) {
				delete(pluginResolveCache, k)
			}
		}
		pluginResolveMu.Unlock()
	}
}

// resolvePluginRunning validates that the cluster exists, the plugin
// exists, a ClusterPlugin row links them, and Phase=Running. Returns
// the release namespace the plugin is installed into. The cache is
// consulted before each DB hit; misses re-issue the three queries.
//
// Returned `code` is a CodeXxx string ready to feed apiErr. Success
// returns ("", nil). Common code values:
//   - CodeClusterNotFound      — no cluster row
//   - CodePluginNotFound       — no plugin row
//   - CodePluginNotEnabled     — no cluster_plugin row
//   - CodePluginNotRunning     — row exists but disabled / not Running
//
// Callers typically translate the "not found / not enabled / not
// running" trio to RESOURCE_NOT_AVAILABLE 404 for the page-driven
// query endpoints (gpu-metrics, device-health, gpu-hour); the reverse
// proxy keeps them as 404 / 503 to drive its own UX.
func resolvePluginRunning(clusterID, pluginName string) (releaseNS, code string, err error) {
	key := clusterID + "/" + pluginName

	pluginResolveMu.RLock()
	entry, ok := pluginResolveCache[key]
	pluginResolveMu.RUnlock()
	if ok && time.Since(entry.cachedAt) < pluginResolveTTL {
		return entry.releaseNS, "", nil
	}

	if _, err := store.GetClusterByID(clusterID); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", CodeClusterNotFound, err
		}
		return "", "", err
	}
	plugin, err := store.GetPluginByName(pluginName)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", CodePluginNotFound, err
		}
		return "", "", err
	}
	cp, err := store.GetClusterPlugin(clusterID, plugin.ID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return "", CodePluginNotEnabled, err
		}
		return "", "", err
	}
	if !cp.Enabled || cp.Phase != store.PluginPhaseRunning {
		return "", CodePluginNotRunning, fmt.Errorf("plugin not running")
	}

	releaseNS = plugin.DefaultReleaseNamespace
	pluginResolveMu.Lock()
	pluginResolveCache[key] = pluginResolveEntry{
		releaseNS: releaseNS,
		cachedAt:  time.Now(),
	}
	pluginResolveMu.Unlock()
	return releaseNS, "", nil
}

// InvalidatePluginResolve drops cached lookups for a (cluster, plugin)
// so the next request re-checks DB state. Called by the plugin enable/
// disable handlers when state changes that would affect routing.
func InvalidatePluginResolve(clusterID, pluginName string) {
	key := clusterID + "/" + pluginName
	pluginResolveMu.Lock()
	delete(pluginResolveCache, key)
	pluginResolveMu.Unlock()
}
