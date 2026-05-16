import { useIntl, useRequest } from '@umijs/max';
import {
  Card,
  Descriptions,
  Drawer,
  Empty,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import React, { useEffect } from 'react';

import { getNode } from '@/services/kpilot/node';
import { formatAge as sharedFormatAge } from '@/pages/Compute/Volcano/shared/Layout';

const { Text } = Typography;

interface Props {
  clusterId: string;
  name: string | null;
  open: boolean;
  onClose: () => void;
}

// NodeDetailDrawer is the structured view of a Node, replacing the
// inline expand row that used to live under each table row. Inline
// expand was visually noisy and added horizontal-scroll surface area
// to the table; a side Drawer gives the structured fields room to
// breathe and keeps the table itself terse.
const NodeDetailDrawer: React.FC<Props> = ({ clusterId, name, open, onClose }) => {
  const intl = useIntl();
  // manual + useEffect instead of `ready + refreshDeps`: when the
  // user closes the drawer, parent flips `name` to null, and
  // useRequest's refreshDeps still fired one final fetch with
  // `name!` stringified to literal "null", producing a 404 toast.
  // Manual run gives precise control — only fetch when explicitly
  // told to, never on prop change alone.
  const { data, loading, run, mutate } = useRequest(getNode, {
    manual: true,
    formatResult: (res) => res,
  });

  useEffect(() => {
    if (open && name) {
      run(clusterId, name);
    } else {
      // Clear stale data so when the drawer reopens for a different
      // node it doesn't briefly show the previous one's content.
      mutate(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, name, clusterId]);

  if (!name) return null;
  const node = data ?? {};
  const status = readyStatus(node);

  return (
    <Drawer
      title={
        <Space>
          <Text strong>{name}</Text>
          {status && <StatusTag status={status} />}
        </Space>
      }
      open={open}
      onClose={onClose}
      size="large"
      maskClosable={false}
    >
      {loading || !data ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin />
        </div>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <BasicInfo node={node} intl={intl} />
          <Networking node={node} intl={intl} />
          <Scheduling node={node} intl={intl} />
          <Resources node={node} intl={intl} />
          <Conditions node={node} intl={intl} />
          <KVCard
            title={intl.formatMessage({ id: 'pages.nodes.detail.labels' })}
            entries={node?.metadata?.labels ?? {}}
          />
          <KVCard
            title={intl.formatMessage({ id: 'pages.nodes.detail.annotations' })}
            entries={node?.metadata?.annotations ?? {}}
          />
        </Space>
      )}
    </Drawer>
  );
};

// ─── Sub-sections ─────────────────────────────────────────────────────────────

const BasicInfo: React.FC<{ node: any; intl: any }> = ({ node, intl }) => {
  const info = node?.status?.nodeInfo ?? {};
  const roles = nodeRoles(node);
  return (
    <Card size="small" title={intl.formatMessage({ id: 'pages.nodes.detail.basic' })}>
      <Descriptions size="small" column={2}>
        <Descriptions.Item label={intl.formatMessage({ id: 'pages.nodes.col.roles' })}>
          {roles.length === 0 ? <Text type="secondary">—</Text> : (
            <Space size={4} wrap>
              {roles.map((r) => (
                <Tag key={r} color={r === 'control-plane' || r === 'master' ? 'blue' : 'default'}>
                  {r}
                </Tag>
              ))}
            </Space>
          )}
        </Descriptions.Item>
        <Descriptions.Item label={intl.formatMessage({ id: 'pages.nodes.col.age' })}>
          {formatAge(node?.metadata?.creationTimestamp)}
        </Descriptions.Item>
        <Descriptions.Item label={intl.formatMessage({ id: 'pages.nodes.col.version' })}>
          <Text code>{info.kubeletVersion || '—'}</Text>
        </Descriptions.Item>
        <Descriptions.Item label={intl.formatMessage({ id: 'pages.nodes.col.containerRuntime' })}>
          <Text code style={{ fontSize: 11 }}>{info.containerRuntimeVersion || '—'}</Text>
        </Descriptions.Item>
        <Descriptions.Item label={intl.formatMessage({ id: 'pages.nodes.col.osImage' })} span={2}>
          {info.osImage || '—'}
        </Descriptions.Item>
        <Descriptions.Item label={intl.formatMessage({ id: 'pages.nodes.col.kernelVersion' })}>
          <Text code style={{ fontSize: 11 }}>{info.kernelVersion || '—'}</Text>
        </Descriptions.Item>
        <Descriptions.Item label={intl.formatMessage({ id: 'pages.nodes.detail.arch' })}>
          {info.architecture || '—'} / {info.operatingSystem || '—'}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
};

const Networking: React.FC<{ node: any; intl: any }> = ({ node, intl }) => {
  const addrs: { type: string; address: string }[] = node?.status?.addresses ?? [];
  const internal = addrs.find((a) => a.type === 'InternalIP')?.address;
  const external = addrs.find((a) => a.type === 'ExternalIP')?.address;
  const hostname = addrs.find((a) => a.type === 'Hostname')?.address;
  return (
    <Card size="small" title={intl.formatMessage({ id: 'pages.nodes.detail.networking' })}>
      <Descriptions size="small" column={2}>
        <Descriptions.Item label={intl.formatMessage({ id: 'pages.nodes.col.internalIp' })}>
          {internal ? <Text code>{internal}</Text> : <Text type="secondary">—</Text>}
        </Descriptions.Item>
        <Descriptions.Item label={intl.formatMessage({ id: 'pages.nodes.col.externalIp' })}>
          {external ? <Text code>{external}</Text> : <Text type="secondary">—</Text>}
        </Descriptions.Item>
        <Descriptions.Item label="Hostname">
          {hostname || <Text type="secondary">—</Text>}
        </Descriptions.Item>
        <Descriptions.Item label={intl.formatMessage({ id: 'pages.nodes.detail.podCIDR' })}>
          {node?.spec?.podCIDR ? <Text code>{node.spec.podCIDR}</Text> : <Text type="secondary">—</Text>}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
};

const Scheduling: React.FC<{ node: any; intl: any }> = ({ node, intl }) => {
  const taints: { key: string; value?: string; effect: string }[] =
    node?.spec?.taints ?? [];
  const unschedulable = !!node?.spec?.unschedulable;
  return (
    <Card size="small" title={intl.formatMessage({ id: 'pages.nodes.detail.scheduling' })}>
      <Descriptions size="small" column={2}>
        <Descriptions.Item label={intl.formatMessage({ id: 'pages.nodes.detail.unschedulable' })}>
          {unschedulable ? <Tag color="warning">true</Tag> : <Text>false</Text>}
        </Descriptions.Item>
        <Descriptions.Item label={intl.formatMessage({ id: 'pages.nodes.detail.taints' })}>
          {taints.length === 0 ? (
            <Text type="secondary">—</Text>
          ) : (
            <Space size={4} wrap>
              {taints.map((t, i) => (
                <Tag key={`${t.key}-${i}`}>
                  {t.key}{t.value ? `=${t.value}` : ''}:{t.effect}
                </Tag>
              ))}
            </Space>
          )}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
};

const Resources: React.FC<{ node: any; intl: any }> = ({ node, intl }) => {
  const cap = node?.status?.capacity ?? {};
  const alloc = node?.status?.allocatable ?? {};
  const rows = [
    { resource: 'CPU', cap: cap.cpu, alloc: alloc.cpu },
    { resource: intl.formatMessage({ id: 'pages.nodes.detail.memory' }), cap: cap.memory, alloc: alloc.memory },
    { resource: 'Pods', cap: cap.pods, alloc: alloc.pods },
  ];
  return (
    <Card size="small" title={intl.formatMessage({ id: 'pages.nodes.detail.resources' })}>
      <Table
        size="small"
        pagination={false}
        rowKey="resource"
        dataSource={rows}
        columns={[
          { title: intl.formatMessage({ id: 'pages.nodes.detail.resource' }), dataIndex: 'resource' },
          {
            title: intl.formatMessage({ id: 'pages.nodes.detail.capacity' }),
            dataIndex: 'cap',
            render: (v) => (v ? <Text code>{v}</Text> : '—'),
          },
          {
            title: intl.formatMessage({ id: 'pages.nodes.detail.allocatable' }),
            dataIndex: 'alloc',
            render: (v) => (v ? <Text code>{v}</Text> : '—'),
          },
        ]}
      />
    </Card>
  );
};

const Conditions: React.FC<{ node: any; intl: any }> = ({ node, intl }) => {
  const conds: any[] = node?.status?.conditions ?? [];
  return (
    <Card size="small" title="Conditions">
      <Table
        size="small"
        pagination={false}
        rowKey={(r) => r.type}
        dataSource={conds}
        columns={[
          { title: 'Type', dataIndex: 'type', width: 160 },
          {
            title: 'Status',
            dataIndex: 'status',
            width: 90,
            render: (v) => {
              const positive = v === 'True';
              // For Ready, True is good; for the others (MemoryPressure /
              // DiskPressure / PIDPressure / NetworkUnavailable), True is bad.
              // Just color by literal value here — the user can read the type.
              return <Tag color={positive ? 'success' : 'default'}>{v}</Tag>;
            },
          },
          { title: 'Reason', dataIndex: 'reason', width: 160 },
          { title: 'Message', dataIndex: 'message' },
        ]}
      />
    </Card>
  );
};

const KVCard: React.FC<{ title: string; entries: Record<string, string> }> = ({
  title,
  entries,
}) => {
  const items = Object.entries(entries);
  return (
    <Card
      size="small"
      title={
        <Space>
          <span>{title}</span>
          <Text type="secondary" style={{ fontWeight: 400 }}>
            ({items.length})
          </Text>
        </Space>
      }
    >
      {items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.7,
            wordBreak: 'break-all',
            maxHeight: 360,
            overflowY: 'auto',
          }}
        >
          {items.map(([k, v]) => (
            <div key={k}>
              <Text code style={{ fontSize: 11 }}>{k}</Text>
              {v ? <span style={{ color: 'rgba(0,0,0,0.65)' }}> = {v}</span> : null}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readyStatus(node: any): string {
  const conds: any[] = node?.status?.conditions ?? [];
  const ready = conds.find((c) => c.type === 'Ready');
  if (!ready) return '';
  if (node?.spec?.unschedulable) {
    return ready.status === 'True'
      ? 'Ready,SchedulingDisabled'
      : 'NotReady,SchedulingDisabled';
  }
  return ready.status === 'True' ? 'Ready' : 'NotReady';
}

function nodeRoles(node: any): string[] {
  const labels: Record<string, string> = node?.metadata?.labels ?? {};
  const roles: string[] = [];
  for (const k of Object.keys(labels)) {
    const m = k.match(/^node-role\.kubernetes\.io\/(.+)$/);
    if (m) roles.push(m[1]);
  }
  return roles;
}

// formatAge lives in pages/Compute/Volcano/shared/Layout so the
// kubectl-style "5m / 3h / 2d" rendering is consistent across the
// app. We call into it with the '—' placeholder Node-detail prefers
// for missing timestamps.
const formatAge = (rfc3339: string | undefined) =>
  sharedFormatAge(rfc3339, '—');

const StatusTag: React.FC<{ status: string }> = ({ status }) => {
  const parts = status.split(',').map((p) => p.trim()).filter(Boolean);
  return (
    <Space size={4}>
      {parts.map((p) => {
        const color =
          p === 'Ready' ? 'success' :
          p === 'NotReady' ? 'error' :
          p === 'SchedulingDisabled' ? 'warning' : 'default';
        return <Tag key={p} color={color}>{p}</Tag>;
      })}
    </Space>
  );
};

export default NodeDetailDrawer;
