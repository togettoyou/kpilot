package plugin

import (
	"context"
	"fmt"
	"log"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	kpilotv1alpha1 "github.com/togettoyou/kpilot/pkg/worker/apis/v1alpha1"
	"github.com/togettoyou/kpilot/pkg/worker/tunnel"
)

// fieldManagerName scopes Server-Side Apply operations from the manager.
// Same string as the proxy uses for Workload SSA so kubectl/Helm can see
// kpilot-owned fields with one filter.
const fieldManagerName = "kpilot"

// Manager translates PluginCommands from the Server (enable/disable) into
// CRD operations on the local cluster. The reconciler does all the actual
// Helm work; this layer is just the protocol boundary.
type Manager struct {
	Client client.Client
	Cache  *ChartCache
	// Push lets handleDisable surface a "no-op completed" status back to
	// Server when there's no CRD to delete (Server already thinks the
	// plugin is Uninstalling — without this, the row would stay stuck).
	Push StatusPusher
}

func NewManager(c client.Client, cache *ChartCache, push StatusPusher) *Manager {
	return &Manager{Client: c, Cache: cache, Push: push}
}

// Handle is wired into tunnel.Client as the PluginCommand handler. It
// returns nil on every successful translation; reconciler-level errors
// flow back via PluginStatusPush, not from here.
func (m *Manager) Handle(ctx context.Context, cmd *tunnel.PluginCommand) error {
	switch cmd.Action {
	case "enable":
		return m.handleEnable(ctx, cmd)
	case "disable":
		return m.handleDisable(ctx, cmd)
	default:
		return fmt.Errorf("unknown plugin action: %q", cmd.Action)
	}
}

func (m *Manager) handleEnable(ctx context.Context, cmd *tunnel.PluginCommand) error {
	if cmd.Spec == nil {
		return fmt.Errorf("enable command without spec")
	}

	// Cache local chart bytes BEFORE writing the CRD so the reconciler
	// never observes a CRD pointing at a missing cache entry on the
	// happy path. (The cache-miss recovery path in reconciler.go handles
	// the case where this Worker pod restarted between command and
	// reconcile.) Blob bytes arrive via chunked transport (PluginCommandStart
	// followed by BodyChunk frames) and are reassembled into cmd.ChartBlob
	// before this handler runs.
	if cmd.Spec.Chart != nil &&
		kpilotv1alpha1.ChartType(cmd.Spec.Chart.Type) == kpilotv1alpha1.ChartTypeLocal &&
		len(cmd.ChartBlob) > 0 {
		if err := m.Cache.Put(cmd.Spec.Chart.Sha256, cmd.ChartBlob); err != nil {
			return fmt.Errorf("cache chart: %w", err)
		}
	}

	// Server-Side Apply: idempotent, no resourceVersion needed, no TOCTOU
	// race against the reconciler when it adds the finalizer concurrently.
	// fieldManager=kpilot + Force=true matches the convention in
	// pkg/worker/proxy for Workload writes.
	desired := buildPluginCRD(cmd)
	log.Printf("[plugin] applying CRD: name=%s", cmd.CrdName)
	return m.Client.Patch(ctx, desired, client.Apply,
		client.FieldOwner(fieldManagerName),
		client.ForceOwnership,
	)
}

func (m *Manager) handleDisable(ctx context.Context, cmd *tunnel.PluginCommand) error {
	var p kpilotv1alpha1.Plugin
	err := m.Client.Get(ctx, client.ObjectKey{Name: cmd.CrdName}, &p)
	if apierrors.IsNotFound(err) {
		// No CRD on this cluster, but Server's row is presumably parked
		// at Uninstalling (e.g. an earlier enable never reached us).
		// Push an empty-phase status so Server settles to Disabled
		// instead of staying stuck.
		log.Printf("[plugin] disable: CRD already absent, sending Disabled push: name=%s",
			cmd.CrdName)
		if m.Push != nil {
			m.Push.PushPluginStatus(cmd.CrdName, &kpilotv1alpha1.PluginStatus{})
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("get plugin: %w", err)
	}
	log.Printf("[plugin] deleting CRD: name=%s", cmd.CrdName)
	// The reconciler picks up the deletion timestamp, runs `helm
	// uninstall`, and removes the finalizer; the API server then drops
	// the object. We don't wait here.
	return m.Client.Delete(ctx, &p)
}

// buildPluginCRD converts a PluginSpec wire message into a fresh CRD
// object. It does NOT include any state (status, finalizers, resource
// version) — those are owned by the cluster.
func buildPluginCRD(cmd *tunnel.PluginCommand) *kpilotv1alpha1.Plugin {
	spec := cmd.Spec
	chart := kpilotv1alpha1.ChartSource{}
	if spec.Chart != nil {
		chart = kpilotv1alpha1.ChartSource{
			Type:    kpilotv1alpha1.ChartType(spec.Chart.Type),
			Repo:    spec.Chart.Repo,
			Name:    spec.Chart.Name,
			Version: spec.Chart.Version,
			SHA256:  spec.Chart.Sha256,
		}
	}
	return &kpilotv1alpha1.Plugin{
		// SSA requires Kind + APIVersion in the request body; controller-
		// runtime's typed client doesn't fill these in for us on Patch.
		TypeMeta: metav1.TypeMeta{
			APIVersion: kpilotv1alpha1.GroupVersion.String(),
			Kind:       "Plugin",
		},
		ObjectMeta: metav1.ObjectMeta{Name: cmd.CrdName},
		Spec: kpilotv1alpha1.PluginSpec{
			PluginID:    spec.PluginId,
			DisplayName: spec.DisplayName,
			Chart:       chart,
			Release: kpilotv1alpha1.ReleaseSpec{
				Name:      spec.ReleaseName,
				Namespace: spec.ReleaseNamespace,
			},
			Values: spec.Values,
		},
	}
}
