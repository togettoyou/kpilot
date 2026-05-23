// Package diag wires KPilot worker-specific custom collectors into
// the generic pkg/diag layer. Each collector here implements
// diag.Collector by reading whatever atomic counter / stats getter
// its target subsystem exposes; the diag layer dispatches Collect()
// at 1 Hz under Diag.sampleMu serialization, so individual collectors
// don't need to defend against re-entry.
package diag

import (
	"github.com/togettoyou/kpilot/pkg/worker/proxy"
	"github.com/togettoyou/kpilot/pkg/worker/tunnel"
)

// TunnelCollector exposes the worker's yamux tunnel state. The
// underlying *tunnel.Client uses atomics for every field surfaced via
// DiagStats, so this collector is lock-free on the read path.
type TunnelCollector struct {
	Client *tunnel.Client
}

func (c TunnelCollector) Name() string { return "tunnel" }

func (c TunnelCollector) Collect() map[string]any {
	if c.Client == nil {
		return nil
	}
	s := c.Client.DiagStats()
	return map[string]any{
		"connected":              s.Connected,
		"session_uptime_seconds": s.SessionUptimeS,
		"reconnect_total":        s.ReconnectTotal,
		"streams_open":           s.StreamsOpen,
		"server_addr":            s.ServerAddr,
	}
}

// ProxyCollector aggregates per-handler inflight counters across the
// five worker-side request handlers. All five are atomic.Int32 loads.
type ProxyCollector struct {
	Resource *proxy.Proxy
	HTTP     *proxy.HTTPProxy
	Logs     *proxy.LogsManager
	Exec     *proxy.ExecManager
	WS       *proxy.WSManager
}

func (c ProxyCollector) Name() string { return "proxy" }

func (c ProxyCollector) Collect() map[string]any {
	out := map[string]any{}
	if c.Resource != nil {
		out["inflight_resource"] = c.Resource.Inflight()
	}
	if c.HTTP != nil {
		out["inflight_http_proxy"] = c.HTTP.Inflight()
	}
	if c.Logs != nil {
		out["inflight_logs"] = c.Logs.Inflight()
	}
	if c.Exec != nil {
		out["inflight_exec"] = c.Exec.Inflight()
	}
	if c.WS != nil {
		out["inflight_ws"] = c.WS.Inflight()
	}
	return out
}

// RouterCollector reports the in-cluster service-vs-direct router's
// cache mode + hit rate. Lock-free (mode load is RLock-fast,
// counters are atomics).
type RouterCollector struct {
	Router *proxy.InClusterRouter
}

func (c RouterCollector) Name() string { return "in_cluster_router" }

func (c RouterCollector) Collect() map[string]any {
	if c.Router == nil {
		return nil
	}
	s := c.Router.Stats()
	return map[string]any{
		"mode":        s.Mode,
		"age_seconds": s.AgeSeconds,
		"hits":        s.Hits,
		"misses":      s.Misses,
		"hit_rate":    s.HitRate,
	}
}

