// Package volcano carries shared JSON wire shapes for KPilot's
// cluster-side Volcano discovery. Worker probes the cluster, Server
// re-emits the result on a REST endpoint, Frontend renders or routes
// off the booleans. Living here (instead of duplicated in worker +
// server) keeps the JSON tags in sync.
package volcano

// Status answers the question "does this cluster have Volcano, and
// if so where is the scheduler ConfigMap?" — without assuming the
// user installed Volcano via KPilot's plugin registry. Detection is
// cluster-truth: a CRD lookup + a label-free ConfigMap fieldSelector.
//
// Frontend pages that previously gated on `ClusterPlugin.phase ==
// Running` (Scheduler, Overview's scheduler-config card) switch to
// this so user-managed Volcano installs (kubectl apply, helm install
// outside KPilot, sealos preinstall, etc.) work the same.
type Status struct {
	// Installed is true when the Volcano CRD set is present on the
	// cluster — RESTMapping for `scheduling.volcano.sh/v1beta1 Queue`
	// succeeded. False means the CRD isn't registered (admission would
	// reject any Queue create), so every Volcano page should show the
	// NotInstalled empty state.
	Installed bool `json:"installed"`

	// SchedulerConfigMapNamespace is the namespace where the
	// `volcano-scheduler-configmap` ConfigMap was found. Empty when
	// either Installed=false or the scheduler ConfigMap genuinely
	// doesn't exist (Volcano scheduler not deployed but CRDs are).
	//
	// Discovered via `fieldSelector=metadata.name=volcano-scheduler-
	// configmap` on a cluster-wide List — so user release namespaces
	// like volcano-system, kpilot-scheduling, or anything custom all
	// work without hardcoded candidates.
	SchedulerConfigMapNamespace string `json:"schedulerConfigMapNamespace,omitempty"`
}
