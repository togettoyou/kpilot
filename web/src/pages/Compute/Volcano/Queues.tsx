import { PlusOutlined } from '@ant-design/icons';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { App, Button, Popconfirm } from 'antd';
import React, { useState } from 'react';

import type { WorkloadItem } from '@/services/kpilot/workload';
import { getWorkload } from '@/services/kpilot/workload';
import { sendCommand } from '@/services/kpilot/volcano';
import { VolcanoCRPage } from './CRPage';
import { QueueFormDrawer } from './QueueForm';

const QUEUE_CR = {
  group: 'scheduling.volcano.sh',
  version: 'v1beta1',
  kind: 'Queue',
  scope: 'Cluster' as const,
};

// Volcano Queue (`scheduling.volcano.sh/v1beta1`) — cluster-scoped.
// Wraps the generic CR browser (CRPage) with two Volcano-specific
// extensions:
//
//   1. A "新建队列" button in the toolbar that opens QueueFormDrawer.
//      The form constructs a Queue manifest and ships it via /apply
//      (server-side SSA).
//   2. Per-row "关闭/开启" action that drops a `bus.volcano.sh
//      Command` CR with action=CloseQueue/OpenQueue. Same UX as
//      `vcctl queue close|open`.
//
// We read the Queue's STATE column out of the K8s Table API row's
// cells (Volcano's CRD declares STATE as an additionalPrinterColumn)
// and flip the row action label accordingly.
export default function VolcanoQueuesPage() {
  return (
    <VolcanoCRPage
      cr={{
        group: 'scheduling.volcano.sh',
        version: 'v1beta1',
        kind: 'Queue',
        scope: 'Cluster',
      }}
      extraToolbarButtons={({ refresh }) => (
        <QueueCreateButton key="new" refresh={refresh} />
      )}
      extraRowActions={(record, { refresh }) => (
        <QueueStateAction
          key="state"
          record={record}
          refresh={refresh}
        />
      )}
      replaceEditAction={(record, { refresh }) => (
        <QueueEditButton record={record} refresh={refresh} />
      )}
    />
  );
}

// QueueCreateButton owns both the "新建队列" toolbar button and the
// form drawer's open/close state, so the drawer's onSaved handler
// can call the refresh function captured from the toolbar render
// without bouncing through page-level state.
function QueueCreateButton({ refresh }: { refresh: () => void }) {
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
        {intl.formatMessage({ id: 'pages.compute.queue.create' })}
      </Button>
      <QueueFormDrawer
        open={open}
        clusterId={clusterId}
        onClose={() => setOpen(false)}
        onSaved={refresh}
      />
    </>
  );
}

// QueueEditButton replaces the workload page's default "Edit YAML"
// row button with a typed-form edit. The drawer fetches the current
// Queue spec on open and pre-fills the form.
function QueueEditButton({
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
      <QueueFormDrawer
        open={open}
        clusterId={clusterId}
        editing={{ name: record.name }}
        onClose={() => setOpen(false)}
        onSaved={refresh}
      />
    </>
  );
}

// QueueStateAction renders the row's flip-state Popconfirm (Open ↔
// Closed). The K8s Table API for Queue *does not* declare a State
// printer column (Volcano's CRD only exposes PARENT + AGE), so we
// fetch the Queue's full object once per row and read .status.state
// directly. After a successful close/open command the local fetch
// re-runs a few times — Volcano takes a beat to flip the status.
function QueueStateAction({
  record,
  refresh,
}: {
  record: WorkloadItem;
  refresh: () => void;
}) {
  const intl = useIntl();
  const { message } = App.useApp();
  const { id: clusterId } = useParams<{ id: string }>();

  const stateReq = useRequest(
    () => getWorkload(clusterId!, '_cr', record.name, '', QUEUE_CR),
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId, record.name],
    },
  );
  const state: 'Open' | 'Closed' | 'Unknown' = (() => {
    const s = (stateReq.data as { status?: { state?: string } } | undefined)
      ?.status?.state;
    if (s === 'Open') return 'Open';
    if (s === 'Closed') return 'Closed';
    return 'Unknown';
  })();

  if (!clusterId) return null;

  // 'Unknown' falls through to the close action — Volcano queues
  // default to Open on creation, so unknown ≈ assume open.
  const flipping = state === 'Closed' ? 'OpenQueue' : 'CloseQueue';
  const labelId =
    state === 'Closed'
      ? 'pages.compute.queue.action.open'
      : 'pages.compute.queue.action.close';
  const confirmId =
    state === 'Closed'
      ? 'pages.compute.queue.confirm.open'
      : 'pages.compute.queue.confirm.close';

  const onConfirm = async () => {
    try {
      const res = await sendCommand(clusterId, flipping, {
        apiVersion: 'scheduling.volcano.sh/v1beta1',
        kind: 'Queue',
        name: record.name,
      });
      const fail = res?.results?.find((r) => !r.success);
      if (fail) {
        message.error(fail.error ?? 'command failed');
        return;
      }
      message.success(
        intl.formatMessage({
          id:
            flipping === 'OpenQueue'
              ? 'pages.compute.queue.opened'
              : 'pages.compute.queue.closed',
        }),
      );
      refresh();
      // Volcano controller takes ~1-2s to apply the state flip.
      // Re-poll our local status fetch a few times so the button
      // label flips without the user needing to click 刷新 manually.
      const retries = [800, 2000, 4500];
      retries.forEach((delay) => setTimeout(() => stateReq.refresh(), delay));
    } catch (e: any) {
      // sendCommand can throw a local Error (e.g. uid resolution) the
      // request-error config doesn't see — surface the message
      // explicitly. Network / API errors keep going through the
      // global toast via the request layer.
      const msg = e?.response?.data?.message ?? e?.message;
      if (msg) message.error(String(msg));
    }
  };

  return (
    <Popconfirm
      title={intl.formatMessage({ id: confirmId }, { name: record.name })}
      onConfirm={onConfirm}
    >
      <Button type="link" size="small" loading={stateReq.loading && !stateReq.data}>
        {intl.formatMessage({ id: labelId })}
      </Button>
    </Popconfirm>
  );
}
