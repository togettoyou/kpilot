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
		"inflight":        InferenceInflight.Load(),
		"total":           InferenceTotal.Load(),
		"sse_clients":     SSEClients.Load(),
	}
}
