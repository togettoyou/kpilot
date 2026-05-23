// Package diag is a zero-dependency self-monitoring layer for Go
// processes. It collects Go runtime metrics, exposes pprof endpoints,
// and lets the host program plug in business-specific collectors —
// all over a local http.ServeMux that the host binds wherever it wants
// (typically 127.0.0.1:0).
//
// The package depends only on the standard library so it can be lifted
// out of this repo into its own module without rework.
package diag

// Collector is the interface for a custom (host-supplied) metric source.
// Collect is called once per Snapshot — typically at 1 Hz from a single
// goroutine — and MUST be safe to call from that one goroutine without
// the host holding any of its own locks (otherwise Snapshot can stall
// under contention). Implementations are responsible for their own
// internal thread safety against any goroutines that mutate the
// underlying counters concurrently.
//
// Collect returns a flat JSON-shaped map keyed by metric name. Values
// should be scalars, slices, or maps of those — anything json.Marshal
// can handle. Returning nil is fine (the collector key is then omitted).
type Collector interface {
	Name() string
	Collect() map[string]any
}
