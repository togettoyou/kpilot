import { PlusOutlined } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { App, Button, Popconfirm, Space, Tag, Typography } from 'antd';
import React, { useState } from 'react';

import {
  listVolcanoQueues,
  type QueueRow,
} from '@/services/kpilot/volcano-list';
import { sendCommand } from '@/services/kpilot/volcano';
import { deleteWorkload } from '@/services/kpilot/workload';
import { QueueFormDrawer } from './QueueForm';
import {
  NotInstalled,
  RefreshControl,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

// Volcano Queue (`scheduling.volcano.sh/v1beta1`) — cluster-scoped
// resource pool. One server-side fetch returns every queue's spec +
// status pre-projected, so rendering 100 queues is one request — not
// 1 list + 100 GETs the way the generic CR browser used to do it.
export default function VolcanoQueuesPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { message, modal } = App.useApp();

  const [createOpen, setCreateOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);

  const { data, loading, error, refresh } = useRequest(
    () => listVolcanoQueues(clusterId!),
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId],
    },
  );

  const [interval, setInterval] = useAutoRefresh(refresh, !!clusterId);

  if (!clusterId) return null;
  if (error && isResourceNotAvailable(error)) {
    return <NotInstalled clusterId={clusterId} />;
  }

  const onDelete = (name: string) => {
    modal.confirm({
      title: intl.formatMessage(
        { id: 'pages.workloads.delete.confirm' },
        { name },
      ),
      okType: 'danger',
      onOk: async () => {
        try {
          await deleteWorkload(clusterId, '_cr', name, '', {
            group: 'scheduling.volcano.sh',
            version: 'v1beta1',
            kind: 'Queue',
            scope: 'Cluster',
          });
          message.success(
            intl.formatMessage({ id: 'pages.workloads.delete.success' }),
          );
          refresh();
        } catch (e: any) {
          const m = e?.response?.data?.message ?? e?.message;
          if (m) message.error(String(m));
        }
      },
    });
  };

  const columns: ProColumns<QueueRow>[] = [
    {
      title: 'Name',
      dataIndex: 'name',
      copyable: true,
      width: 200,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.queue.col.state' }),
      dataIndex: 'state',
      width: 90,
      render: (_, r) => {
        if (!r.state) return <Tag>未知</Tag>;
        const color =
          r.state === 'Open'
            ? 'green'
            : r.state === 'Closed'
              ? 'red'
              : 'orange';
        return <Tag color={color}>{r.state}</Tag>;
      },
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.queue.col.detail' }),
      key: 'detail',
      width: 300,
      render: (_, r) => <QueueDetailCell row={r} />,
    },
    {
      title: 'Parent',
      dataIndex: 'parent',
      width: 120,
      render: (_, r) => r.parent || '-',
    },
    {
      title: 'Age',
      key: 'age',
      width: 80,
      render: (_, r) => formatAge(r.creationTimestamp),
    },
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.actions' }),
      key: 'action',
      fixed: 'right',
      width: 220,
      render: (_, record) => (
        <Space size={0}>
          <QueueStateAction record={record} refresh={refresh} />
          <Button
            type="link"
            size="small"
            onClick={() => setEditingName(record.name)}
          >
            {intl.formatMessage({ id: 'pages.workloads.edit' })}
          </Button>
          <Button
            type="link"
            size="small"
            danger
            onClick={() => onDelete(record.name)}
          >
            {intl.formatMessage({ id: 'pages.workloads.delete' })}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="p-6">
      <ProTable<QueueRow>
        rowKey="uid"
        columns={columns}
        dataSource={data ?? []}
        loading={loading}
        search={false}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
        options={false}
        headerTitle={
          <Space>
            <Typography.Text strong>Queue</Typography.Text>
            <Typography.Text type="secondary">
              ({data?.length ?? 0})
            </Typography.Text>
          </Space>
        }
        toolBarRender={() => [
          <Button
            key="new"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
          >
            {intl.formatMessage({ id: 'pages.compute.queue.create' })}
          </Button>,
          <RefreshControl
            key="refresh"
            interval={interval}
            setInterval={setInterval}
            refresh={refresh}
            loading={loading}
          />,
        ]}
      />
      <QueueFormDrawer
        open={createOpen}
        clusterId={clusterId}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          refresh();
        }}
      />
      <QueueFormDrawer
        open={!!editingName}
        clusterId={clusterId}
        editing={editingName ? { name: editingName } : undefined}
        onClose={() => setEditingName(null)}
        onSaved={() => {
          setEditingName(null);
          refresh();
        }}
      />
    </div>
  );
}

// QueueDetailCell renders weight + capability vs allocated + PodGroup
// counts in a compact 3-line block. All data comes from the row prop
// — no per-row fetch.
function QueueDetailCell({ row }: { row: QueueRow }) {
  const cap = row.capability ?? {};
  const alloc = row.allocated ?? {};
  return (
    <Space direction="vertical" size={2} style={{ lineHeight: 1.4 }}>
      <Typography.Text style={{ fontSize: 12 }}>
        权重 <strong>{row.weight}</strong>
        {row.reclaimable === false && (
          <Tag color="default" style={{ marginInlineStart: 8 }}>
            不可回收
          </Tag>
        )}
      </Typography.Text>
      <Typography.Text
        style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}
      >
        {formatResources(alloc, cap) || '资源未限制'}
      </Typography.Text>
      <Typography.Text
        style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary)' }}
      >
        Running {row.running} · Pending {row.pending} · Inqueue {row.inqueue}
        {row.completed > 0 && ` · Completed ${row.completed}`}
      </Typography.Text>
    </Space>
  );
}

// formatResources is unchanged from the previous per-row-fetch
// version. Renders allocated/capability as "cpu 4/10 · memory 0/100Gi".
function formatResources(
  alloc: Record<string, string>,
  cap: Record<string, string>,
): string {
  const keys = new Set([...Object.keys(alloc), ...Object.keys(cap)]);
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

// QueueStateAction flips the Open/Closed state via a Volcano Command
// CR. Reads state from the row prop (zero per-row fetch). After the
// command lands, we trigger a list refresh so the row updates — the
// controller takes ~1-2s to flip status.state, so a single refresh on
// success is usually enough; users can click 刷新 again if needed.
function QueueStateAction({
  record,
  refresh,
}: {
  record: QueueRow;
  refresh: () => void;
}) {
  const intl = useIntl();
  const { message } = App.useApp();
  const { id: clusterId } = useParams<{ id: string }>();
  if (!clusterId) return null;

  const isClosed = record.state === 'Closed';
  const flipping = isClosed ? 'OpenQueue' : 'CloseQueue';
  const labelId = isClosed
    ? 'pages.compute.queue.action.open'
    : 'pages.compute.queue.action.close';
  const confirmId = isClosed
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
          id: isClosed
            ? 'pages.compute.queue.opened'
            : 'pages.compute.queue.closed',
        }),
      );
      // Volcano controller takes a beat to flip status.state. A few
      // staggered refreshes catch it without making the user click.
      [400, 1500, 4000].forEach((d) => setTimeout(refresh, d));
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message;
      if (msg) message.error(String(msg));
    }
  };

  return (
    <Popconfirm
      title={intl.formatMessage({ id: confirmId }, { name: record.name })}
      onConfirm={onConfirm}
      okType={isClosed ? 'primary' : 'danger'}
    >
      <Button type="link" size="small" danger={!isClosed}>
        {intl.formatMessage({ id: labelId })}
      </Button>
    </Popconfirm>
  );
}
