package plugin

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/predicate"

	kpilotv1alpha1 "github.com/togettoyou/kpilot/pkg/worker/apis/v1alpha1"
)

// finalizerName ensures the Worker can run `helm uninstall` before the
// cluster API removes the Plugin CRD object.
const finalizerName = "kpilot.io/plugin-cleanup"

// Pusher is the contract the tunnel client implements. Originally it was
// just status, but install-log streaming (worker → server push for each
// Helm log line + reconciler milestones) folded into the same interface
// so the reconciler holds one pointer instead of two.
type Pusher interface {
	PushPluginStatus(crdName string, status *kpilotv1alpha1.PluginStatus)
	PushPluginLog(crdName, level, message string)
	PushPluginLogEnd(crdName string, success bool, summary string)
}

// StatusPusher is kept as an alias for backwards-compat with anyone
// embedding kpilot's plugin package. Internal callers use Pusher.
type StatusPusher = Pusher

// Reconciler reconciles a Plugin CRD by driving its Helm release toward
// the spec. One reconciler instance per Worker.
type Reconciler struct {
	Client client.Client
	Helm   *HelmRunner
	Cache  *ChartCache
	Push   Pusher
	Scheme *runtime.Scheme
}

// reconcileTriggerPredicate filters Watch events so Reconcile fires only on
// real intent changes — not on our own status writes. Without this filter,
// every Status().Update() call inside Reconcile re-queues another Reconcile
// for the same key, racing the informer cache: the requeued run can see a
// stale Phase=Installing snapshot from the pre-Helm status write, fall
// through the AttemptHash gate's "transient phases retry" branch, and run
// InstallOrUpgrade a second time. Helm finds the just-created release →
// runs Upgrade → patches Deployment → rolls a new ReplicaSet → new pod
// fights the old one for the RWO PVC and the install effectively goes
// haywire even though "nothing changed".
//
// We pass through:
//   - Create:                   initial-sync events on controller startup
//                               (worker restart needs a Reconcile per CRD).
//   - Delete:                   release was actually removed; reconciler's
//                               Get returns NotFound → returns cleanly.
//   - Update with new gen:      spec actually changed (handleEnable SSA).
//   - Update setting deletion:  user clicked Disable. Generation doesn't
//                               bump on DeletionTimestamp set, so we have
//                               to detect it explicitly here.
//
// We filter out:
//   - Update with same gen + no-op deletion-timestamp transition: status
//     writes, finalizer additions/removals — we always have an explicit
//     Requeue ready for those when we actually need them.
var reconcileTriggerPredicate = predicate.Funcs{
	CreateFunc: func(_ event.CreateEvent) bool { return true },
	DeleteFunc: func(_ event.DeleteEvent) bool { return true },
	UpdateFunc: func(e event.UpdateEvent) bool {
		if e.ObjectOld == nil || e.ObjectNew == nil {
			return true
		}
		if e.ObjectOld.GetDeletionTimestamp().IsZero() &&
			!e.ObjectNew.GetDeletionTimestamp().IsZero() {
			return true
		}
		return e.ObjectNew.GetGeneration() != e.ObjectOld.GetGeneration()
	},
}

// SetupWithManager wires the reconciler into a controller-runtime Manager.
func (r *Reconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&kpilotv1alpha1.Plugin{}, builder.WithPredicates(reconcileTriggerPredicate)).
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
		r.Push.PushPluginLog(plugin.Name, "info",
			fmt.Sprintf("uninstalling release name=%s ns=%s",
				plugin.Spec.Release.Name, plugin.Spec.Release.Namespace))
		logger := r.helmLoggerFor(plugin.Name)
		if err := r.Helm.Uninstall(plugin.Spec.Release.Name, plugin.Spec.Release.Namespace, logger); err != nil {
			r.Push.PushPluginLogEnd(plugin.Name, false, "uninstall: "+err.Error())
			r.markFailed(ctx, &plugin, fmt.Errorf("uninstall: %w", err))
			// Requeue to retry; finalizer stays so Server sees Failed.
			return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
		}
		r.Push.PushPluginLogEnd(plugin.Name, true, "release removed")
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

	// Compute a fingerprint of the inputs we'd attempt to apply right now.
	// If the last attempt with the SAME fingerprint settled into a
	// terminal state, skip work. This stops hot-looping on permanent
	// failures (e.g. K8s validation errors, chart syntax errors): the
	// reconciler tries once, parks at Phase=Failed, and waits for the
	// user to change spec or disable+re-enable.
	specHash := valuesHash(plugin.Spec.Values)
	currentAttempt := attemptHash(&plugin.Spec, specHash)

	if plugin.Status.AttemptHash == currentAttempt {
		switch plugin.Status.Phase {
		case kpilotv1alpha1.PluginPhaseRunning, kpilotv1alpha1.PluginPhaseFailed:
			// Terminal state for this AttemptHash — Running means
			// already at the desired state, Failed means permanent
			// failure that re-attempting would just thrash on (user
			// must change spec to retry).
			//
			// Re-push the current status before returning. Without
			// this, a Worker that finished install successfully but
			// died before the Phase=Running push made it across the
			// wire would leave Server stuck at Phase=Pending forever:
			// on reconnect, gateway replay re-sends Enable → manager
			// SSAs the CRD (no-op, spec unchanged) → reconciler hits
			// this gate → silently returns. Push is idempotent and
			// cheap (one gRPC frame per reconcile of an already-
			// settled plugin).
			r.Push.PushPluginStatus(plugin.Name, &plugin.Status)
			return ctrl.Result{}, nil
		}
		// Other phases (Pending / Installing / Upgrading) fall through —
		// they're transient states from a prior reconcile that didn't
		// finish (process restart, timeout). Re-attempting is correct.
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
	case kpilotv1alpha1.ChartTypeOCI:
		// Spec.Chart.Repo carries the full oci:// URL — there's no
		// separate "repo + chart name" split for OCI references.
		chartRef = ChartRef{
			OCIRef:  plugin.Spec.Chart.Repo,
			Version: plugin.Spec.Chart.Version,
		}
	case kpilotv1alpha1.ChartTypeLocal:
		path := r.Cache.Path(plugin.Spec.Chart.SHA256)
		if path == "" {
			plugin.Status.AttemptHash = currentAttempt
			r.markFailed(ctx, &plugin, fmt.Errorf("chart cache missing: sha256=%s", plugin.Spec.Chart.SHA256))
			return ctrl.Result{}, nil
		}
		chartRef = ChartRef{LocalPath: path, Name: plugin.Spec.Chart.Name}
	default:
		plugin.Status.AttemptHash = currentAttempt
		r.markFailed(ctx, &plugin, fmt.Errorf("unknown chart type: %q", plugin.Spec.Chart.Type))
		return ctrl.Result{}, nil
	}

	// Record the attempt BEFORE running Helm so the gate above closes
	// even if we crash mid-reconcile and another reconcile picks up.
	plugin.Status.AttemptHash = currentAttempt
	plugin.Status.Phase = pickInstallPhase(plugin.Status)
	r.touchAndPush(ctx, &plugin, "")

	values, err := ParseValues(plugin.Spec.Values)
	if err != nil {
		r.Push.PushPluginLogEnd(plugin.Name, false, "parse values: "+err.Error())
		r.markFailed(ctx, &plugin, err)
		return ctrl.Result{}, nil
	}

	// Milestones before / after each long-running step so the UI shows
	// progress even when Helm's own logger is quiet (chart pull is
	// silent on cache hit, for example).
	r.Push.PushPluginLog(plugin.Name, "info",
		fmt.Sprintf("loading chart type=%s version=%s",
			plugin.Spec.Chart.Type, plugin.Spec.Chart.Version))
	chart, err := r.Helm.LoadChart(chartRef)
	if err != nil {
		r.Push.PushPluginLogEnd(plugin.Name, false, "load chart: "+err.Error())
		r.markFailed(ctx, &plugin, fmt.Errorf("load chart: %w", err))
		return ctrl.Result{}, nil
	}
	r.Push.PushPluginLog(plugin.Name, "info",
		fmt.Sprintf("chart loaded name=%s version=%s",
			chart.Metadata.Name, chart.Metadata.Version))

	verb := "install"
	if plugin.Status.HelmRevision > 0 {
		verb = "upgrade"
	}
	r.Push.PushPluginLog(plugin.Name, "info",
		fmt.Sprintf("helm %s starting release=%s ns=%s (waiting for resources to be ready, up to 10m)",
			verb, plugin.Spec.Release.Name, plugin.Spec.Release.Namespace))

	logger := r.helmLoggerFor(plugin.Name)
	rel, err := r.Helm.InstallOrUpgrade(
		plugin.Spec.Release.Name,
		plugin.Spec.Release.Namespace,
		chart,
		values,
		logger,
	)
	if err != nil {
		r.Push.PushPluginLogEnd(plugin.Name, false, "helm "+verb+": "+err.Error())
		r.markFailed(ctx, &plugin, fmt.Errorf("helm: %w", err))
		return ctrl.Result{}, nil
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
	r.Push.PushPluginLogEnd(plugin.Name, true,
		fmt.Sprintf("running rev=%d ver=%s", rel.Version, rel.Chart.Metadata.Version))
	log.Printf("[plugin] release reconciled: name=%s ns=%s rev=%d ver=%s",
		plugin.Spec.Release.Name, plugin.Spec.Release.Namespace, rel.Version, rel.Chart.Metadata.Version)
	return ctrl.Result{}, nil
}

// helmLoggerFor returns a Helm SDK logger that forwards each progress
// line as a PluginLogChunk. Helm's logger gets called with format +
// args (e.g. "creating %d resource(s)"); we render it eagerly so the
// wire payload is plain text.
func (r *Reconciler) helmLoggerFor(crdName string) Logger {
	return func(format string, args ...interface{}) {
		r.Push.PushPluginLog(crdName, "info", fmt.Sprintf(format, args...))
	}
}

// ─── helpers ────────────────────────────────────────────────────────────

// touchAndPush updates the CRD's status subresource and pushes the result
// back to Server. On 409 (concurrent modification — typically the manager
// adding a finalizer mid-reconcile) we refetch and retry once with the
// caller's intended status fields applied to the fresh resource version.
// Without that retry the in-memory ObservedValuesHash etc. would be lost
// and the next reconcile would needlessly run Helm again.
func (r *Reconciler) touchAndPush(ctx context.Context, p *kpilotv1alpha1.Plugin, msg string) {
	if msg != "" {
		p.Status.Message = msg
	}
	p.Status.LastUpdatedAt = now()
	if err := r.Client.Status().Update(ctx, p); err != nil {
		if apierrors.IsConflict(err) {
			// Snapshot the status we wanted to land, refetch, and re-apply.
			pending := p.Status
			var fresh kpilotv1alpha1.Plugin
			if getErr := r.Client.Get(ctx, client.ObjectKey{Name: p.Name}, &fresh); getErr == nil {
				fresh.Status = pending
				if upErr := r.Client.Status().Update(ctx, &fresh); upErr == nil {
					*p = fresh // give the caller the up-to-date copy
					r.Push.PushPluginStatus(p.Name, &p.Status)
					return
				} else {
					log.Printf("[plugin] status update retry failed: name=%s err=%v", p.Name, upErr)
				}
			} else {
				log.Printf("[plugin] status refetch failed: name=%s err=%v", p.Name, getErr)
			}
			return
		}
		log.Printf("[plugin] status update failed: name=%s err=%v", p.Name, err)
		return
	}
	r.Push.PushPluginStatus(p.Name, &p.Status)
}

func (r *Reconciler) markFailed(ctx context.Context, p *kpilotv1alpha1.Plugin, err error) {
	log.Printf("[plugin] reconcile failed: name=%s err=%v", p.Name, err)
	p.Status.Phase = kpilotv1alpha1.PluginPhaseFailed
	// Cap the message — Helm errors can be huge (full release manifests in
	// some failure modes) and we don't want to bloat etcd or every poll
	// response from the per-cluster page.
	p.Status.Message = capMessage(err.Error())
	r.touchAndPush(ctx, p, "")
}

const maxStatusMessageBytes = 4096

func capMessage(s string) string {
	if len(s) <= maxStatusMessageBytes {
		return s
	}
	return s[:maxStatusMessageBytes] + "\n…(truncated)"
}

// pickInstallPhase distinguishes a fresh install from an upgrade in the
// status field, purely for nicer UI labels.
func pickInstallPhase(s kpilotv1alpha1.PluginStatus) kpilotv1alpha1.PluginPhase {
	if s.HelmRevision == 0 {
		return kpilotv1alpha1.PluginPhaseInstalling
	}
	return kpilotv1alpha1.PluginPhaseUpgrading
}

// attemptHash fingerprints everything Helm would actually act on for a
// reconcile. If two reconciles produce the same attemptHash, they would
// behave identically — so the second one can short-circuit when the
// first ended in a terminal Phase. Pre-computed valuesHash is passed in
// to avoid re-parsing the YAML twice in one reconcile.
func attemptHash(spec *kpilotv1alpha1.PluginSpec, valuesHashHex string) string {
	parts := []string{
		string(spec.Chart.Type),
		spec.Chart.Repo,
		spec.Chart.Name,
		spec.Chart.Version,
		spec.Chart.SHA256,
		spec.Release.Name,
		spec.Release.Namespace,
		valuesHashHex,
	}
	h := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(h[:])
}

// valuesHash returns a content-based hash of the values YAML, canonical
// across whitespace / key-order differences. CodeMirror reformats can
// trigger byte-level changes that don't actually alter Helm input — by
// parsing and re-marshaling we collapse those to the same hash, so the
// reconciler's no-op gate isn't fooled into running needless upgrades.
func valuesHash(yamlText string) string {
	v, err := ParseValues(yamlText)
	if err != nil {
		// Fall back to raw bytes; this hash will only ever be compared to
		// itself if Helm install succeeds (in which case ParseValues must
		// have worked there too), so this branch is mostly defensive.
		h := sha256.Sum256([]byte(yamlText))
		return hex.EncodeToString(h[:])
	}
	canonical, err := jsonMarshalSortedKeys(v)
	if err != nil {
		h := sha256.Sum256([]byte(yamlText))
		return hex.EncodeToString(h[:])
	}
	h := sha256.Sum256(canonical)
	return hex.EncodeToString(h[:])
}

// jsonMarshalSortedKeys serializes a Go value into JSON with map keys
// sorted at every level, giving a stable byte representation regardless
// of the order in which keys were specified in the source YAML. encoding
// /json already sorts map[string]any keys; the YAML loader produces this
// shape throughout, so we just delegate.
func jsonMarshalSortedKeys(v any) ([]byte, error) {
	return json.Marshal(v)
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
