package plugin

import (
	"time"

	pb "github.com/togettoyou/kpilot/pkg/common/proto"
	kpilotv1alpha1 "github.com/togettoyou/kpilot/pkg/worker/apis/v1alpha1"
)

// tunnelPusher is the part of tunnel.Client we need to push plugin
// status + install log frames. Defined here as a one-method interface
// (well, three now) so the plugin package doesn't import the tunnel
// package (avoids a cycle and makes testing easier).
type tunnelPusher interface {
	PushPluginStatus(crdName string, st *pb.PluginStatusPush)
	PushPluginLog(crdName string, level, message string, ts int64)
	PushPluginLogEnd(crdName string, success bool, summary string)
}

// PusherAdapter converts plugin-package types into wire-level pb
// messages and delegates to the tunnel client. Constructed in
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
	st := &pb.PluginStatusPush{
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
	a.Tunnel.PushPluginStatus(crdName, st)
}

// PushPluginLog emits one progress line for the given plugin's
// install / upgrade / uninstall session. Worker emits these
// constantly during a reconcile (Helm SDK logger + reconciler
// milestones); Server fans them out to any subscribed WS clients
// and keeps a short ring buffer for late subscribers.
func (a *PusherAdapter) PushPluginLog(crdName, level, message string) {
	a.Tunnel.PushPluginLog(crdName, level, message, time.Now().UnixMilli())
}

// PushPluginLogEnd closes the log session for a plugin. Frontend
// uses this to render the terminal success / failure banner and
// stop showing the "still running" indicator.
func (a *PusherAdapter) PushPluginLogEnd(crdName string, success bool, summary string) {
	a.Tunnel.PushPluginLogEnd(crdName, success, summary)
}
