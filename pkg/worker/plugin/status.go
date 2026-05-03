package plugin

import (
	pb "github.com/togettoyou/kpilot/pkg/common/proto"
	kpilotv1alpha1 "github.com/togettoyou/kpilot/pkg/worker/apis/v1alpha1"
)

// tunnelPusher is the part of tunnel.Client we need to push status. Defined
// here as a one-method interface so the plugin package doesn't import the
// tunnel package (avoids a cycle and makes testing easier).
type tunnelPusher interface {
	PushPluginStatus(crdName string, st *pb.PluginStatusPush)
}

// PusherAdapter converts a kpilotv1alpha1.PluginStatus into the wire-level
// PluginStatusPush and delegates to the tunnel client. Constructed in
// cmd/worker/main.go and handed to the Reconciler as its StatusPusher.
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
