package plugin

import (
	"context"
	"fmt"
	"log"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"

	pb "github.com/togettoyou/kpilot/pkg/common/proto"
	kpilotv1alpha1 "github.com/togettoyou/kpilot/pkg/worker/apis/v1alpha1"
)

// Manager translates PluginCommands from the Server (enable/disable) into
// CRD operations on the local cluster. The reconciler does all the actual
// Helm work; this layer is just the protocol boundary.
type Manager struct {
	Client client.Client
	Cache  *ChartCache
}

func NewManager(c client.Client, cache *ChartCache) *Manager {
	return &Manager{Client: c, Cache: cache}
}

// Handle is wired into tunnel.Client as the PluginCommand handler. It
// returns nil on every successful translation; reconciler-level errors
// flow back via PluginStatusPush, not from here.
func (m *Manager) Handle(ctx context.Context, cmd *pb.PluginCommand) error {
	switch cmd.Action {
	case "enable":
		return m.handleEnable(ctx, cmd)
	case "disable":
		return m.handleDisable(ctx, cmd)
	default:
		return fmt.Errorf("unknown plugin action: %q", cmd.Action)
	}
}

func (m *Manager) handleEnable(ctx context.Context, cmd *pb.PluginCommand) error {
	if cmd.Spec == nil {
		return fmt.Errorf("enable command without spec")
	}

	// Cache local chart bytes BEFORE writing the CRD so the reconciler
	// never observes a CRD pointing at a missing cache entry on the
	// happy path. (The cache-miss recovery path in reconciler.go handles
	// the case where this Worker pod restarted between command and
	// reconcile.)
	if cmd.Spec.Chart != nil &&
		kpilotv1alpha1.ChartType(cmd.Spec.Chart.Type) == kpilotv1alpha1.ChartTypeLocal &&
		len(cmd.Spec.Chart.Blob) > 0 {
		if err := m.Cache.Put(cmd.Spec.Chart.Sha256, cmd.Spec.Chart.Blob); err != nil {
			return fmt.Errorf("cache chart: %w", err)
		}
	}

	desired := buildPluginCRD(cmd)
	var existing kpilotv1alpha1.Plugin
	err := m.Client.Get(ctx, client.ObjectKey{Name: cmd.CrdName}, &existing)
	switch {
	case apierrors.IsNotFound(err):
		log.Printf("[plugin] creating CRD: name=%s", cmd.CrdName)
		return m.Client.Create(ctx, desired)
	case err != nil:
		return fmt.Errorf("get plugin: %w", err)
	default:
		// Update spec on the existing object — preserve ResourceVersion +
		// Finalizers + Status (those are owned by the reconciler).
		existing.Spec = desired.Spec
		log.Printf("[plugin] updating CRD: name=%s", cmd.CrdName)
		return m.Client.Update(ctx, &existing)
	}
}

func (m *Manager) handleDisable(ctx context.Context, cmd *pb.PluginCommand) error {
	var p kpilotv1alpha1.Plugin
	err := m.Client.Get(ctx, client.ObjectKey{Name: cmd.CrdName}, &p)
	if apierrors.IsNotFound(err) {
		// Already gone — nothing to do.
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
func buildPluginCRD(cmd *pb.PluginCommand) *kpilotv1alpha1.Plugin {
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
