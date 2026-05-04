package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ChartType selects how the Worker resolves the Helm chart at install time.
//
//   - "repo"  → Helm pulls the chart from `Spec.Chart.Repo` (HTTPS + index.yaml)
//     using `Spec.Chart.Name` as the chart name within that repo.
//   - "local" → Worker reads from /var/lib/kpilot/charts/<sha256>.tgz, which
//     is populated by the first PluginCommand carrying `blob` for that sha.
//     If the cache is missing on reconcile, the Plugin enters phase=Failed
//     until the user re-clicks "enable" (which re-pushes the bytes).
//   - "oci"   → Helm pulls from an OCI registry. `Spec.Chart.Repo` holds
//     the full `oci://host/path/chart` reference; `Spec.Chart.Name` is
//     unused (an OCI chart reference doesn't split into repo + name).
type ChartType string

const (
	ChartTypeRepo  ChartType = "repo"
	ChartTypeLocal ChartType = "local"
	ChartTypeOCI   ChartType = "oci"
)

// ChartSource describes WHERE the Helm chart comes from. Note that the .tgz
// bytes themselves are NEVER stored in the CRD — etcd's per-object size
// limit makes that fragile. Bytes flow Server→Worker over gRPC and live on
// Worker's local PVC; the CRD only carries the sha256 reference.
type ChartSource struct {
	Type ChartType `json:"type"`

	// Type=repo
	// +optional
	Repo string `json:"repo,omitempty"`

	// Type=repo: Helm chart name. Type=local: human-facing label only.
	// +optional
	Name string `json:"name,omitempty"`

	// Type=repo: Helm chart version. Type=local: human-facing label only.
	// +optional
	Version string `json:"version,omitempty"`

	// Type=local: digest of the .tgz; Worker uses it to locate the cached
	// chart on disk and to verify integrity on first cache write.
	// +optional
	SHA256 string `json:"sha256,omitempty"`
}

// ReleaseSpec captures Helm's release identity. Both fields are required
// at install time; the namespace is created by the reconciler if missing.
type ReleaseSpec struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

// PluginSpec is the desired state of a Plugin. The Server fills it from
// the registry entry merged with the per-cluster overrides (values,
// version, namespace) at the moment the user clicks "enable".
type PluginSpec struct {
	// PluginID is the Server-side registry row id, kept here purely for
	// traceability. The reconciler doesn't need it; logs do.
	// +optional
	PluginID string `json:"pluginId,omitempty"`

	// DisplayName is shown in `kubectl get plugins -o wide` so operators
	// don't have to cross-reference the Server UI.
	// +optional
	DisplayName string `json:"displayName,omitempty"`

	Chart   ChartSource `json:"chart"`
	Release ReleaseSpec `json:"release"`

	// Values is the YAML text the reconciler will pass to Helm as the
	// release values. Kept as a string (not a structured map) so users see
	// the same bytes they pasted, comments and all.
	// +optional
	Values string `json:"values,omitempty"`
}

// PluginPhase tracks the lifecycle of the Helm release driven by this CRD.
// "Disabled" is not a CRD phase — it's a Server-only state that exists
// when no CRD is present.
type PluginPhase string

const (
	PluginPhasePending      PluginPhase = "Pending"      // CRD created, work not started
	PluginPhaseInstalling   PluginPhase = "Installing"   // first-time `helm install` running
	PluginPhaseUpgrading    PluginPhase = "Upgrading"    // `helm upgrade` running
	PluginPhaseRunning      PluginPhase = "Running"      // last action succeeded
	PluginPhaseFailed       PluginPhase = "Failed"       // last action failed; see status.message
	PluginPhaseUninstalling PluginPhase = "Uninstalling" // `helm uninstall` running
)

// PluginStatus is the observed state. Updated only by the reconciler.
type PluginStatus struct {
	// +optional
	Phase PluginPhase `json:"phase,omitempty"`

	// Message carries the most recent Helm error or progress string.
	// +optional
	Message string `json:"message,omitempty"`

	// ObservedVersion is the chart version Helm actually reports running,
	// not the version requested in spec — used to detect drift.
	// +optional
	ObservedVersion string `json:"observedVersion,omitempty"`

	// ObservedValuesHash is sha256 of the values YAML actually applied.
	// Compared against the spec's hash to detect spec/release drift.
	// +optional
	ObservedValuesHash string `json:"observedValuesHash,omitempty"`

	// AttemptHash is a fingerprint of the inputs the reconciler last
	// tried to apply (chart source + release identity + values). It's
	// the latch the reconciler uses to avoid hot-looping on a permanent
	// failure: if Phase=Failed and AttemptHash equals the current
	// inputs' hash, the reconciler skips work entirely. The user
	// triggers a retry by changing spec or by disable+re-enable.
	// +optional
	AttemptHash string `json:"attemptHash,omitempty"`

	// +optional
	HelmRevision int32 `json:"helmRevision,omitempty"`

	// +optional
	InstalledAt *metav1.Time `json:"installedAt,omitempty"`

	// +optional
	LastUpdatedAt *metav1.Time `json:"lastUpdatedAt,omitempty"`

	// Conditions exposes the standard K8s condition machinery (Ready,
	// Available, etc.) so kubectl describe shows transition history.
	// +optional
	// +patchMergeKey=type
	// +patchStrategy=merge
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Cluster,shortName=kpl
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Source",type=string,JSONPath=`.spec.chart.type`
// +kubebuilder:printcolumn:name="Namespace",type=string,JSONPath=`.spec.release.namespace`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Version",type=string,JSONPath=`.status.observedVersion`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// Plugin is a cluster-scoped CRD describing a Helm release the kpilot
// Worker should reconcile. One Plugin per logical plugin per cluster.
type Plugin struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   PluginSpec   `json:"spec,omitempty"`
	Status PluginStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// PluginList contains a list of Plugin resources.
type PluginList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Plugin `json:"items"`
}
