import { useParams } from '@umijs/max';
import React from 'react';

import type { CRRef, WorkloadItem } from '@/services/kpilot/workload';
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
//
// `notAvailableHint` swaps the empty-state Result that appears when
// the cluster doesn't have the CRD installed. The generic copy says
// "this CRD or feature gate isn't available" — for Volcano the right
// answer is always "install the Volcano plugin", so we point users
// directly at /clusters/:id/plugins instead.
interface VolcanoCRPageProps {
  cr: CRRef;
  // Forwarded to WorkloadsContent — wrappers use these to add a
  // "新建 X" toolbar button + per-row lifecycle actions (Open/Close
  // for Queue, Resume/Suspend for Job, etc.).
  extraToolbarButtons?: (ctx: { refresh: () => void }) => React.ReactNode;
  extraRowActions?: (
    record: WorkloadItem,
    ctx: { refresh: () => void },
  ) => React.ReactNode;
}

export function VolcanoCRPage({
  cr,
  extraToolbarButtons,
  extraRowActions,
}: VolcanoCRPageProps) {
  const { id: clusterId } = useParams<{ id: string }>();
  if (!clusterId) return null;
  return (
    <WorkloadsContent
      key={`volcano:${cr.group}/${cr.version}/${cr.kind}`}
      clusterId={clusterId}
      resourceType="_cr"
      cr={cr}
      showCRBackArrow={false}
      notAvailableHint={{
        titleId: 'pages.compute.volcano.notInstalled.title',
        subTitleId: 'pages.compute.volcano.notInstalled.subTitle',
        actionLabelId: 'pages.compute.volcano.notInstalled.action',
      }}
      extraToolbarButtons={extraToolbarButtons}
      extraRowActions={extraRowActions}
    />
  );
}
