package plugin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	kpilotv1alpha1 "github.com/togettoyou/kpilot/pkg/worker/apis/v1alpha1"
)

// finalizerName ensures the Worker can run `helm uninstall` before the
// cluster API removes the Plugin CRD object.
const finalizerName = "kpilot.io/plugin-cleanup"

// StatusPusher is the contract the tunnel client implements: push a
// PluginStatusPush message back to Server. The reconciler invokes this on
// every successful status update so Server's view stays current without
// polling.
type StatusPusher interface {
	PushPluginStatus(crdName string, status *kpilotv1alpha1.PluginStatus)
}

// Reconciler reconciles a Plugin CRD by driving its Helm release toward
// the spec. One reconciler instance per Worker.
type Reconciler struct {
	Client client.Client
	Helm   *HelmRunner
	Cache  *ChartCache
	Push   StatusPusher
	Scheme *runtime.Scheme
}

// SetupWithManager wires the reconciler into a controller-runtime Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&kpilotv1alpha1.Plugin{}).
		Complete(r)
}

func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var plugin kpilotv1alpha1.Plugin
	if err := r.Client.Get(ctx, req.NamespacedName, &plugin); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// ── deletion path ─────────────────────────────────────────────────
	if !plugin.DeletionTimestamp.IsZero() {
		if !containsFinalizer(plugin.Finalizers, finalizerName) {
			return ctrl.Result{}, nil
		}
		// Mark phase=Uninstalling so PluginStatusPush reflects state.
		if plugin.Status.Phase != kpilotv1alpha1.PluginPhaseUninstalling {
			plugin.Status.Phase = kpilotv1alpha1.PluginPhaseUninstalling
			r.touchAndPush(ctx, &plugin, "uninstalling release")
		}
		if err := r.Helm.Uninstall(plugin.Spec.Release.Name, plugin.Spec.Release.Namespace); err != nil {
			r.markFailed(ctx, &plugin, fmt.Errorf("uninstall: %w", err))
			// Requeue to retry; finalizer stays so Server sees Failed.
			return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
		}
		// Remove finalizer so the API can delete the CRD object.
		plugin.Finalizers = removeFinalizer(plugin.Finalizers, finalizerName)
		if err := r.Client.Update(ctx, &plugin); err != nil {
			return ctrl.Result{}, err
		}
		// Push final "uninstalled" beat — Server will mark Disabled on
		// receipt since Enabled=false was already set by the disable
		// handler before the CRD was deleted.
		r.Push.PushPluginStatus(plugin.Name, &kpilotv1alpha1.PluginStatus{
			Phase:         kpilotv1alpha1.PluginPhase(""), // empty → Server treats as Disabled
			LastUpdatedAt: now(),
		})
		return ctrl.Result{}, nil
	}

	// ── install / upgrade path ────────────────────────────────────────
	// Add finalizer if missing; this is what guarantees we get a chance
	// to uninstall before the CRD vanishes.
	if !containsFinalizer(plugin.Finalizers, finalizerName) {
		plugin.Finalizers = append(plugin.Finalizers, finalizerName)
		if err := r.Client.Update(ctx, &plugin); err != nil {
			return ctrl.Result{}, err
		}
		// Update mutates the object; requeue will fetch the fresh copy.
		return ctrl.Result{Requeue: true}, nil
	}

	// Resolve chart source.
	var chartRef ChartRef
	switch kpilotv1alpha1.ChartType(plugin.Spec.Chart.Type) {
	case kpilotv1alpha1.ChartTypeRepo:
		chartRef = ChartRef{
			RepoURL: plugin.Spec.Chart.Repo,
			Name:    plugin.Spec.Chart.Name,
			Version: plugin.Spec.Chart.Version,
		}
	case kpilotv1alpha1.ChartTypeLocal:
		path := r.Cache.Path(plugin.Spec.Chart.SHA256)
		if path == "" {
			r.markFailed(ctx, &plugin, fmt.Errorf("chart cache missing: sha256=%s", plugin.Spec.Chart.SHA256))
			return ctrl.Result{RequeueAfter: 60 * time.Second}, nil
		}
		chartRef = ChartRef{LocalPath: path, Name: plugin.Spec.Chart.Name}
	default:
		r.markFailed(ctx, &plugin, fmt.Errorf("unknown chart type: %q", plugin.Spec.Chart.Type))
		return ctrl.Result{}, nil
	}

	// Decide install vs upgrade vs no-op via observed-hash check. Even
	// without that, Helm's own action.NewGet drives the install/upgrade
	// branching inside InstallOrUpgrade — but skipping the work entirely
	// when nothing changed avoids unnecessary churn.
	specHash := valuesHash(plugin.Spec.Values)
	if plugin.Status.Phase == kpilotv1alpha1.PluginPhaseRunning &&
		plugin.Status.ObservedValuesHash == specHash &&
		plugin.Status.ObservedVersion == plugin.Spec.Chart.Version {
		// Nothing to do — release matches spec.
		return ctrl.Result{}, nil
	}

	// Mark in-progress before the long Helm call so the UI can show progress.
	plugin.Status.Phase = pickInstallPhase(plugin.Status)
	r.touchAndPush(ctx, &plugin, "")

	values, err := ParseValues(plugin.Spec.Values)
	if err != nil {
		r.markFailed(ctx, &plugin, err)
		return ctrl.Result{}, nil
	}

	chart, err := r.Helm.LoadChart(chartRef)
	if err != nil {
		r.markFailed(ctx, &plugin, fmt.Errorf("load chart: %w", err))
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}

	rel, err := r.Helm.InstallOrUpgrade(
		plugin.Spec.Release.Name,
		plugin.Spec.Release.Namespace,
		chart,
		values,
	)
	if err != nil {
		r.markFailed(ctx, &plugin, fmt.Errorf("helm: %w", err))
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}

	plugin.Status.Phase = kpilotv1alpha1.PluginPhaseRunning
	plugin.Status.Message = ""
	plugin.Status.ObservedVersion = rel.Chart.Metadata.Version
	plugin.Status.ObservedValuesHash = specHash
	plugin.Status.HelmRevision = int32(rel.Version)
	if rel.Info != nil {
		t := metav1.NewTime(rel.Info.FirstDeployed.Time)
		plugin.Status.InstalledAt = &t
	}
	r.touchAndPush(ctx, &plugin, "")
	log.Printf("[plugin] release reconciled: name=%s ns=%s rev=%d ver=%s",
		plugin.Spec.Release.Name, plugin.Spec.Release.Namespace, rel.Version, rel.Chart.Metadata.Version)
	return ctrl.Result{}, nil
}

// ─── helpers ────────────────────────────────────────────────────────────

func (r *Reconciler) touchAndPush(ctx context.Context, p *kpilotv1alpha1.Plugin, msg string) {
	if msg != "" {
		p.Status.Message = msg
	}
	t := now()
	p.Status.LastUpdatedAt = t
	if err := r.Client.Status().Update(ctx, p); err != nil {
		log.Printf("[plugin] status update failed: name=%s err=%v", p.Name, err)
		return
	}
	r.Push.PushPluginStatus(p.Name, &p.Status)
}

func (r *Reconciler) markFailed(ctx context.Context, p *kpilotv1alpha1.Plugin, err error) {
	log.Printf("[plugin] reconcile failed: name=%s err=%v", p.Name, err)
	p.Status.Phase = kpilotv1alpha1.PluginPhaseFailed
	p.Status.Message = err.Error()
	r.touchAndPush(ctx, p, "")
}

// pickInstallPhase distinguishes a fresh install from an upgrade in the
// status field, purely for nicer UI labels.
func pickInstallPhase(s kpilotv1alpha1.PluginStatus) kpilotv1alpha1.PluginPhase {
	if s.HelmRevision == 0 {
		return kpilotv1alpha1.PluginPhaseInstalling
	}
	return kpilotv1alpha1.PluginPhaseUpgrading
}

func valuesHash(yamlText string) string {
	h := sha256.Sum256([]byte(yamlText))
	return hex.EncodeToString(h[:])
}

func now() *metav1.Time {
	t := metav1.NewTime(time.Now())
	return &t
}

func containsFinalizer(set []string, f string) bool {
	for _, s := range set {
		if s == f {
			return true
		}
	}
	return false
}

func removeFinalizer(set []string, f string) []string {
	out := make([]string, 0, len(set))
	for _, s := range set {
		if s != f {
			out = append(out, s)
		}
	}
	return out
}
