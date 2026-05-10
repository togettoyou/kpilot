import { PlusOutlined } from '@ant-design/icons';
import { useIntl, useParams } from '@umijs/max';
import { App, Button, Popconfirm } from 'antd';
import React, { useState } from 'react';

import type { WorkloadItem } from '@/services/kpilot/workload';
import { sendCommand } from '@/services/kpilot/volcano';
import { VolcanoCRPage } from './CRPage';
import { QueueFormDrawer } from './QueueForm';

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
// Closed). State comes from the K8s Table API STATE column — we
// scan the row's `cells` for the literal "Open" / "Closed" tokens.
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
  if (!clusterId) return null;

  const cells = (record.cells as unknown[] | undefined) ?? [];
  let state: 'Open' | 'Closed' | 'Unknown' = 'Unknown';
  for (const c of cells) {
    if (c === 'Open') {
      state = 'Open';
      break;
    }
    if (c === 'Closed') {
      state = 'Closed';
      break;
    }
  }

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
      <Button type="link" size="small">
        {intl.formatMessage({ id: labelId })}
      </Button>
    </Popconfirm>
  );
}
