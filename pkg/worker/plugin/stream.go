package plugin

import (
	"context"
	"io"

	pbv2 "github.com/togettoyou/kpilot/pkg/common/proto/v2"
	transportv2 "github.com/togettoyou/kpilot/pkg/transport/yamux"
	"github.com/togettoyou/kpilot/pkg/worker/tunnel"

	kplog "github.com/togettoyou/kpilot/pkg/log"
)

var streamLog = kplog.L("plugin-stream")

// HandleStream is the tunnel-dispatch entry point for an inbound
// STREAM_PLUGIN_COMMAND yamux stream. Lives in the plugin
// package (not cmd/worker/main.go) so the wire-mapping logic
// stays next to the plugin types it touches.
//
// Sequence:
//
//   1. Read pbv2.PluginCommand frame.
//   2. Read chart blob bytes (when chart_blob_size > 0).
//   3. Persist blob to ChartCache (sha256-keyed). MUST happen
//      before the ack so the worker contract documented in
//      pkg/server/gateway/plugin.go holds — server's
//      SendPluginCommand expects the blob to be on disk by
//      the time it sees PluginCommandAck.Success=true.
//   4. Write PluginCommandAck back. If the write fails, abort
//      without dispatching Handle — the server will retry,
//      and we'd rather process the command once than twice.
//   5. Dispatch Manager.Handle ASYNCHRONOUSLY on a fresh ctx.
//      Helm install / upgrade / uninstall runs in the
//      background; progress + final state arrive at the server
//      via STREAM_PLUGIN_STATUS_PUSH frames.
//
// Owns the stream lifecycle through Close.
func HandleStream(mgr *Manager, cache *ChartCache) func(context.Context, *transportv2.Stream) {
	return func(_ context.Context, st *transportv2.Stream) {
		defer st.Close()

		var wire pbv2.PluginCommand
		if err := st.ReadMsg(&wire); err != nil {
			streamLog.Warnf("read req failed: %v", err)
			return
		}

		var blob []byte
		if n := wire.GetChartBlobSize(); n > 0 {
			blob = make([]byte, n)
			if _, err := io.ReadFull(st.Reader(), blob); err != nil {
				streamLog.Warnf("read blob failed: crd=%s err=%v",
					wire.GetCrdName(), err)
				_ = st.WriteMsg(&pbv2.PluginCommandAck{Error: err.Error()})
				return
			}
		}

		cmd := wireToCommand(&wire, blob)

		// Persist chart blob before ack so the worker contract
		// holds (server treats Ack.Success as "command + blob
		// on disk"). For repo charts there's no blob to cache.
		if cmd.Spec != nil && cmd.Spec.Chart != nil &&
			cmd.Spec.Chart.Type == "local" && len(blob) > 0 {
			if err := cache.Put(cmd.Spec.Chart.Sha256, blob); err != nil {
				streamLog.Warnf("cache chart failed: crd=%s sha=%s err=%v",
					cmd.CrdName, cmd.Spec.Chart.Sha256, err)
				_ = st.WriteMsg(&pbv2.PluginCommandAck{
					Error: "cache chart: " + err.Error(),
				})
				return
			}
		}

		// Ack first, only dispatch Handle if the ack actually
		// landed. If the write failed, the server didn't see
		// our success — it'll retry. Dispatching anyway would
		// process the command twice.
		if err := st.WriteMsg(&pbv2.PluginCommandAck{Success: true}); err != nil {
			streamLog.Warnf("ack write failed (not dispatching): crd=%s err=%v",
				cmd.CrdName, err)
			return
		}

		// Async dispatch. Helm operations are long-running and
		// must outlive both this handler goroutine and (in the
		// worst case) the session that delivered the command —
		// the reconciler keeps pushing PluginStatusPush frames
		// on every session reconnect via replayPendingPluginCommands.
		go func() {
			if herr := mgr.Handle(context.Background(), cmd); herr != nil {
				streamLog.Warnf("async handle err: crd=%s action=%s err=%v",
					cmd.CrdName, cmd.Action, herr)
			}
		}()
	}
}

// wireToCommand maps pbv2.PluginCommand to the
// tunnel.PluginCommand shape Manager.Handle consumes. Field-for-
// field copy plus the chart blob bytes that flowed in raw on the
// same stream after the frame.
func wireToCommand(wire *pbv2.PluginCommand, blob []byte) *tunnel.PluginCommand {
	cmd := &tunnel.PluginCommand{
		Action:    wire.GetAction(),
		CrdName:   wire.GetCrdName(),
		ChartBlob: blob,
	}
	spec := wire.GetSpec()
	if spec == nil {
		return cmd
	}
	cmd.Spec = &tunnel.PluginSpec{
		PluginId:         spec.GetPluginId(),
		DisplayName:      spec.GetDisplayName(),
		ReleaseName:      spec.GetReleaseName(),
		ReleaseNamespace: spec.GetReleaseNamespace(),
		Values:           spec.GetValues(),
	}
	if c := spec.GetChart(); c != nil {
		cmd.Spec.Chart = &tunnel.ChartSource{
			Type:    c.GetType(),
			Repo:    c.GetRepo(),
			Name:    c.GetName(),
			Version: c.GetVersion(),
			Sha256:  c.GetSha256(),
			HasBlob: c.GetHasBlob(),
		}
	}
	return cmd
}
