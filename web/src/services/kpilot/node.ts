import { request } from '@umijs/max';

// NodeTable mirrors the K8s Table API response (`Accept: as=Table`),
// the same shape `kubectl get node -o wide` consumes server-side.
// `columnDefinitions` carries kubectl's printer columns (default +
// wide) and `rows[].cells` the per-row values, in column order.
// `metadata.continue` carries the K8s cursor for the next page;
// `remainingItemCount` is the server-known tail size (best-effort,
// not always populated — same as kubectl-go behavior).
export interface NodeTable {
  columnDefinitions: { name: string; description?: string; priority: number }[];
  rows: { cells: any[]; object?: any }[];
  metadata?: {
    continue?: string;
    remainingItemCount?: number;
  };
}

// Routed through the workloads proxy (resourceGVK has `nodes`); the
// Worker calls Table API + returns kubectl-style rows. Pagination via
// limit + continue tokens — same cursor semantics as the Workloads
// list and standard kubectl chunking.
export function listNodes(
  clusterId: string,
  limit = 0,
  continueToken = '',
) {
  const params: Record<string, string | number> = {};
  if (limit > 0) params.limit = limit;
  if (continueToken) params.continue = continueToken;
  return request<NodeTable>(
    `/api/v1/clusters/${clusterId}/workloads/nodes`,
    { method: 'GET', params },
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

// cordonNode flips spec.unschedulable through a dedicated server
// endpoint. The body is just `{cordon: bool}` — the Server constructs
// the actual Strategic Merge Patch (`{spec: {unschedulable: ...}}`)
// so the client physically cannot smuggle in extra fields. This is
// stricter than the read-modify-write-via-PUT pattern we used first:
// PUT exposed the entire Node spec to whatever the client chose to
// send, which is too much authority for a "cordon" button.
//
// The corresponding generic /workloads/nodes/:name PUT and DELETE
// are still wired through Workloads (admins control risk per the
// post-removal protect policy); this scoped endpoint stays the
// "safer" mutation path because the body schema is narrow — clients
// can't smuggle other fields under the cordon button.
export function cordonNode(
  clusterId: string,
  name: string,
  cordon: boolean,
): Promise<void> {
  return request(
    `/api/v1/clusters/${clusterId}/workloads/nodes/${name}/cordon`,
    { method: 'POST', data: { cordon } },
  );
}
