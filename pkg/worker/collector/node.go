package collector

import (
	"context"
	"log"

	corev1 "k8s.io/api/core/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	proto "github.com/togettoyou/kpilot/pkg/common/proto"
)

// NodeReconciler watches Node objects and pushes the full node list to Server
// whenever any node changes. Reads from the controller-runtime cache (no direct
// API server calls after initial sync).
type NodeReconciler struct {
	client client.Client
	pushFn func([]*proto.NodeInfo)
}

var _ reconcile.Reconciler = &NodeReconciler{}

// SetupNodeReconciler registers the reconciler with the Manager and returns it
// so the caller can invoke Sync after gRPC reconnects.
func SetupNodeReconciler(mgr ctrl.Manager, pushFn func([]*proto.NodeInfo)) (*NodeReconciler, error) {
	r := &NodeReconciler{
		client: mgr.GetClient(),
		pushFn: pushFn,
	}
	err := ctrl.NewControllerManagedBy(mgr).
		Named("node-collector").
		For(&corev1.Node{}).
		Complete(r)
	return r, err
}

// Reconcile is called by the framework when any Node changes.
// We ignore the specific node in the request and always push the full list.
func (r *NodeReconciler) Reconcile(ctx context.Context, _ reconcile.Request) (reconcile.Result, error) {
	return reconcile.Result{}, r.pushAll(ctx)
}

// Sync pushes the current full node list immediately.
// Called by the tunnel client right after a successful gRPC registration.
func (r *NodeReconciler) Sync(ctx context.Context) {
	if err := r.pushAll(ctx); err != nil {
		log.Printf("[collector] sync nodes: %v", err)
	}
}

func (r *NodeReconciler) pushAll(ctx context.Context) error {
	var list corev1.NodeList
	if err := r.client.List(ctx, &list); err != nil {
		return err
	}
	nodes := make([]*proto.NodeInfo, 0, len(list.Items))
	for i := range list.Items {
		nodes = append(nodes, toProtoNode(&list.Items[i]))
	}
	r.pushFn(nodes)
	return nil
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

	labels := make(map[string]string, len(n.Labels))
	for k, v := range n.Labels {
		labels[k] = v
	}

	return &proto.NodeInfo{
		Name:              n.Name,
		Status:            status,
		CpuCapacity:       n.Status.Capacity.Cpu().MilliValue(),
		CpuAllocatable:    n.Status.Allocatable.Cpu().MilliValue(),
		MemoryCapacity:    n.Status.Capacity.Memory().Value(),
		MemoryAllocatable: n.Status.Allocatable.Memory().Value(),
		Labels:            labels,
	}
}
