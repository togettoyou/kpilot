import { request } from '@umijs/max';

// NodeTable mirrors the K8s Table API response (`Accept: as=Table`),
// the same shape `kubectl get node -o wide` consumes server-side.
// `columnDefinitions` carries kubectl's printer columns (default +
// wide) and `rows[].cells` the per-row values, in column order.
export interface NodeTable {
  columnDefinitions: { name: string; description?: string; priority: number }[];
  rows: { cells: any[]; object?: any }[];
}

// Routed through the workloads proxy (resourceGVK has `nodes`); the
// Worker calls Table API + returns kubectl-style rows. Keeps the K8s
// 节点概览 page in lockstep with `kubectl get node -o wide` for free,
// including SchedulingDisabled appended to STATUS when cordoned.
export function listNodes(clusterId: string) {
  return request<NodeTable>(
    `/api/v1/clusters/${clusterId}/workloads/nodes`,
    { method: 'GET' },
  );
}

// Dynamic Get for the detail drawer. The Table list response only
// carries cells (and partial metadata depending on includeObject);
// labels / annotations / taints / podCIDR all live on the full Node.
export function getNode(clusterId: string, name: string) {
  return request<any>(
    `/api/v1/clusters/${clusterId}/workloads/nodes/${name}`,
    { method: 'GET' },
  );
}

// cordonNode flips spec.unschedulable. Read-modify-write through the
// existing workloads PUT path (server-side dynamic.Update) — gives us
// optimistic concurrency via resourceVersion for free, so two ops
// racing return 409 instead of clobbering each other. Cordon is rare
// enough that the extra GET round-trip is invisible.
export async function cordonNode(
  clusterId: string,
  name: string,
  cordon: boolean,
): Promise<void> {
  const current = await getNode(clusterId, name);
  current.spec = { ...(current.spec ?? {}), unschedulable: cordon };
  await request(
    `/api/v1/clusters/${clusterId}/workloads/nodes/${name}`,
    { method: 'PUT', data: current },
  );
}
