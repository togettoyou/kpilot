package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/togettoyou/kpilot/pkg/common/proto"
)

// hamiNodeRegisterAnnotation is the JSON-encoded per-card register HAMI
// writes to GPU nodes. Documented at
// https://project-hami.io/docs/core-concepts/gpu-virtualization. Each entry
// is a physical GPU with its UUID, slice count, memory, compute percent,
// model name, NUMA, and health flag — the canonical source for per-card
// detail (the labels HAMI also writes carry only node-level summaries).
const hamiNodeRegisterAnnotation = "hami.io/node-nvidia-register"

// hamiDevice mirrors one entry of the annotation JSON. Field tags must
// match HAMI's snake-cased schema exactly.
type hamiDevice struct {
	ID      string `json:"id"`
	Count   int32  `json:"count"`   // vGPU slot count after slicing
	DevMem  int32  `json:"devmem"`  // physical memory MB (per card, total)
	DevCore int32  `json:"devcore"` // compute percent total (typically 100)
	Type    string `json:"type"`    // GPU model name
	NUMA    int32  `json:"numa"`
	Health  bool   `json:"health"`
}

// gpuNodeSummary is the per-node payload Server forwards to the UI. JSON
// keys are camelCase to match the existing frontend convention.
type gpuNodeSummary struct {
	Name        string           `json:"name"`
	Status      string           `json:"status"`
	Devices     []hamiDevice     `json:"devices"`     // per-card; empty if no HAMI annotation
	Capacity    map[string]int64 `json:"capacity"`    // nvidia.com/* node-level totals
	Allocatable map[string]int64 `json:"allocatable"` // same, after reservations
	Used        map[string]int64 `json:"used"`        // sum of pod requests on this node
	Pods        []gpuPodSummary  `json:"pods"`
}

// gpuPodSummary is one Pod that reserves a GPU resource on a GPU node.
type gpuPodSummary struct {
	Namespace string           `json:"namespace"`
	Name      string           `json:"name"`
	Phase     string           `json:"phase"`
	Requests  map[string]int64 `json:"requests"` // nvidia.com/* names → values
}

// gpuSummary builds the cluster-wide GPU view. Always returns a top-level
// JSON array (possibly empty) so the frontend renders an empty state
// rather than choking on null. List operations use the typed clientset
// rather than the dynamic one for cheaper deserialization on large
// clusters (typed informers re-use schema-aware decoders).
func (p *Proxy) gpuSummary(ctx context.Context) *proto.ResourceResponse {
	nodes, err := p.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return fail(fmt.Sprintf("list nodes: %v", err))
	}

	byNode := make(map[string]*gpuNodeSummary)
	for i := range nodes.Items {
		n := &nodes.Items[i]
		// Devices come from the HAMI annotation when present; we still
		// publish capacity/allocatable from K8s extended resources so the
		// page works on a vanilla NVIDIA device-plugin install too (no
		// per-card detail in that mode, just node-level totals).
		devices := parseHAMIDevices(n.Annotations)
		cap := extractGPUResources(n.Status.Capacity)
		alloc := extractGPUResources(n.Status.Allocatable)
		if len(devices) == 0 && len(cap) == 0 {
			continue // not a GPU node by either signal
		}
		byNode[n.Name] = &gpuNodeSummary{
			Name:        n.Name,
			Status:      derivedNodeStatus(n),
			Devices:     devices,
			Capacity:    cap,
			Allocatable: alloc,
			Used:        map[string]int64{},
			Pods:        nil,
		}
	}

	// One ListAll call rather than per-node fetch. Even on a 1k-pod cluster
	// the response is a few MB; we filter to just GPU-requesting pods on
	// GPU nodes after that.
	pods, err := p.clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return fail(fmt.Sprintf("list pods: %v", err))
	}
	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.Spec.NodeName == "" {
			continue
		}
		node, ok := byNode[pod.Spec.NodeName]
		if !ok {
			continue
		}
		// Terminated pods don't actually hold resources from the
		// scheduler's perspective; aligning with how K8s itself accounts
		// for usage avoids double-counting after a Job finishes but the
		// Pod object lingers.
		if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
			continue
		}
		req := podGPURequests(pod)
		if len(req) == 0 {
			continue
		}
		for k, v := range req {
			node.Used[k] += v
		}
		node.Pods = append(node.Pods, gpuPodSummary{
			Namespace: pod.Namespace,
			Name:      pod.Name,
			Phase:     string(pod.Status.Phase),
			Requests:  req,
		})
	}

	// Stable order (sorted by node name) so the UI doesn't reshuffle on
	// every poll.
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
// Returns empty (not error) if the annotation is missing or malformed —
// HAMI may not be installed, or may be on an older version writing a
// different schema, and we'd still want the page to render with whatever
// node-level GPU info is available.
func parseHAMIDevices(annotations map[string]string) []hamiDevice {
	raw, ok := annotations[hamiNodeRegisterAnnotation]
	if !ok || raw == "" {
		return nil
	}
	var devices []hamiDevice
	if err := json.Unmarshal([]byte(raw), &devices); err != nil {
		return nil
	}
	return devices
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

// derivedNodeStatus reduces the conditions array down to a Ready/NotReady/
// Unknown summary, matching what the existing collector reports for the
// regular node list. Kept here rather than imported to avoid cross-package
// dep just for one helper.
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
	// std-lib sort.Slice would pull in another import for one use; this
	// inline insertion sort is fine — GPU node count is bounded by physical
	// hardware (rarely > 20) so O(n²) is negligible.
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j-1].Name > s[j].Name; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}
