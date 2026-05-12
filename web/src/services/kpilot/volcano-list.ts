import { request } from '@umijs/max';

// volcano-list.ts — slim, per-kind list endpoints for the 算力调度
// pages. Each call returns the full data the UI needs in one request,
// projected from full Volcano CR objects on the server side. No more
// per-row GETs to fill in spec / status the K8s Table API doesn't
// expose.
//
// Response shape carries `continue` + `remainingItemCount` so the UI
// can show a "result truncated" hint when the server-side limit (500)
// caps the result. Cursor pagination wiring is left to a follow-up
// PR — for now the bound just protects worst-case payload.

export interface VolcanoListResponse<T> {
  items: T[];
  continue?: string;
  remainingItemCount?: number;
}

export interface VolcanoListParams {
  namespace?: string;
  // Optional override of the server-side default (500). The server
  // clamps anything larger than its default to that ceiling, so passing
  // a huge value is harmless but pointless.
  limit?: number;
  // Cursor token returned in a previous response's `continue` field.
  continueToken?: string;
}

function listParams(p?: VolcanoListParams): Record<string, string | number> {
  const q: Record<string, string | number> = {};
  if (p?.namespace) q.namespace = p.namespace;
  if (typeof p?.limit === 'number' && p.limit > 0) q.limit = p.limit;
  if (p?.continueToken) q.continue = p.continueToken;
  return q;
}

export interface QueueRow {
  name: string;
  uid: string;
  creationTimestamp: string;
  weight: number;
  state: 'Open' | 'Closed' | 'Closing' | 'Unknown' | string;
  parent?: string;
  reclaimable?: boolean;
  capability?: Record<string, string>;
  allocated?: Record<string, string>;
  running: number;
  pending: number;
  inqueue: number;
  completed: number;
  unknown: number;
}

export function listVolcanoQueues(clusterId: string, params?: VolcanoListParams) {
  return request<VolcanoListResponse<QueueRow>>(
    `/api/v1/clusters/${clusterId}/volcano/queues`,
    { method: 'GET', params: listParams(params) },
  );
}

export interface JobTaskRow {
  name: string;
  replicas: number;
  image: string;
}

export interface JobRow {
  name: string;
  namespace: string;
  uid: string;
  creationTimestamp: string;
  queue?: string;
  schedulerName?: string;
  priorityClassName?: string;
  minAvailable: number;
  state: string; // Pending / Running / Completed / Failed / Aborted / Terminated / Suspended / ...
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  terminating: number;
  unknown: number;
  plugins?: string[];
  tasks?: JobTaskRow[];
}

export function listVolcanoJobs(
  clusterId: string,
  namespace?: string,
  params?: Omit<VolcanoListParams, 'namespace'>,
) {
  return request<VolcanoListResponse<JobRow>>(
    `/api/v1/clusters/${clusterId}/volcano/jobs`,
    { method: 'GET', params: listParams({ ...params, namespace }) },
  );
}

export interface CronJobRow {
  name: string;
  namespace: string;
  uid: string;
  creationTimestamp: string;
  schedule: string;
  concurrencyPolicy?: string;
  suspend: boolean;
  lastScheduleTime?: string;
  activeCount: number;
}

export function listVolcanoCronJobs(
  clusterId: string,
  namespace?: string,
  params?: Omit<VolcanoListParams, 'namespace'>,
) {
  return request<VolcanoListResponse<CronJobRow>>(
    `/api/v1/clusters/${clusterId}/volcano/cronjobs`,
    { method: 'GET', params: listParams({ ...params, namespace }) },
  );
}

export interface PodGroupRow {
  name: string;
  namespace: string;
  uid: string;
  creationTimestamp: string;
  queue?: string;
  priorityClassName?: string;
  minMember: number;
  minResources?: Record<string, string>;
  phase: string; // Pending / Inqueue / Running / Completed / Failed / Unknown
  running: number;
  succeeded: number;
  failed: number;
}

export function listVolcanoPodGroups(
  clusterId: string,
  namespace?: string,
  params?: Omit<VolcanoListParams, 'namespace'>,
) {
  return request<VolcanoListResponse<PodGroupRow>>(
    `/api/v1/clusters/${clusterId}/volcano/podgroups`,
    { method: 'GET', params: listParams({ ...params, namespace }) },
  );
}

export interface HyperNodeMember {
  type: string; // 'Node' | 'HyperNode'
  selector: string; // pre-formatted "exact: foo" / "regex: ..." / "labels: {..}"
}

export interface HyperNodeRow {
  name: string;
  uid: string;
  creationTimestamp: string;
  tier: number;
  members?: HyperNodeMember[];
}

export function listVolcanoHyperNodes(
  clusterId: string,
  params?: VolcanoListParams,
) {
  return request<VolcanoListResponse<HyperNodeRow>>(
    `/api/v1/clusters/${clusterId}/volcano/hypernodes`,
    { method: 'GET', params: listParams(params) },
  );
}

// ─── JobFlow ────────────────────────────────────────────────────────────

export interface JobFlowRow {
  name: string;
  namespace: string;
  uid: string;
  creationTimestamp: string;
  phase: string; // Succeed / Terminating / Failed / Running / Pending / ''
  jobRetainPolicy?: string; // retain | delete
  flowCount: number;
  pendingCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  terminatedCount: number;
  unknownCount: number;
}

export function listVolcanoJobFlows(
  clusterId: string,
  namespace?: string,
  params?: Omit<VolcanoListParams, 'namespace'>,
) {
  return request<VolcanoListResponse<JobFlowRow>>(
    `/api/v1/clusters/${clusterId}/volcano/jobflows`,
    { method: 'GET', params: listParams({ ...params, namespace }) },
  );
}

// ─── JobTemplate ────────────────────────────────────────────────────────

export interface JobTemplateRow {
  name: string;
  namespace: string;
  uid: string;
  creationTimestamp: string;
  queue?: string;
  schedulerName?: string;
  minAvailable: number;
  taskCount: number;
  priorityClassName?: string;
}

export function listVolcanoJobTemplates(
  clusterId: string,
  namespace?: string,
  params?: Omit<VolcanoListParams, 'namespace'>,
) {
  return request<VolcanoListResponse<JobTemplateRow>>(
    `/api/v1/clusters/${clusterId}/volcano/jobtemplates`,
    { method: 'GET', params: listParams({ ...params, namespace }) },
  );
}

// ─── Numatopology ───────────────────────────────────────────────────────

export interface NumaResourceRow {
  name: string;
  allocatable?: string;
  capacity: number;
}

export interface NumatopologyRow {
  name: string;
  uid: string;
  creationTimestamp: string;
  policies?: Record<string, string>;
  resReserved?: Record<string, string>;
  numaResources?: NumaResourceRow[];
  cpuCount: number;
}

export function listVolcanoNumatopologies(
  clusterId: string,
  params?: VolcanoListParams,
) {
  return request<VolcanoListResponse<NumatopologyRow>>(
    `/api/v1/clusters/${clusterId}/volcano/numatopologies`,
    { method: 'GET', params: listParams(params) },
  );
}

// ─── NodeShard ──────────────────────────────────────────────────────────

export interface NodeShardRow {
  name: string;
  uid: string;
  creationTimestamp: string;
  nodesDesired?: string[];
  nodesInUse?: string[];
  nodesToAdd?: string[];
  nodesToRemove?: string[];
  lastUpdateTime?: string;
}

export function listVolcanoNodeShards(
  clusterId: string,
  params?: VolcanoListParams,
) {
  return request<VolcanoListResponse<NodeShardRow>>(
    `/api/v1/clusters/${clusterId}/volcano/nodeshards`,
    { method: 'GET', params: listParams(params) },
  );
}

// ─── ColocationConfiguration ────────────────────────────────────────────

export interface ColocationConfigurationRow {
  name: string;
  namespace: string;
  uid: string;
  creationTimestamp: string;
  highRatio: number;
  lowRatio: number;
  minRatio: number;
  selectorSummary?: string;
  available?: string; // condition status: True / False / Unknown / ''
}

export function listVolcanoColocationConfigurations(
  clusterId: string,
  namespace?: string,
  params?: Omit<VolcanoListParams, 'namespace'>,
) {
  return request<VolcanoListResponse<ColocationConfigurationRow>>(
    `/api/v1/clusters/${clusterId}/volcano/colocationconfigurations`,
    { method: 'GET', params: listParams({ ...params, namespace }) },
  );
}
