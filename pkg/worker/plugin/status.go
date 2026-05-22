package plugin

import (
	"time"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	kpilotv1alpha1 "github.com/togettoyou/kpilot/pkg/worker/apis/v1alpha1"
)

// tunnelPusher is the part of tunnel.Client this package uses to
// push plugin status + install log frames. Defined here as a
// one-method-set interface so the plugin package doesn't import
// the tunnel package (avoids a cycle and makes testing easier).
//
// Phase C: signatures switched from v1 proto.* to v2 pbv2.* +
// per-line / per-end helpers (the plumbing inside tunnel.Client
// opens a fresh STREAM_PLUGIN_LOG_PUSH per call).
type tunnelPusher interface {
	PushPluginStatus(p *pbv2.PluginStatusPush) error
	PushPluginLogLine(crdName, level, message string, ts int64) error
	PushPluginLogEnd(crdName string, success bool, summary string) error
}

// PusherAdapter converts plugin-package types into wire-level
// pb messages and delegates to the tunnel client. Constructed in
// cmd/worker/main.go and handed to the Reconciler as its Push field.
type PusherAdapter struct {
	Tunnel tunnelPusher
}

func NewPusherAdapter(t tunnelPusher) *PusherAdapter {
	return &PusherAdapter{Tunnel: t}
}

func (a *PusherAdapter) PushPluginStatus(crdName string, status *kpilotv1alpha1.PluginStatus) {
	if status == nil {
		return
	}
	st := &pbv2.PluginStatusPush{
		CrdName:            crdName,
		Phase:              string(status.Phase),
		Message:            status.Message,
		ObservedVersion:    status.ObservedVersion,
		ObservedValuesHash: status.ObservedValuesHash,
		HelmRevision:       status.HelmRevision,
	}
	if status.InstalledAt != nil {
		st.InstalledAt = status.InstalledAt.Unix()
	}
	if status.LastUpdatedAt != nil {
		st.LastUpdatedAt = status.LastUpdatedAt.Unix()
	}
	_ = a.Tunnel.PushPluginStatus(st)
}

// PushPluginLog emits one progress line.
func (a *PusherAdapter) PushPluginLog(crdName, level, message string) {
	_ = a.Tunnel.PushPluginLogLine(crdName, level, message, time.Now().UnixMilli())
}

// PushPluginLogEnd closes the log session for a plugin.
func (a *PusherAdapter) PushPluginLogEnd(crdName string, success bool, summary string) {
	_ = a.Tunnel.PushPluginLogEnd(crdName, success, summary)
}
