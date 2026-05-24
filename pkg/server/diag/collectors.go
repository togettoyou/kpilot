package diag

import (
	"github.com/togettoyou/kpilot/pkg/server/gateway"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

// YamuxCollector exposes the gateway's per-cluster yamux session +
// stream counts. Reads under gateway's RLock (held briefly while we
// build map copies) — no mutation of the gateway from this path.
type YamuxCollector struct {
	Gateway *gateway.GatewayServer
}

func (c YamuxCollector) Name() string { return "yamux" }

func (c YamuxCollector) Collect() map[string]any {
	if c.Gateway == nil {
		return nil
	}
	s := c.Gateway.DiagSnapshot()
	return map[string]any{
		"sessions":           s.Sessions,
		"streams_open":       s.StreamsOpen,
		"streams_by_cluster": s.StreamsByCluster,
		"cluster_names":      s.ClusterNames,
	}
}

// DBCollector surfaces the GORM pool's sql.DBStats. sql.DBStats is
// captured atomically by the driver, so this is lock-free from our
// side.
type DBCollector struct{}

func (DBCollector) Name() string { return "db" }

func (DBCollector) Collect() map[string]any {
	s := store.DBStats()
	return map[string]any{
		"max_open_connections":  s.MaxOpenConnections,
		"open_connections":      s.OpenConnections,
		"in_use":                s.InUse,
		"idle":                  s.Idle,
		"wait_count":            s.WaitCount,
		"wait_duration_seconds": s.WaitDuration.Seconds(),
		"max_idle_closed":       s.MaxIdleClosed,
		"max_lifetime_closed":   s.MaxLifetimeClosed,
	}
}

// InferenceCollector surfaces the package-level atomic gauges from
// counters.go. Lock-free.
type InferenceCollector struct{}

func (InferenceCollector) Name() string { return "inference" }

func (InferenceCollector) Collect() map[string]any {
	return map[string]any{
		"inflight":    InferenceInflight.Load(),
		"total":       InferenceTotal.Load(),
		"sse_clients": SSEClients.Load(),
	}
}

// CachesCollector surfaces handler-layer cache sizes that used to
// live on the /api/v1/metrics debug endpoint. Functions injected
// from cmd/server/main.go to avoid a server/diag → handler import
// cycle. Any field whose getter is nil is omitted from the output.
type CachesCollector struct {
	PluginResolve  func() int
	ProxySemaphore func() int
	VMResponse     func() int
}

func (CachesCollector) Name() string { return "caches" }

func (c CachesCollector) Collect() map[string]any {
	out := map[string]any{}
	if c.PluginResolve != nil {
		out["plugin_resolve"] = c.PluginResolve()
	}
	if c.ProxySemaphore != nil {
		out["proxy_semaphores"] = c.ProxySemaphore()
	}
	if c.VMResponse != nil {
		out["vm_response"] = c.VMResponse()
	}
	return out
}
