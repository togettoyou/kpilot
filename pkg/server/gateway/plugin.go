// Package gateway — plugin command transport + status push handling.
//
// v2 surface:
//   SendPluginCommand → opens STREAM_PLUGIN_COMMAND, writes the
//   PluginCommand frame, then the chart .tgz blob bytes (if any),
//   half-closes, reads back PluginCommandAck. Status updates flow
//   back asynchronously on worker-initiated STREAM_PLUGIN_STATUS_PUSH
//   streams (handled in dispatchInboundStream).
//
// pluginservice.Command (v1 proto types) gets converted to v2 at
// the wire boundary; the high-level service code is transport-
// agnostic.
package gateway

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	"github.com/togettoyou/kpilot/pkg/server/pluginservice"
	"github.com/togettoyou/kpilot/pkg/server/store"
)

// pluginCommandTimeout caps the time we'll wait for the worker
// to ack a PluginCommand. Helm install of a chart with N CRDs +
// post-install hooks can run several minutes (Grafana sidecar
// pulling dashboards, VictoriaMetrics waiting for PVC bind, etc),
// so 10 min is roomy. Worker also has its own internal Helm
// timeout that fires first when actual install hangs.
const pluginCommandTimeout = 10 * time.Minute

// ClusterDomain implements ClusterDomainResolver (used by
// pluginservice when expanding ${KPILOT_CLUSTER_DOMAIN}
// placeholders in values YAML).
func (g *GatewayServer) ClusterDomain(clusterID string) string {
	if w, ok := g.GetWorker(clusterID); ok && w.ClusterDomain != "" {
		return w.ClusterDomain
	}
	return ""
}

// SendPluginCommand opens a STREAM_PLUGIN_COMMAND stream, ships
// the command + (for local-chart enables) the .tgz blob, then
// reads back PluginCommandAck. Failure on the wire surfaces as
// a returned error; functional Helm install failures show up
// later as PluginStatusPush frames.
//
// Gzip is OFF — chart .tgz is already gzip-compressed and a
// second pass would just add CPU without saving bytes.
func (g *GatewayServer) SendPluginCommand(clusterID string, cmd *pluginservice.Command) error {
	w, ok := g.GetWorker(clusterID)
	if !ok {
		return fmt.Errorf("cluster %s not connected", clusterID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), pluginCommandTimeout)
	defer cancel()
	st, err := w.Session.Open(ctx, pbv2.StreamKind_STREAM_PLUGIN_COMMAND, uuid.NewString(), false)
	if err != nil {
		return fmt.Errorf("open plugin stream: %w", err)
	}
	defer st.Close()
	applyCtxDeadline(ctx, st)

	wire := &pbv2.PluginCommand{
		Action:         cmd.Action,
		CrdName:        cmd.CrdName,
		Spec:           pluginSpecToV2(cmd.Spec),
		ChartBlobSize:  int64(len(cmd.Blob)),
	}
	if err := st.WriteMsg(wire); err != nil {
		return fmt.Errorf("write plugin cmd: %w", err)
	}
	if len(cmd.Blob) > 0 {
		if _, err := st.Writer().Write(cmd.Blob); err != nil {
			return fmt.Errorf("write chart blob: %w", err)
		}
	}
	if err := st.CloseWrite(); err != nil {
		return fmt.Errorf("half-close plugin req: %w", err)
	}

	var ack pbv2.PluginCommandAck
	if err := st.ReadMsg(&ack); err != nil {
		return mapStreamErr(err, "read plugin ack")
	}
	if !ack.GetSuccess() {
		return fmt.Errorf("worker rejected plugin command: %s", ack.GetError())
	}
	return nil
}

// pluginSpecToV2 converts the v1 proto types pluginservice.Command
// carries into the v2 wire equivalent. Field sets are 1:1.
func pluginSpecToV2(s *proto.PluginSpec) *pbv2.PluginSpec {
	if s == nil {
		return nil
	}
	out := &pbv2.PluginSpec{
		PluginId:         s.GetPluginId(),
		DisplayName:      s.GetDisplayName(),
		ReleaseName:      s.GetReleaseName(),
		ReleaseNamespace: s.GetReleaseNamespace(),
		Values:           s.GetValues(),
	}
	if c := s.GetChart(); c != nil {
		out.Chart = &pbv2.ChartSource{
			Type:    c.GetType(),
			Repo:    c.GetRepo(),
			Name:    c.GetName(),
			Version: c.GetVersion(),
			Sha256:  c.GetSha256(),
			HasBlob: c.GetHasBlob(),
		}
	}
	return out
}

// pluginStatusFromV2 converts the v2 push frame back into v1's
// proto.PluginStatusPush so pluginservice.PersistStatus
// (transport-agnostic) keeps working without a v2 import.
func pluginStatusFromV2(p *pbv2.PluginStatusPush) *proto.PluginStatusPush {
	return &proto.PluginStatusPush{
		CrdName:            p.GetCrdName(),
		Phase:              p.GetPhase(),
		Message:            p.GetMessage(),
		ObservedVersion:    p.GetObservedVersion(),
		ObservedValuesHash: p.GetObservedValuesHash(),
		HelmRevision:       p.GetHelmRevision(),
		InstalledAt:        p.GetInstalledAt(),
		LastUpdatedAt:      p.GetLastUpdatedAt(),
	}
}

// handlePluginStatus persists a status push. Called from
// dispatchInboundStream when a worker opens a
// STREAM_PLUGIN_STATUS_PUSH stream.
func (g *GatewayServer) handlePluginStatus(w *ConnectedWorker, st *pbv2.PluginStatusPush) {
	if err := pluginservice.PersistStatus(w.ClusterID, pluginStatusFromV2(st)); err != nil {
		log.Printf("[gateway] plugin status persist: cluster=%s crd=%s err=%v",
			w.ClusterID, st.GetCrdName(), err)
	}
}

// replayPendingPluginCommands re-pushes plugin commands after
// a worker reconnects. See the (preserved) v1 doc comment in
// the original implementation; logic unchanged, just the inner
// transport call is v2 now.
func (g *GatewayServer) replayPendingPluginCommands(clusterID string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[gateway] replay panic: cluster=%s panic=%v", clusterID, r)
		}
	}()
	rows, err := store.ListClusterPlugins(clusterID)
	if err != nil {
		log.Printf("[gateway] replay: list cluster plugins failed: cluster=%s err=%v",
			clusterID, err)
		return
	}
	const replayPause = 100 * time.Millisecond
	sent := false
	maybePause := func() {
		if sent {
			time.Sleep(replayPause)
		}
	}
	for i := range rows {
		cp := &rows[i]
		switch cp.Phase {
		case store.PluginPhaseUninstalling:
			if cp.Enabled {
				continue
			}
			plugin, err := store.GetPluginByID(cp.PluginID)
			if err != nil {
				continue
			}
			cmd := &pluginservice.Command{
				Action:  "disable",
				CrdName: plugin.Name,
			}
			maybePause()
			if err := g.SendPluginCommand(clusterID, cmd); err != nil {
				log.Printf("[gateway] replay disable failed: cluster=%s plugin=%s err=%v",
					clusterID, plugin.Name, err)
				continue
			}
			sent = true
			log.Printf("[gateway] replay disable: cluster=%s plugin=%s",
				clusterID, plugin.Name)
		case store.PluginPhasePending,
			store.PluginPhaseInstalling,
			store.PluginPhaseUpgrading:
			if !cp.Enabled {
				continue
			}
			plugin, err := store.GetPluginByID(cp.PluginID)
			if err != nil {
				continue
			}
			cmd, err := pluginservice.BuildEnableCommand(plugin, cp, g)
			if err != nil {
				log.Printf("[gateway] replay enable build failed: cluster=%s plugin=%s err=%v",
					clusterID, plugin.Name, err)
				continue
			}
			maybePause()
			if err := g.SendPluginCommand(clusterID, cmd); err != nil {
				log.Printf("[gateway] replay enable failed: cluster=%s plugin=%s err=%v",
					clusterID, plugin.Name, err)
				continue
			}
			sent = true
			log.Printf("[gateway] replay enable: cluster=%s plugin=%s phase=%s",
				clusterID, plugin.Name, cp.Phase)
		}
	}
}

