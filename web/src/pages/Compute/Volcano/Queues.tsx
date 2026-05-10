import { PlusOutlined } from '@ant-design/icons';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { App, Button, Popconfirm, Space, Spin, Tag, Typography } from 'antd';
import React, { useContext, useState } from 'react';

import type { WorkloadItem } from '@/services/kpilot/workload';
import { WorkloadRefreshTickContext } from '@/pages/ClusterDetail/Workloads';
import { sendCommand } from '@/services/kpilot/volcano';
import { VolcanoCRPage } from './CRPage';
import { QueueFormDrawer } from './QueueForm';
import { fetchOnce } from './sharedFetch';

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
  const intl = useIntl();
  return (
    <VolcanoCRPage
      cr={QUEUE_CR}
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
      // Volcano's Queue CRD only ships PARENT as an additionalPrinter-
      // Column, so the default Table API view has no state / weight /
      // resource info. Inject two columns that fetch the full Queue
      // object per row: one for state (compact tag), one for the
      // richer resource picture (weight + capability + allocated +
      // running PodGroup count). Same fetch backs both column cells
      // and the row's open/close action — useRequest doesn't dedupe
      // across instances, so we accept ~3 small GETs per row; Queue
      // counts are usually < 50 in practice.
      extraColumns={[
        {
          title: intl.formatMessage({
            id: 'pages.compute.queue.col.state',
          }),
          key: 'state',
          width: 90,
          render: (_, record) => <QueueStateCell name={record.name} />,
        },
        {
          title: intl.formatMessage({
            id: 'pages.compute.queue.col.detail',
          }),
          key: 'detail',
          width: 280,
          render: (_, record) => <QueueDetailCell name={record.name} />,
        },
      ]}
    />
  );
}

// Small tag-only state cell. Reads .status.state from the per-row
// Queue fetch.
function QueueStateCell({ name }: { name: string }) {
  const { id: clusterId } = useParams<{ id: string }>();
  const tick = useContext(WorkloadRefreshTickContext);
  const { data, loading } = useRequest(
    () => fetchOnce(clusterId!, QUEUE_CR, name, '', tick),
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId, name, tick],
    },
  );
  if (loading && !data) return <Spin size="small" />;
  const state =
    (data as { status?: { state?: string } } | undefined)?.status?.state ?? '';
  if (!state) return <Tag>未知</Tag>;
  const color =
    state === 'Open' ? 'green' : state === 'Closed' ? 'red' : 'orange';
  return <Tag color={color}>{state}</Tag>;
}

// Rich resource summary: weight + capability + allocated + running
// PodGroup count, stacked compactly. Fetches the same Queue object
// independently from QueueStateCell — small redundancy, see comment
// at the column definition above.
function QueueDetailCell({ name }: { name: string }) {
  const { id: clusterId } = useParams<{ id: string }>();
  const tick = useContext(WorkloadRefreshTickContext);
  const { data, loading } = useRequest(
    () => fetchOnce(clusterId!, QUEUE_CR, name, '', tick),
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId, name, tick],
    },
  );
  if (loading && !data) return <Spin size="small" />;
  const obj = data as
    | {
        spec?: {
          weight?: number;
          capability?: Record<string, string>;
          parent?: string;
        };
        status?: {
          allocated?: Record<string, string>;
          running?: number;
          pending?: number;
          inqueue?: number;
        };
      }
    | undefined;
  if (!obj) return null;
  const weight = obj.spec?.weight ?? 1;
  const cap = obj.spec?.capability ?? {};
  const alloc = obj.status?.allocated ?? {};
  const summary = formatResources(alloc, cap);
  const running = obj.status?.running ?? 0;
  const pending = obj.status?.pending ?? 0;
  const inqueue = obj.status?.inqueue ?? 0;
  return (
    <Space direction="vertical" size={2} style={{ lineHeight: 1.4 }}>
      <Typography.Text style={{ fontSize: 12 }}>
        权重 <strong>{weight}</strong>
        {obj.spec?.parent && (
          <span style={{ marginInlineStart: 8, color: 'var(--ant-color-text-tertiary)' }}>
            父队列 {obj.spec.parent}
          </span>
        )}
      </Typography.Text>
      <Typography.Text
        style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}
      >
        {summary || '资源未限制'}
      </Typography.Text>
      <Typography.Text
        style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary)' }}
      >
        Running {running} · Pending {pending} · Inqueue {inqueue}
      </Typography.Text>
    </Space>
  );
}

// formatResources turns an allocated map + capability map into a
// compact "key A/B" summary. Skips keys that aren't in either map.
// e.g. allocated={cpu:4} capability={cpu:10, memory:100Gi} ⇒
// "cpu 4/10 · memory 0/100Gi".
function formatResources(
  alloc: Record<string, string>,
  cap: Record<string, string>,
): string {
  const keys = new Set([...Object.keys(alloc), ...Object.keys(cap)]);
  // Order: cpu first, memory second, then GPU keys, then everything else.
  const order = (k: string) => {
    if (k === 'cpu') return 0;
    if (k === 'memory') return 1;
    if (k.startsWith('volcano.sh/vgpu') || k.startsWith('nvidia.com/gpu'))
      return 2;
    return 3;
  };
  const sorted = [...keys].sort(
    (a, b) => order(a) - order(b) || a.localeCompare(b),
  );
  return sorted
    .map((k) => {
      const a = alloc[k] ?? '0';
      const c = cap[k];
      const short = k.startsWith('volcano.sh/vgpu-')
        ? k.slice('volcano.sh/'.length)
        : k;
      return c ? `${short} ${a}/${c}` : `${short} ${a}`;
    })
    .join(' · ');
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
  const tick = useContext(WorkloadRefreshTickContext);

  const stateReq = useRequest(
    () => fetchOnce(clusterId!, QUEUE_CR, record.name, '', tick),
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId, record.name, tick],
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

  // Close = destructive, render danger so it's visually distinct
  // from the safe "Open / Resume" action that flips the same button.
  const isClose = flipping === 'CloseQueue';
  return (
    <Popconfirm
      title={intl.formatMessage({ id: confirmId }, { name: record.name })}
      onConfirm={onConfirm}
      okType={isClose ? 'danger' : 'primary'}
    >
      <Button
        type="link"
        size="small"
        danger={isClose}
        loading={stateReq.loading && !stateReq.data}
      >
        {intl.formatMessage({ id: labelId })}
      </Button>
    </Popconfirm>
  );
}
