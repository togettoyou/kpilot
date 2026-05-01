package collector

import (
	"context"
	"log"
	"time"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/config"

	proto "github.com/togettoyou/kpilot/pkg/common/proto"
)

const collectInterval = 30 * time.Second

// NodeCollector 周期采集 K8s 节点信息并通过 pushFn 上报
type NodeCollector struct {
	client client.Client
	pushFn func([]*proto.NodeInfo)
}

// NewNodeCollector 创建采集器；若无法读取 kubeconfig 则返回 nil
func NewNodeCollector(pushFn func([]*proto.NodeInfo)) *NodeCollector {
	cfg, err := config.GetConfig()
	if err != nil {
		log.Printf("[collector] no kubeconfig available, node collection disabled: %v", err)
		return nil
	}
	c, err := client.New(cfg, client.Options{})
	if err != nil {
		log.Printf("[collector] failed to create k8s client: %v", err)
		return nil
	}
	return &NodeCollector{client: c, pushFn: pushFn}
}

// Run 阻塞运行直到 ctx 取消
func (nc *NodeCollector) Run(ctx context.Context) {
	nc.collect(ctx)
	ticker := time.NewTicker(collectInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			nc.collect(ctx)
		}
	}
}

func (nc *NodeCollector) collect(ctx context.Context) {
	var nodeList corev1.NodeList
	if err := nc.client.List(ctx, &nodeList); err != nil {
		log.Printf("[collector] list nodes: %v", err)
		return
	}

	nodes := make([]*proto.NodeInfo, 0, len(nodeList.Items))
	for _, n := range nodeList.Items {
		nodes = append(nodes, toProtoNode(&n))
	}
	nc.pushFn(nodes)
}

func toProtoNode(n *corev1.Node) *proto.NodeInfo {
	status := "Unknown"
	for _, cond := range n.Status.Conditions {
		if cond.Type == corev1.NodeReady {
			if cond.Status == corev1.ConditionTrue {
				status = "Ready"
			} else {
				status = "NotReady"
			}
			break
		}
	}

	cpuCap := n.Status.Capacity.Cpu().MilliValue()
	cpuAlloc := n.Status.Allocatable.Cpu().MilliValue()
	memCap := n.Status.Capacity.Memory().Value()
	memAlloc := n.Status.Allocatable.Memory().Value()

	labels := make(map[string]string, len(n.Labels))
	for k, v := range n.Labels {
		labels[k] = v
	}

	return &proto.NodeInfo{
		Name:              n.Name,
		Status:            status,
		CpuCapacity:       cpuCap,
		CpuAllocatable:    cpuAlloc,
		MemoryCapacity:    memCap,
		MemoryAllocatable: memAlloc,
		Labels:            labels,
	}
}
