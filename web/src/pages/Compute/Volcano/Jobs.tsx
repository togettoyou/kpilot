import { PlusOutlined } from '@ant-design/icons';
import { useIntl, useParams } from '@umijs/max';
import { App, Button, Dropdown, Popconfirm } from 'antd';
import React, { useState } from 'react';

import type { WorkloadItem } from '@/services/kpilot/workload';
import { sendCommand, type VolcanoAction } from '@/services/kpilot/volcano';
import { VolcanoCRPage } from './CRPage';
import { JobFormDrawer } from './JobForm';

// Volcano Job (`batch.volcano.sh/v1alpha1`) — gang-scheduled batch
// job. This page wraps the generic CR browser with:
//
//   1. "新建作业" button → JobFormDrawer (multi-task form)
//   2. Per-row dropdown of lifecycle ops → Resume / Abort / Restart
//      / Terminate / Complete via `bus.volcano.sh Command`. Same
//      action set `vcctl job` exposes; we group them under one
//      "操作" dropdown to keep the action column readable.
export default function VolcanoJobsPage() {
  return (
    <VolcanoCRPage
      cr={{
        group: 'batch.volcano.sh',
        version: 'v1alpha1',
        kind: 'Job',
        scope: 'Namespaced',
      }}
      extraToolbarButtons={({ refresh }) => (
        <JobCreateButton key="new" refresh={refresh} />
      )}
      extraRowActions={(record, { refresh }) => (
        <JobLifecycleAction key="lc" record={record} refresh={refresh} />
      )}
    />
  );
}

function JobCreateButton({ refresh }: { refresh: () => void }) {
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
        {intl.formatMessage({ id: 'pages.compute.job.create' })}
      </Button>
      <JobFormDrawer
        open={open}
        clusterId={clusterId}
        onClose={() => setOpen(false)}
        onSaved={refresh}
      />
    </>
  );
}

// JobLifecycleAction is the per-row "操作" dropdown. Picks an action,
// confirms in a Popconfirm, drops a Command CR. The full set:
//   - ResumeJob   — un-suspend an aborted Job
//   - AbortJob    — pause: kill pods but keep the Job alive
//   - RestartJob  — kill pods + recreate
//   - TerminateJob— pause permanently (can't be resumed)
//   - CompleteJob — mark Job as Complete; surviving pods get killed
function JobLifecycleAction({
  record,
  refresh,
}: {
  record: WorkloadItem;
  refresh: () => void;
}) {
  const intl = useIntl();
  const { message } = App.useApp();
  const { id: clusterId } = useParams<{ id: string }>();
  const [pending, setPending] = useState<VolcanoAction | null>(null);
  if (!clusterId) return null;

  const fire = async (action: VolcanoAction) => {
    try {
      const res = await sendCommand(clusterId, action, {
        apiVersion: 'batch.volcano.sh/v1alpha1',
        kind: 'Job',
        name: record.name,
        namespace: record.namespace,
      });
      const fail = res?.results?.find((r) => !r.success);
      if (fail) {
        message.error(fail.error ?? 'command failed');
        return;
      }
      message.success(
        intl.formatMessage({ id: 'pages.compute.job.commandSent' }),
      );
      refresh();
    } catch {
      // global toast
    }
  };

  const items = [
    { key: 'ResumeJob', label: intl.formatMessage({ id: 'pages.compute.job.action.resume' }) },
    { key: 'AbortJob', label: intl.formatMessage({ id: 'pages.compute.job.action.abort' }) },
    { key: 'RestartJob', label: intl.formatMessage({ id: 'pages.compute.job.action.restart' }) },
    { key: 'CompleteJob', label: intl.formatMessage({ id: 'pages.compute.job.action.complete' }) },
    { key: 'TerminateJob', label: intl.formatMessage({ id: 'pages.compute.job.action.terminate' }), danger: true },
  ];

  return (
    <>
      <Dropdown
        menu={{
          items,
          onClick: ({ key }) => setPending(key as VolcanoAction),
        }}
      >
        <Button type="link" size="small">
          {intl.formatMessage({ id: 'pages.compute.job.action.menu' })}
        </Button>
      </Dropdown>
      {pending && (
        <Popconfirm
          open
          title={intl.formatMessage(
            { id: 'pages.compute.job.action.confirm' },
            {
              name: record.name,
              action: intl.formatMessage({
                id: `pages.compute.job.action.${pending
                  .replace('Job', '')
                  .toLowerCase()}`,
              }),
            },
          )}
          onConfirm={async () => {
            const a = pending;
            setPending(null);
            if (a) await fire(a);
          }}
          onCancel={() => setPending(null)}
          okType={pending === 'TerminateJob' ? 'danger' : 'primary'}
        >
          <span />
        </Popconfirm>
      )}
    </>
  );
}
