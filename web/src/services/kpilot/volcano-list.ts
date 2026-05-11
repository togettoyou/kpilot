import { request } from '@umijs/max';

// volcano-list.ts — slim, per-kind list endpoints for the 算力调度
// pages. Each call returns the full data the UI needs in one request,
// projected from full Volcano CR objects on the server side. No more
// per-row GETs to fill in spec / status the K8s Table API doesn't
// expose.

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

export function listVolcanoQueues(clusterId: string) {
  return request<QueueRow[]>(`/api/v1/clusters/${clusterId}/volcano/queues`, {
    method: 'GET',
  });
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

export function listVolcanoJobs(clusterId: string, namespace?: string) {
  return request<JobRow[]>(`/api/v1/clusters/${clusterId}/volcano/jobs`, {
    method: 'GET',
    params: namespace ? { namespace } : {},
  });
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

export function listVolcanoCronJobs(clusterId: string, namespace?: string) {
  return request<CronJobRow[]>(
    `/api/v1/clusters/${clusterId}/volcano/cronjobs`,
    {
      method: 'GET',
      params: namespace ? { namespace } : {},
    },
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

export function listVolcanoPodGroups(clusterId: string, namespace?: string) {
  return request<PodGroupRow[]>(
    `/api/v1/clusters/${clusterId}/volcano/podgroups`,
    {
      method: 'GET',
      params: namespace ? { namespace } : {},
    },
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

export function listVolcanoHyperNodes(clusterId: string) {
  return request<HyperNodeRow[]>(
    `/api/v1/clusters/${clusterId}/volcano/hypernodes`,
    { method: 'GET' },
  );
}
