import { PlusOutlined } from '@ant-design/icons';
import { useIntl, useParams } from '@umijs/max';
import { App, Button, Dropdown } from 'antd';
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
      replaceEditAction={(record, { refresh }) => (
        <JobEditButton record={record} refresh={refresh} />
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

function JobEditButton({
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
      <JobFormDrawer
        open={open}
        clusterId={clusterId}
        editing={{ name: record.name, namespace: record.namespace }}
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
  const { message, modal } = App.useApp();
  const { id: clusterId } = useParams<{ id: string }>();
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

  // Action key → i18n suffix lookup. Keeps the construction explicit
  // so we don't string-munge the action name to derive the label key
  // (the previous `replace('Job', '').toLowerCase()` couldn't survive
  // a future action that doesn't end in 'Job').
  const ACTION_LABEL_ID: Record<VolcanoAction, string> = {
    ResumeJob: 'pages.compute.job.action.resume',
    AbortJob: 'pages.compute.job.action.abort',
    RestartJob: 'pages.compute.job.action.restart',
    CompleteJob: 'pages.compute.job.action.complete',
    TerminateJob: 'pages.compute.job.action.terminate',
    OpenQueue: 'pages.compute.queue.action.open',
    CloseQueue: 'pages.compute.queue.action.close',
  };

  const items = (Object.keys(ACTION_LABEL_ID) as VolcanoAction[])
    .filter((a) => a.endsWith('Job'))
    .map((a) => ({
      key: a,
      label: intl.formatMessage({ id: ACTION_LABEL_ID[a] }),
      danger: a === 'TerminateJob',
    }));

  return (
    <Dropdown
      menu={{
        items,
        onClick: ({ key }) => {
          const action = key as VolcanoAction;
          modal.confirm({
            title: intl.formatMessage(
              { id: 'pages.compute.job.action.confirm' },
              {
                name: record.name,
                action: intl.formatMessage({
                  id: ACTION_LABEL_ID[action],
                }),
              },
            ),
            okType: action === 'TerminateJob' ? 'danger' : 'primary',
            onOk: () => fire(action),
          });
        },
      }}
    >
      <Button type="link" size="small">
        {intl.formatMessage({ id: 'pages.compute.job.action.menu' })}
      </Button>
    </Dropdown>
  );
}
