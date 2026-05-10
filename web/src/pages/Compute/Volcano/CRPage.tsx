import { useParams } from '@umijs/max';
import React from 'react';

import type { CRRef } from '@/services/kpilot/workload';
import { WorkloadsContent } from '@/pages/ClusterDetail/Workloads';

// CRPage mounts the WorkloadsContent CR-instances browser at a fixed
// GVK, replacing the URL-query-driven `/workloads/_cr?...` entry point
// for the cases where we want a dedicated route in the Compute sider.
//
// The page reuses every piece of the workload page's machinery (table,
// search, refresh, edit YAML, describe drawer, namespace picker, write
// protection) — we just preset the GVK so the user lands on a Volcano
// CR with one click instead of going through the CRD list.
//
// `showCRBackArrow={false}` hides the small "back to CRD list" arrow
// that the workloads-page version of this view shows by default; from
// the Compute platform there's no CRD list above to go back to.
export function VolcanoCRPage({ cr }: { cr: CRRef }) {
  const { id: clusterId } = useParams<{ id: string }>();
  if (!clusterId) return null;
  return (
    <WorkloadsContent
      key={`volcano:${cr.group}/${cr.version}/${cr.kind}`}
      clusterId={clusterId}
      resourceType="_cr"
      cr={cr}
      showCRBackArrow={false}
    />
  );
}
