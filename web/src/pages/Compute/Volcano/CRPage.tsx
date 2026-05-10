import type { ProColumns } from '@ant-design/pro-components';
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
interface ExtensionCtx {
  refresh: () => void;
  // Drops into the same YAML drawer the workload page's default edit
  // button uses. Volcano wrappers expose this alongside their typed
  // form-edit button so power users can still tweak fields the form
  // doesn't surface.
  openYamlEditor: (record: WorkloadItem) => void;
}

interface VolcanoCRPageProps {
  cr: CRRef;
  extraToolbarButtons?: (ctx: ExtensionCtx) => React.ReactNode;
  extraRowActions?: (
    record: WorkloadItem,
    ctx: ExtensionCtx,
  ) => React.ReactNode;
  replaceEditAction?: (
    record: WorkloadItem,
    ctx: ExtensionCtx,
  ) => React.ReactNode;
  extraColumns?: ProColumns<WorkloadItem>[];
}

export function VolcanoCRPage({
  cr,
  extraToolbarButtons,
  extraRowActions,
  replaceEditAction,
  extraColumns,
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
      replaceEditAction={replaceEditAction}
      extraColumns={extraColumns}
      // Volcano CR pages all have typed create/edit forms with form
      // & YAML dual view. The generic Apply YAML toolbar would just
      // be a confusing parallel path, so we suppress it everywhere
      // CRPage is used.
      hideApplyYaml
    />
  );
}
