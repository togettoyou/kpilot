import { PlusOutlined } from '@ant-design/icons';
import { useIntl, useParams } from '@umijs/max';
import { App, Button, Popconfirm } from 'antd';
import React, { useState } from 'react';

import type { WorkloadItem } from '@/services/kpilot/workload';
import { applyManifest } from '@/services/kpilot/volcano';
import { VolcanoCRPage } from './CRPage';
import { CronJobFormDrawer } from './CronJobForm';

// Volcano CronJob (`batch.volcano.sh/v1alpha1`) — schedules a Volcano
// Job on a cron expression. Has the same structure as Job below the
// schedule level. Per-row "暂停 / 恢复" toggles spec.suspend on the
// CronJob; we patch the bool through /apply (SSA), no Command CR
// involved.
export default function VolcanoCronJobsPage() {
  return (
    <VolcanoCRPage
      cr={{
        group: 'batch.volcano.sh',
        version: 'v1alpha1',
        kind: 'CronJob',
        scope: 'Namespaced',
      }}
      extraToolbarButtons={({ refresh }) => (
        <CronJobCreateButton key="new" refresh={refresh} />
      )}
      extraRowActions={(record, { refresh }) => (
        <CronJobSuspendAction key="suspend" record={record} refresh={refresh} />
      )}
      replaceEditAction={(record, { refresh }) => (
        <CronJobEditButton record={record} refresh={refresh} />
      )}
    />
  );
}

function CronJobCreateButton({ refresh }: { refresh: () => void }) {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const [open, setOpen] = useState(false);
  if (!clusterId) return null;
  return (
    <>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => setOpen(true)}
      >
        {intl.formatMessage({ id: 'pages.compute.cronJob.create' })}
      </Button>
      <CronJobFormDrawer
        open={open}
        clusterId={clusterId}
        onClose={() => setOpen(false)}
        onSaved={refresh}
      />
    </>
  );
}

function CronJobEditButton({
  record,
  refresh,
}: {
  record: WorkloadItem;
  refresh: () => void;
}) {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const [open, setOpen] = useState(false);
  if (!clusterId) return null;
  return (
    <>
      <Button type="link" size="small" onClick={() => setOpen(true)}>
        {intl.formatMessage({ id: 'pages.workloads.edit' })}
      </Button>
      <CronJobFormDrawer
        open={open}
        clusterId={clusterId}
        editing={{ name: record.name, namespace: record.namespace }}
        onClose={() => setOpen(false)}
        onSaved={refresh}
      />
    </>
  );
}

// CronJobSuspendAction patches spec.suspend. We read the current value
// out of the K8s Table API row's cells (Volcano's CronJob CRD declares
// SUSPEND as an additionalPrinterColumn — string "true"/"false").
// Falls through with a guess if the column ever shifts; user can
// always retry.
function CronJobSuspendAction({
  record,
  refresh,
}: {
  record: WorkloadItem;
  refresh: () => void;
}) {
  const intl = useIntl();
  const { message } = App.useApp();
  const { id: clusterId } = useParams<{ id: string }>();
  if (!clusterId) return null;

  const cells = (record.cells as unknown[] | undefined) ?? [];
  // Heuristic: look for the literal "true"/"false" as a row cell.
  let suspended = false;
  for (const c of cells) {
    if (c === 'true' || c === true) {
      suspended = true;
      break;
    }
  }

  const next = !suspended;
  const labelId = suspended
    ? 'pages.compute.cronJob.action.resume'
    : 'pages.compute.cronJob.action.suspend';
  const confirmId = suspended
    ? 'pages.compute.cronJob.confirm.resume'
    : 'pages.compute.cronJob.confirm.suspend';

  const onConfirm = async () => {
    // SSA-patch via /apply: send a minimal manifest that touches only
    // the suspend flag. Other fields are left to whoever owns them.
    try {
      const res = await applyManifest(clusterId, {
        apiVersion: 'batch.volcano.sh/v1alpha1',
        kind: 'CronJob',
        metadata: { name: record.name, namespace: record.namespace },
        spec: { suspend: next },
      });
      const fail = res?.results?.find((r) => !r.success);
      if (fail) {
        message.error(fail.error ?? 'patch failed');
        return;
      }
      message.success(
        intl.formatMessage({
          id: next
            ? 'pages.compute.cronJob.suspended'
            : 'pages.compute.cronJob.resumed',
        }),
      );
      refresh();
    } catch {
      // global toast
    }
  };

  return (
    <Popconfirm
      title={intl.formatMessage({ id: confirmId }, { name: record.name })}
      onConfirm={onConfirm}
    >
      <Button type="link" size="small">
        {intl.formatMessage({ id: labelId })}
      </Button>
    </Popconfirm>
  );
}
