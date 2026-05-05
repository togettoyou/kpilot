package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// HAMI annotation keys. HAMI changes its on-the-wire format across
// versions; we look at both schemas (legacy colon/comma encoded vs newer
// JSON) before giving up. Documented at
// https://project-hami.io/docs/core-concepts/gpu-virtualization.
const (
	// hamiNodeRegisterAnnotation lists the physical GPUs a node reports
	// to the HAMI scheduler. UUID, vGPU slot count, memory, cores, model
	// name, NUMA, health, and (newer schema) device index + mode.
	hamiNodeRegisterAnnotation = "hami.io/node-nvidia-register"
	// hamiPodAllocAnnotation carries the scheduler's per-container
	// per-card allocation: which physical GPU UUIDs were chosen and how
	// much memory / cores got carved out of each. Lets us attribute
	// utilization to specific cards rather than just node totals.
	hamiPodAllocAnnotation = "hami.io/vgpu-devices-allocated"
	// hamiResourcePoolAnnotation + hamiFlavorAnnotation are HAMI
	// scheduler hints — surfaced in the Tasks UI so operators can see
	// which pool / flavor a pod was scheduled under.
	hamiResourcePoolAnnotation = "hami.io/resource-pool"
	hamiFlavorAnnotation       = "hami.io/flavor"
	// nvidiaPriorityAnnotation is HAMI's per-container priority knob
	// (0 / 1 / 2 — low / medium / high). Joined as comma-separated
	// per-container; we surface the first/dominant value to keep the
	// Tasks table compact.
	nvidiaPriorityAnnotation = "nvidia.com/priority"
	// HAMI's encoded list separators. : between devices, , between
	// fields of one device, ; between containers of one pod (only used
	// in the pod-side annotation).
	hamiDeviceSep    = ":"
	hamiFieldSep     = ","
	hamiContainerSep = ";"
)

// Standard application-name labels we look at, in priority order. Most
// charts set app.kubernetes.io/name (recommended labels); workloads
// without that fall back to plain "app". Empty string when neither is
// set — the UI just shows a dash.
var appNameLabels = []string{
	"app.kubernetes.io/name",
	"app",
}

// hamiDevice mirrors one entry of the node-side register. Field tags
// match HAMI's snake-cased JSON schema; the legacy colon/comma format
// is parsed positionally instead.
type hamiDevice struct {
	ID      string `json:"id"`
	Count   int32  `json:"count"`           // vGPU slot count after slicing
	DevMem  int32  `json:"devmem"`          // physical memory MB (per card, total)
	DevCore int32  `json:"devcore"`         // compute percent total (typically 100)
	Type    string `json:"type"`            // GPU model name
	NUMA    int32  `json:"numa"`
	Health  bool   `json:"health"`
	// Mode comes from HAMI's newer 9-field encoded format / JSON
	// schema. Values: "hami-core" (default vGPU split), "mig" (NVIDIA
	// MIG instance), and a few less common ones. Empty when running
	// on older HAMI (7-field encoding) — UI then just shows a dash.
	Mode string `json:"mode,omitempty"`
}

// gpuNodeSummary is the per-node payload Server forwards to the UI.
type gpuNodeSummary struct {
	Name        string           `json:"name"`
	Status      string           `json:"status"`
	Devices     []hamiDevice     `json:"devices"`     // physical cards (HAMI annotation only)
	Capacity    map[string]int64 `json:"capacity"`    // nvidia.com/* node-level totals
	Allocatable map[string]int64 `json:"allocatable"` // same, after reservations
	Used        map[string]int64 `json:"used"`        // sum of pod requests on this node
	// Cards is the per-physical-card breakdown — derived from each pod's
	// hami.io/vgpu-devices-allocated annotation. Only populated when HAMI
	// gave us the node device list. Empty on standard NVIDIA-device-plugin
	// installs (frontend then falls back to the node-level Used + flat
	// Pods list).
	Cards []gpuCardSummary `json:"cards"`
	Pods  []gpuPodSummary  `json:"pods"`
}

// gpuCardSummary aggregates pods running on one specific physical GPU,
// keyed by the device's UUID. Each entry shows actual scheduler-side
// allocations (post-split) rather than user requests, which lines up with
// how HAMI's own UI reports utilization.
type gpuCardSummary struct {
	UUID      string         `json:"uuid"`
	Type      string         `json:"type"`
	Mode      string         `json:"mode,omitempty"` // hami-core / mig / etc, when reported
	Health    bool           `json:"health"`
	NUMA      int32          `json:"numa"`
	Slots     int32          `json:"slots"`     // vGPU slot capacity (== device.Count)
	DevMem    int32          `json:"devmem"`    // physical memory MB
	DevCore   int32          `json:"devcore"`   // total compute %
	UsedSlots int32          `json:"usedSlots"` // how many vGPU slots taken
	UsedMem   int32          `json:"usedMem"`   // sum of mem allocated to pods
	UsedCores int32          `json:"usedCores"` // sum of cores allocated to pods
	Pods      []gpuPodOnCard `json:"pods"`
}

// gpuPodOnCard is one pod's allocation on a single physical GPU. A pod
// requesting multiple cards shows up once per card with its per-card
// share. Container-level breakdown is omitted to keep the UI simple;
// for "this pod's full footprint", the node-level Pods list still
// carries the user request.
type gpuPodOnCard struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Mem       int32  `json:"mem"`   // MB allocated to this pod on this card
	Cores     int32  `json:"cores"` // % allocated to this pod on this card
}

// gpuPodSummary is the legacy node-level pod entry. Always populated for
// any pod requesting nvidia.com/* on a GPU node, regardless of whether
// HAMI is installed — gives us a usable fallback view when the
// allocation annotation is absent.
//
// Extra metadata fields (CreatedAt / AppName / ResourcePool / Flavor /
// Priority) line up with HAMi-WebUI's container.proto schema so the
// Tasks page can give operators the same context: when did this land,
// which app/pool/priority does it belong to. Each is optional —
// emitted as "" when the source label/annotation is missing rather
// than tripping up JSON unmarshal on the frontend.
type gpuPodSummary struct {
	Namespace    string           `json:"namespace"`
	Name         string           `json:"name"`
	Phase        string           `json:"phase"`
	Requests     map[string]int64 `json:"requests"`
	CreatedAt    string           `json:"createdAt,omitempty"`    // RFC3339; from PodScheduled condition
	StartedAt    string           `json:"startedAt,omitempty"`    // RFC3339; from PodInitialized condition
	AppName      string           `json:"appName,omitempty"`      // label app.kubernetes.io/name or app
	ResourcePool string           `json:"resourcePool,omitempty"` // hami.io/resource-pool
	Flavor       string           `json:"flavor,omitempty"`       // hami.io/flavor
	Priority     string           `json:"priority,omitempty"`     // nvidia.com/priority (first value)
}

// gpuSummary builds the cluster-wide GPU view. Always returns a top-level
// JSON array (possibly empty) so the frontend renders an empty state
// rather than choking on null.
//
// Reads from the local snapshot cache, NOT a fresh API server List —
// each call is a few microseconds + one slice copy regardless of how
// many users are polling the GPU page in parallel. Watch events keep
// the cache live; the data is at most ~hundreds of milliseconds stale.
func (p *Proxy) gpuSummary(ctx context.Context) *proto.ResourceResponse {
	_ = ctx // cache reads are non-blocking; ctx is here for future use

	nodes, err := p.snap.Nodes()
	if err != nil {
		return fail(fmt.Sprintf("snapshot nodes: %v", err))
	}

	byNode := make(map[string]*gpuNodeSummary)
	// cardIndex helps the pod loop find a card's summary record by UUID
	// without re-scanning every node's Cards slice. Keyed by UUID alone
	// because HAMI UUIDs are globally unique (it embeds the GPU's true
	// hardware UUID).
	cardIndex := map[string]*gpuCardSummary{}
	for _, n := range nodes {
		devices := parseHAMIDevices(n.Annotations)
		cap := extractGPUResources(n.Status.Capacity)
		alloc := extractGPUResources(n.Status.Allocatable)
		if len(devices) == 0 && len(cap) == 0 {
			continue // not a GPU node by either signal
		}
		summary := &gpuNodeSummary{
			Name:        n.Name,
			Status:      derivedNodeStatus(n),
			Devices:     devices,
			Capacity:    cap,
			Allocatable: alloc,
			Used:        map[string]int64{},
		}
		for j := range devices {
			d := devices[j]
			card := gpuCardSummary{
				UUID:    d.ID,
				Type:    d.Type,
				Mode:    d.Mode,
				Health:  d.Health,
				NUMA:    d.NUMA,
				Slots:   d.Count,
				DevMem:  d.DevMem,
				DevCore: d.DevCore,
			}
			summary.Cards = append(summary.Cards, card)
			// Index by UUID — append-after-copy means we re-fetch from
			// the slice for mutation, not from the local copy.
			cardIndex[d.ID] = &summary.Cards[len(summary.Cards)-1]
		}
		byNode[n.Name] = summary
	}

	pods, err := p.snap.Pods()
	if err != nil {
		return fail(fmt.Sprintf("snapshot pods: %v", err))
	}
	for _, pod := range pods {
		if pod.Spec.NodeName == "" {
			continue
		}
		node, ok := byNode[pod.Spec.NodeName]
		if !ok {
			continue
		}
		if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
			// Terminated pods don't hold resources from the scheduler's
			// perspective. Skip both the request rollup and the per-card
			// attribution.
			continue
		}

		req := podGPURequests(pod)
		// Per-card attribution: walk the HAMI allocation annotation and
		// land each container's slice on the right card. Pods without
		// the annotation (vanilla NVIDIA device plugin or pre-HAMI-2.x)
		// won't show up in card-level views — fall back to the node-
		// level summary for them.
		allocs := parsePodAllocations(pod)
		for _, a := range allocs {
			card, ok := cardIndex[a.UUID]
			if !ok {
				continue // pod's annotation references an UUID not on any node we know about
			}
			card.UsedSlots++
			card.UsedMem += a.Mem
			card.UsedCores += a.Cores
			card.Pods = append(card.Pods, gpuPodOnCard{
				Namespace: pod.Namespace,
				Name:      pod.Name,
				Mem:       a.Mem,
				Cores:     a.Cores,
			})
		}

		if len(req) == 0 && len(allocs) == 0 {
			continue
		}
		for k, v := range req {
			node.Used[k] += v
		}
		node.Pods = append(node.Pods, gpuPodSummary{
			Namespace:    pod.Namespace,
			Name:         pod.Name,
			Phase:        string(pod.Status.Phase),
			Requests:     req,
			CreatedAt:    podCreatedAt(pod),
			StartedAt:    podStartedAt(pod),
			AppName:      podAppName(pod),
			ResourcePool: pod.Annotations[hamiResourcePoolAnnotation],
			Flavor:       pod.Annotations[hamiFlavorAnnotation],
			Priority:     podPriority(pod),
		})
	}

	out := make([]*gpuNodeSummary, 0, len(byNode))
	for _, n := range byNode {
		out = append(out, n)
	}
	sortNodesByName(out)

	data, err := json.Marshal(out)
	if err != nil {
		return fail(fmt.Sprintf("marshal: %v", err))
	}
	return &proto.ResourceResponse{Success: true, Data: data}
}

// parseHAMIDevices reads the per-card register from a node's annotations.
// Tries the legacy colon/comma encoding first (HAMI <= 2.4-ish) and falls
// through to JSON for newer versions. Either failure mode (missing key,
// unparseable string) returns nil so the page degrades to node-level
// info instead of erroring.
func parseHAMIDevices(annotations map[string]string) []hamiDevice {
	raw, ok := annotations[hamiNodeRegisterAnnotation]
	if !ok || raw == "" {
		return nil
	}
	if devices := decodeHAMIDevicesEncoded(raw); len(devices) > 0 {
		return devices
	}
	var devices []hamiDevice
	if err := json.Unmarshal([]byte(raw), &devices); err != nil {
		return nil
	}
	return devices
}

// decodeHAMIDevicesEncoded parses the colon/comma format HAMI uses pre-JSON.
// Layout per device (7 or 9 fields, : separated):
//
//	UUID,count,memory,cores,type,numa,health                        (7 fields)
//	UUID,count,memory,cores,type,numa,health,index,mode             (9 fields, newer)
//
// We pull mode out of the 9-field variant when present so the UI can
// distinguish hami-core / mig / etc; index isn't surfaced today.
// Returns nil on any unrecognized structure so callers can fall through
// to JSON parsing.
func decodeHAMIDevicesEncoded(raw string) []hamiDevice {
	if !strings.Contains(raw, hamiDeviceSep) {
		return nil
	}
	var out []hamiDevice
	for _, entry := range strings.Split(raw, hamiDeviceSep) {
		entry = strings.TrimSpace(entry)
		if entry == "" || !strings.Contains(entry, hamiFieldSep) {
			continue
		}
		f := strings.Split(entry, hamiFieldSep)
		if len(f) < 7 {
			// Bail entirely rather than emit a partial device — the JSON
			// branch may still succeed.
			return nil
		}
		count, err1 := strconv.ParseInt(f[1], 10, 32)
		mem, err2 := strconv.ParseInt(f[2], 10, 32)
		cores, err3 := strconv.ParseInt(f[3], 10, 32)
		numa, err4 := strconv.Atoi(f[5])
		health, err5 := strconv.ParseBool(f[6])
		if err1 != nil || err2 != nil || err3 != nil || err4 != nil || err5 != nil {
			return nil
		}
		dev := hamiDevice{
			ID:      f[0],
			Count:   int32(count),
			DevMem:  int32(mem),
			DevCore: int32(cores),
			Type:    f[4],
			NUMA:    int32(numa),
			Health:  health,
		}
		if len(f) >= 9 {
			dev.Mode = f[8]
		}
		out = append(out, dev)
	}
	return out
}

// hamiPodDeviceAlloc is one (pod, container, physical-card) tuple from
// the pod-side allocation annotation. Multiple per pod when the pod
// requested multiple cards, or when it has multiple containers each
// holding a card.
type hamiPodDeviceAlloc struct {
	UUID  string
	Type  string
	Mem   int32
	Cores int32
}

// parsePodAllocations decodes hami.io/vgpu-devices-allocated into a flat
// list of (UUID, mem, cores) tuples — the scheduler's view of where this
// pod's GPU shares actually landed.
//
// Format (each container's chunk is an entry, ; separated):
//
//	<UUID>,<type>,<mem>,<cores>:<UUID>,<type>,<mem>,<cores>;<next container>
//
// Empty containers (no device) appear as an empty chunk; we just skip
// them. Malformed entries inside a non-empty chunk are dropped silently
// — better to render the cards we DID parse than fail-closed on a single
// weird annotation.
func parsePodAllocations(pod *corev1.Pod) []hamiPodDeviceAlloc {
	raw, ok := pod.Annotations[hamiPodAllocAnnotation]
	if !ok || raw == "" {
		return nil
	}
	var out []hamiPodDeviceAlloc
	for _, container := range strings.Split(raw, hamiContainerSep) {
		if container == "" {
			continue
		}
		for _, dev := range strings.Split(container, hamiDeviceSep) {
			dev = strings.TrimSpace(dev)
			if dev == "" || !strings.Contains(dev, hamiFieldSep) {
				continue
			}
			f := strings.Split(dev, hamiFieldSep)
			if len(f) < 4 {
				continue
			}
			mem, _ := strconv.ParseInt(f[2], 10, 32)
			cores, _ := strconv.ParseInt(f[3], 10, 32)
			// HAMI writes "cores=0" to mean "unrestricted / give the
			// whole card". Mirror their UI's convention of treating
			// that as 100% so the totals don't look misleadingly low.
			if cores == 0 {
				cores = 100
			}
			out = append(out, hamiPodDeviceAlloc{
				UUID:  f[0],
				Type:  f[1],
				Mem:   int32(mem),
				Cores: int32(cores),
			})
		}
	}
	return out
}

// extractGPUResources picks out nvidia.com/* extended resources from a
// ResourceList. Other accelerator vendors (amd.com, google.com/tpu, etc.)
// can be added here when we extend support.
func extractGPUResources(rl corev1.ResourceList) map[string]int64 {
	out := map[string]int64{}
	for name, qty := range rl {
		if !isGPUResourceName(string(name)) {
			continue
		}
		out[string(name)] = qty.Value()
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// podGPURequests aggregates a Pod's GPU resource requests. Init containers
// run serially and don't add to the steady-state request, so we take the
// max across them and add to the regular containers' sum (this matches
// the K8s scheduler's effective-request calculation).
func podGPURequests(pod *corev1.Pod) map[string]int64 {
	regular := map[string]int64{}
	for i := range pod.Spec.Containers {
		for name, qty := range pod.Spec.Containers[i].Resources.Requests {
			if !isGPUResourceName(string(name)) {
				continue
			}
			regular[string(name)] += qty.Value()
		}
	}
	initMax := map[string]int64{}
	for i := range pod.Spec.InitContainers {
		for name, qty := range pod.Spec.InitContainers[i].Resources.Requests {
			if !isGPUResourceName(string(name)) {
				continue
			}
			v := qty.Value()
			if v > initMax[string(name)] {
				initMax[string(name)] = v
			}
		}
	}
	for k, v := range initMax {
		if v > regular[k] {
			regular[k] = v
		}
	}
	if len(regular) == 0 {
		return nil
	}
	return regular
}

func isGPUResourceName(name string) bool {
	return strings.HasPrefix(name, "nvidia.com/")
}

// podCreatedAt returns the RFC3339 timestamp of when the scheduler
// bound this pod to a node. We use PodScheduled rather than
// CreationTimestamp because the latter ticks when the API object was
// created (could be much earlier than scheduling for queued pods);
// PodScheduled is what HAMi-WebUI shows as create_time too.
func podCreatedAt(pod *corev1.Pod) string {
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionTrue {
			return c.LastTransitionTime.UTC().Format(time.RFC3339)
		}
	}
	return ""
}

// podStartedAt returns when containers first transitioned to running.
// Falls back to pod.Status.StartTime which is set once the kubelet
// admits the pod — close enough for the Tasks page's "duration so far"
// calculation.
func podStartedAt(pod *corev1.Pod) string {
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodInitialized && c.Status == corev1.ConditionTrue {
			return c.LastTransitionTime.UTC().Format(time.RFC3339)
		}
	}
	if pod.Status.StartTime != nil {
		return pod.Status.StartTime.UTC().Format(time.RFC3339)
	}
	return ""
}

// podAppName picks the most-likely "application" label, in priority
// order. Empty string when nothing matches — UI shows a dash.
func podAppName(pod *corev1.Pod) string {
	for _, key := range appNameLabels {
		if v, ok := pod.Labels[key]; ok && v != "" {
			return v
		}
	}
	return ""
}

// podPriority returns the first comma-separated value of the
// nvidia.com/priority annotation. HAMi can write per-container
// priorities ("0,1,2" for a 3-container pod); the Tasks UI surfaces
// the first as the dominant priority since most pods only have one
// GPU container anyway. Empty when the annotation is missing.
func podPriority(pod *corev1.Pod) string {
	raw, ok := pod.Annotations[nvidiaPriorityAnnotation]
	if !ok || raw == "" {
		return ""
	}
	if i := strings.Index(raw, hamiFieldSep); i >= 0 {
		return strings.TrimSpace(raw[:i])
	}
	return strings.TrimSpace(raw)
}

// derivedNodeStatus reduces the conditions array down to a Ready/NotReady/
// Unknown summary, matching what the existing collector reports for the
// regular node list.
func derivedNodeStatus(n *corev1.Node) string {
	for _, c := range n.Status.Conditions {
		if c.Type == corev1.NodeReady {
			switch c.Status {
			case corev1.ConditionTrue:
				return "Ready"
			case corev1.ConditionFalse:
				return "NotReady"
			default:
				return "Unknown"
			}
		}
	}
	return "Unknown"
}

func sortNodesByName(s []*gpuNodeSummary) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j-1].Name > s[j].Name; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}
