package proxy

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/togettoyou/kpilot/pkg/common/proto"
	"github.com/togettoyou/kpilot/pkg/common/vgpu"
)

// vgpu.go — projects Volcano's per-node + per-pod vGPU annotations
// into a single cluster snapshot for the 算力调度 UI.
//
// Wire format (matches volcano/pkg/scheduler/api/devices/nvidia/vgpu/utils.go):
//
//   Node annotation `volcano.sh/node-vgpu-register`:
//     <GPU>:<GPU>:...
//     each GPU: `UUID,Number,Memory,Type,Health,SharingMode`
//
//   Pod annotation `volcano.sh/vgpu-ids-new`:
//     <container>;<container>;...
//     each container: <device>:<device>:...
//     each device: `UUID,Type,Usedmem,Usedcores`
//
//   Pod annotation `volcano.sh/vgpu-node`:
//     The kubelet node the scheduler bound this pod to.
//
//   Pod annotation `volcano.sh/bind-phase`:
//     "allocating" | "success" | "failed" | "deallocating" — we treat
//     allocating + success as "currently consuming" and ignore the
//     other two (and pods in a terminal Pod.Status.Phase).
//
// We stayed lazy on the snapshot — every call hits the API server's
// cache twice (Nodes + Pods). For the realistic cluster sizes KPilot
// targets that's fast enough; switching to an informer is a future
// optimisation when a user actually hits scale issues.

const (
	// Resource names appearing in Pod container.resources.limits.
	// Exported for parity with Volcano's `config/vgpu.go` constants.
	ResourceVGPUNumber           = "volcano.sh/vgpu-number"
	ResourceVGPUMemory           = "volcano.sh/vgpu-memory"
	ResourceVGPUMemoryPercentage = "volcano.sh/vgpu-memory-percentage"
	ResourceVGPUCores            = "volcano.sh/vgpu-cores"

	// Node annotation written by the device-plugin to advertise its
	// per-card inventory. Volcano also writes a sibling
	// `volcano.sh/node-vgpu-handshake` timestamp for liveness — we
	// don't read it today because per-card NVML Health (decoded from
	// the register annotation) already covers the typical failure
	// modes. Wiring up handshake-based "device-plugin pod died but
	// register is stale" detection is a future P2.x — for now a
	// dead plugin shows up as ageing data rather than a banner.
	nodeRegisterAnnotation = "volcano.sh/node-vgpu-register"

	// Pod annotations.
	podAssignedIDsAnnotation  = "volcano.sh/vgpu-ids-new"
	podAssignedNodeAnnotation = "volcano.sh/vgpu-node"
	podBindPhaseAnnotation    = "volcano.sh/bind-phase"
)

// vgpuSnapshot bridges the proxy's gRPC interface to VGPUTracker.
// Wire shape: success → resp.Data is the JSON-encoded vgpu.Snapshot;
// failure → resp.Success=false with the error message.
func (p *Proxy) vgpuSnapshot(ctx context.Context) *proto.ResourceResponse {
	if p.vgpu == nil {
		return fail("vgpu tracker unavailable")
	}
	snap, err := p.vgpu.Snapshot(ctx)
	if err != nil {
		return fail(err.Error())
	}
	data, err := json.Marshal(snap)
	if err != nil {
		return fail("marshal vgpu snapshot: " + err.Error())
	}
	log.Printf("[vgpu] snapshot: nodes=%d cards=%d slots=%d/%d memory=%d/%d",
		len(snap.Nodes), snap.TotalCards, snap.UsedSlots, snap.TotalSlots,
		snap.UsedMemory, snap.TotalMemory)
	return &proto.ResourceResponse{Success: true, Data: data}
}

// VGPUTracker builds vGPU snapshots on demand. Stateless across calls —
// we don't cache the projected view because the API server's watch
// cache is already in-memory; an extra layer would just add staleness
// without saving any IO.
type VGPUTracker struct {
	cs kubernetes.Interface
}

// NewVGPUTracker creates a tracker bound to one cluster's API server.
// The typed clientset is built once and reused per Snapshot call.
func NewVGPUTracker(cfg *rest.Config) (*VGPUTracker, error) {
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &VGPUTracker{cs: cs}, nil
}

// Snapshot lists every Node + Pod and projects the vGPU view.
// Errors from either list propagate up so the caller can surface a
// meaningful "vGPU unavailable" message instead of a half-empty view.
func (t *VGPUTracker) Snapshot(ctx context.Context) (*vgpu.Snapshot, error) {
	// Snapshot does a full Nodes + Pods sweep on every refresh. Per
	// CLAUDE.md the eventual fix is informer-backed, but until then
	// cap each page and walk continue tokens so very large clusters
	// (10k+ pods) don't carry a multi-MB payload across one gRPC
	// frame. 500 is the same per-page cap Server's list endpoints use.
	const pageLimit = 500
	nodes, err := listAllNodes(ctx, t.cs, pageLimit)
	if err != nil {
		return nil, err
	}
	pods, err := listAllPods(ctx, t.cs, pageLimit)
	if err != nil {
		return nil, err
	}
	nodeList := &corev1.NodeList{Items: nodes}
	podList := &corev1.PodList{Items: pods}

	// Build the per-node card inventory first. Nodes without the
	// register annotation are dropped — they're not part of the vGPU
	// pool, no point surfacing them as "0 cards".
	nodeMap := make(map[string]*vgpu.Node, len(nodeList.Items))
	for _, n := range nodeList.Items {
		cards := decodeNodeRegister(n.Annotations[nodeRegisterAnnotation])
		if len(cards) == 0 {
			continue
		}
		allHealthy := true
		var totalMem, totalNum int
		for _, c := range cards {
			totalMem += c.Memory
			totalNum += c.Number
			if !c.Health {
				allHealthy = false
			}
		}
		nodeMap[n.Name] = &vgpu.Node{
			Name:        n.Name,
			Healthy:     allHealthy,
			Cards:       cards,
			TotalMemory: totalMem,
			TotalNumber: totalNum,
		}
	}

	// Layer pod assignments on top. We skip:
	//   - pods on nodes we don't track (annotation references a node
	//     that never registered vGPU — usually a stale leftover from
	//     a deleted/recreated node);
	//   - bind-phase = failed | deallocating (transitional and the
	//     resources aren't actually held);
	//   - Succeeded / Failed pods (Volcano sometimes leaves
	//     annotations on terminal pods; counting them inflates "used"
	//     forever).
	for _, pod := range podList.Items {
		nodeName := pod.Annotations[podAssignedNodeAnnotation]
		if nodeName == "" {
			continue
		}
		nv, ok := nodeMap[nodeName]
		if !ok {
			continue
		}
		ids := pod.Annotations[podAssignedIDsAnnotation]
		if ids == "" {
			continue
		}
		// Allowlist the bind phases that actually correspond to
		// "this pod is holding vGPU slots right now". An empty
		// phase value happens transiently between scheduler bind
		// and device-plugin annotate; counting it inflates "used"
		// for a window. failed / deallocating are explicit drop
		// signals from Volcano.
		phase := pod.Annotations[podBindPhaseAnnotation]
		if phase != "allocating" && phase != "success" {
			continue
		}
		if pod.Status.Phase == corev1.PodSucceeded ||
			pod.Status.Phase == corev1.PodFailed {
			continue
		}
		for _, container := range decodePodIDs(ids) {
			for _, dev := range container {
				if !applyPodUsage(nv, dev, pod.Namespace, pod.Name) {
					log.Printf("[vgpu] pod %s/%s references unknown card uuid=%s node=%s",
						pod.Namespace, pod.Name, dev.uuid, nodeName)
				}
			}
		}
	}

	// Roll up: per-node Used + cluster totals. Sorting is deterministic
	// (by node name) so the UI doesn't jitter between refreshes.
	snap := &vgpu.Snapshot{Nodes: make([]vgpu.Node, 0, len(nodeMap))}
	for _, nv := range nodeMap {
		var usedMem, usedNum int
		for _, c := range nv.Cards {
			usedMem += c.UsedMemory
			usedNum += c.UsedNumber
		}
		nv.UsedMemory = usedMem
		nv.UsedNumber = usedNum
		// Stable per-card sort by Index — matches `nvidia-smi` order.
		sort.SliceStable(nv.Cards, func(i, j int) bool {
			return nv.Cards[i].Index < nv.Cards[j].Index
		})
		snap.Nodes = append(snap.Nodes, *nv)
		snap.TotalCards += len(nv.Cards)
		snap.TotalMemory += nv.TotalMemory
		snap.UsedMemory += usedMem
		snap.TotalSlots += nv.TotalNumber
		snap.UsedSlots += usedNum
	}
	sort.SliceStable(snap.Nodes, func(i, j int) bool {
		return snap.Nodes[i].Name < snap.Nodes[j].Name
	})
	return snap, nil
}

// applyPodUsage adds one device assignment to the matching card.
// Returns false if the UUID isn't present on the node — usually a
// race with the device-plugin un-registering a card while a pod
// annotation still references it. The caller logs and moves on.
func applyPodUsage(nv *vgpu.Node, dev decodedDevice, podNs, podName string) bool {
	for i := range nv.Cards {
		c := &nv.Cards[i]
		if c.UUID != dev.uuid {
			continue
		}
		c.UsedMemory += dev.usedmem
		c.UsedCores += dev.usedcores
		c.UsedNumber++
		c.Pods = append(c.Pods, vgpu.PodUsage{
			Namespace:  podNs,
			Name:       podName,
			UsedMemory: dev.usedmem,
			UsedCores:  dev.usedcores,
		})
		return true
	}
	return false
}

// decodeNodeRegister parses `volcano.sh/node-vgpu-register`.
// Mirrors `decodeNodeDevices` in Volcano's
// `pkg/scheduler/api/devices/nvidia/vgpu/utils.go` — same delimiter
// scheme, same field order. Malformed entries are skipped (and
// logged) rather than failing the whole node: a half-registered node
// is still useful to surface.
func decodeNodeRegister(s string) []vgpu.Card {
	if !strings.Contains(s, ":") {
		return nil
	}
	parts := strings.Split(s, ":")
	cards := make([]vgpu.Card, 0, len(parts))
	for idx, p := range parts {
		if !strings.Contains(p, ",") {
			continue
		}
		items := strings.Split(p, ",")
		if len(items) < 6 {
			log.Printf("[vgpu] decodeNodeRegister: skipping malformed gpu entry %q", p)
			continue
		}
		// Parse each numeric / bool field with the real error path —
		// silently defaulting to zero made malformed registers join
		// the snapshot as zero-cap cards, dragging node totals down.
		count, err := strconv.Atoi(items[1])
		if err != nil {
			log.Printf("[vgpu] decodeNodeRegister: bad count %q in entry %q: %v", items[1], p, err)
			continue
		}
		mem, err := strconv.Atoi(items[2])
		if err != nil {
			log.Printf("[vgpu] decodeNodeRegister: bad memory %q in entry %q: %v", items[2], p, err)
			continue
		}
		health, err := strconv.ParseBool(items[4])
		if err != nil {
			log.Printf("[vgpu] decodeNodeRegister: bad health %q in entry %q: %v", items[4], p, err)
			continue
		}
		cards = append(cards, vgpu.Card{
			Index:       idx,
			UUID:        items[0],
			Number:      count,
			Memory:      mem,
			Type:        items[3],
			Health:      health,
			SharingMode: items[5],
		})
	}
	return cards
}

// decodedDevice is the lower-case internal mirror of one entry in
// `volcano.sh/vgpu-ids-new`. We don't export this type — callers
// either get the aggregated vgpu.Card (via Snapshot) or roll their
// own decode using ResourceVGPU* constants.
//
// The annotation field order also carries a "Type" (GPU model name)
// after UUID — we don't store it because the canonical model name
// already lives on the parent vgpu.Card (decoded from the node's
// register annotation, which is authoritative). Keeping a second
// copy from the pod annotation would invite drift if a future
// device-plugin version changes the format.
type decodedDevice struct {
	uuid      string
	usedmem   int
	usedcores int
}

// decodePodIDs parses `volcano.sh/vgpu-ids-new`.
//
//	`;` separates containers, `:` separates devices within a container,
//	`,` separates fields within a device (UUID,Type,Usedmem,Usedcores).
//
// Volcano's encoder emits a trailing `:` even for a single device
// (`UUID,Type,Usedmem,Usedcores:`), so we tolerate empty splits.
func decodePodIDs(s string) [][]decodedDevice {
	if s == "" {
		return nil
	}
	var out [][]decodedDevice
	for _, container := range strings.Split(s, ";") {
		if container == "" {
			continue
		}
		var devs []decodedDevice
		for _, d := range strings.Split(container, ":") {
			if !strings.Contains(d, ",") {
				continue
			}
			items := strings.Split(d, ",")
			if len(items) < 4 {
				continue
			}
			usedmem, _ := strconv.Atoi(items[2])
			usedcores, _ := strconv.Atoi(items[3])
			devs = append(devs, decodedDevice{
				uuid:      items[0],
				usedmem:   usedmem,
				usedcores: usedcores,
			})
		}
		if len(devs) > 0 {
			out = append(out, devs)
		}
	}
	return out
}

// listAllNodes pages through every Node with the given per-page cap.
// Re-uses the K8s continue token so the apiserver doesn't have to
// hold a giant response in memory.
func listAllNodes(ctx context.Context, cs kubernetes.Interface, limit int64) ([]corev1.Node, error) {
	var out []corev1.Node
	cont := ""
	for {
		page, err := cs.CoreV1().Nodes().List(ctx, metav1.ListOptions{
			Limit:    limit,
			Continue: cont,
		})
		if err != nil {
			return nil, err
		}
		out = append(out, page.Items...)
		if page.Continue == "" {
			return out, nil
		}
		cont = page.Continue
	}
}

// listAllPods is the all-namespaces sibling of listAllNodes.
func listAllPods(ctx context.Context, cs kubernetes.Interface, limit int64) ([]corev1.Pod, error) {
	var out []corev1.Pod
	cont := ""
	for {
		page, err := cs.CoreV1().Pods("").List(ctx, metav1.ListOptions{
			Limit:    limit,
			Continue: cont,
		})
		if err != nil {
			return nil, err
		}
		out = append(out, page.Items...)
		if page.Continue == "" {
			return out, nil
		}
		cont = page.Continue
	}
}
