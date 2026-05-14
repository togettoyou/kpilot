// Package vgpu carries the shared JSON wire shape for KPilot's vGPU
// snapshot: Worker proxy projects it from Volcano annotations, Server
// re-emits it on REST endpoints, Frontend renders it. Putting the
// types here (vs duplicating in worker + server) keeps the JSON tags
// in sync and lets us evolve the schema in one place.
package vgpu

// Card is one physical GPU on a node, with the per-pod usage stack
// applied on top. UUID is the stable identity across pod reschedules
// and node reboots (the device-plugin re-emits it on every register).
type Card struct {
	// Index is the position in the node-register annotation. The
	// scheduler uses this as a kubelet-facing device index when
	// allocating, so the UI surfaces it for parity with `nvidia-smi`.
	Index int `json:"index"`
	// UUID matches `GPU-...` reported by nvidia-smi.
	UUID string `json:"uuid"`
	// Type is the GPU model name (e.g. "NVIDIA A100-SXM4-80GB").
	Type string `json:"type"`
	// Number is the virtual-split count the device-plugin advertises
	// for this physical card. Each slice is a schedulable unit; users
	// claim 1+ slices via `volcano.sh/vgpu-number`.
	Number int `json:"number"`
	// Memory is the physical card's total memory in MiB.
	Memory int `json:"memory"`
	// Health mirrors the device-plugin's NVML check; false cards still
	// appear in the snapshot (so users can see "this card went bad")
	// but the scheduler will avoid them.
	Health bool `json:"health"`
	// SharingMode is the device-plugin's vGPU controller: usually
	// "hami-core", occasionally "mig" or a vendor-specific tag.
	SharingMode string `json:"sharingMode"`
	// Used* fields are sums across every Pod allocation against this
	// card. Cores are a percentage (0–100); memory is MiB.
	UsedMemory int `json:"usedMemory"`
	UsedCores  int `json:"usedCores"`
	UsedNumber int `json:"usedNumber"`
	// Pods is the per-pod breakdown — same numbers split out so the
	// UI can show "who is using this card".
	Pods []PodUsage `json:"pods,omitempty"`
}

// PodUsage is one Pod's slice on one Card. A Pod can appear multiple
// times if it requested multiple slices on the same card, or on
// multiple cards.
type PodUsage struct {
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`
	UsedMemory int    `json:"usedMemory"`
	UsedCores  int    `json:"usedCores"`
}

// Node aggregates every Card the device-plugin registered for one
// kubelet node. Healthy is false when ANY card on the node is
// unhealthy — the UI can dig into Cards[] to see which one.
type Node struct {
	Name        string `json:"name"`
	Healthy     bool   `json:"healthy"`
	Cards       []Card `json:"cards"`
	TotalMemory int    `json:"totalMemory"`
	UsedMemory  int    `json:"usedMemory"`
	// TotalNumber / UsedNumber are slice counts, not card counts —
	// e.g. a node with 8 cards × 10-way split has TotalNumber=80.
	TotalNumber int `json:"totalNumber"`
	UsedNumber  int `json:"usedNumber"`
}

// Snapshot is the full cluster view. TotalCards counts physical cards
// (sum of len(Node.Cards)); TotalSlots counts virtual slices (sum of
// Card.Number). UI shows both because "I have 32 cards, 256 slots" is
// the natural way to size a cluster.
type Snapshot struct {
	Nodes       []Node `json:"nodes"`
	TotalCards  int    `json:"totalCards"`
	TotalMemory int    `json:"totalMemory"`
	UsedMemory  int    `json:"usedMemory"`
	TotalSlots  int    `json:"totalSlots"`
	UsedSlots   int    `json:"usedSlots"`
}
