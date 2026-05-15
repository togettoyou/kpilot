import { request } from '@umijs/max';

// volcano-status.ts — typed mirror of pkg/common/volcano.Status.
// Hand-mirrored (no Go → TS codegen wired up); keep in sync if the
// Go shape changes.

export interface VolcanoStatus {
  installed: boolean;
  // Where the worker found `volcano-scheduler-configmap`. Empty
  // when installed=false OR when the CRD is present but the
  // scheduler ConfigMap isn't deployed (rare; CRDs without the
  // controller running).
  schedulerConfigMapNamespace?: string;
}

// Detects Volcano cluster-side via:
//   1. RESTMapping for scheduling.volcano.sh/v1beta1 Queue
//   2. ConfigMap fieldSelector on metadata.name=volcano-scheduler-configmap
//
// Returns 200 in all cases (including installed=false) so the
// frontend can distinguish "Volcano not here" from "tunnel down".
export function getVolcanoStatus(clusterId: string) {
  return request<VolcanoStatus>(
    `/api/v1/clusters/${clusterId}/volcano/status`,
    { method: 'GET' },
  );
}
