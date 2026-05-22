package tunnel

// PluginCommand / PluginSpec / ChartSource — kept in this package
// because pkg/worker/plugin imports tunnel and references these
// types throughout (Manager.Handle, Reconciler). In v1 the types
// also doubled as wire shapes; in v2 the wire is pbv2.PluginCommand
// and these stay as the transport-agnostic shape the plugin
// reconciler consumes.
//
// The dispatcher in cmd/worker/main.go reads the v2 wire frame +
// optional chart blob bytes from the yamux stream, converts into
// PluginCommand, and calls plugin.Manager.Handle.

type PluginCommand struct {
	Action    string // "enable" or "disable"
	CrdName   string
	Spec      *PluginSpec
	ChartBlob []byte
}

type PluginSpec struct {
	// PluginId matches the v1 proto field name (which the existing
	// plugin/manager.go references). Go field name kept as-is to
	// avoid touching the plugin reconciler.
	PluginId         string
	DisplayName      string
	Chart            *ChartSource
	ReleaseName      string
	ReleaseNamespace string
	Values           string
}

type ChartSource struct {
	Type    string
	Repo    string
	Name    string
	Version string
	Sha256  string
	HasBlob bool
}
