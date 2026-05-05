import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useIntl, useParams } from '@umijs/max';
import { Button, Card, Empty, Progress, Space, Table, Tag, Tooltip, Typography } from 'antd';
import React, { useMemo, useState } from 'react';

import type { GPUNodeSummary } from '@/services/kpilot/gpu';

import DepGate from '../DepGate';
import { formatMB, RES_GPU, RES_GPUMEM } from '../format';
import { useGPUData } from '../useGPUData';
import NodeDetailDrawer from './NodeDetailDrawer';

interface NodeRow {
  name: string;
  status: string;
  cardCount: number;
  modelSummary: string;
  slotsUsed: number;
  slotsTotal: number;
  memUsed: number;
  memTotal: number;
  raw: GPUNodeSummary;
}

function buildRow(n: GPUNodeSummary): NodeRow {
  // Summarize model when a node has heterogeneous cards — rare but
  // possible (e.g. a workstation with V100 + 4090). Pick the most
  // common model and append "+N" if there are others.
  const modelCounts = new Map<string, number>();
  for (const d of n.devices ?? []) {
    modelCounts.set(d.type, (modelCounts.get(d.type) ?? 0) + 1);
  }
  let model = '';
  if (modelCounts.size === 1) {
    model = Array.from(modelCounts.keys())[0];
  } else if (modelCounts.size > 1) {
    const entries = Array.from(modelCounts.entries());
    entries.sort((a, b) => b[1] - a[1]);
    model = `${entries[0][0]} +${modelCounts.size - 1}`;
  }
  return {
    name: n.name,
    status: n.status,
    cardCount: n.devices?.length ?? 0,
    modelSummary: model,
    slotsUsed: n.used?.[RES_GPU] ?? 0,
    slotsTotal: n.allocatable?.[RES_GPU] ?? n.capacity?.[RES_GPU] ?? 0,
    memUsed: n.used?.[RES_GPUMEM] ?? 0,
    memTotal: n.allocatable?.[RES_GPUMEM] ?? n.capacity?.[RES_GPUMEM] ?? 0,
    raw: n,
  };
}

const ComputeNodes: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const data = useGPUData(clusterId);
  const rows = useMemo(() => data.nodes.map(buildRow), [data.nodes]);
  const [active, setActive] = useState<GPUNodeSummary | null>(null);

  return (
    <DepGate
      hamiState={data.hamiState}
      loading={data.pluginsLoading}
      onRefresh={data.refreshPlugins}
    >
      <div style={{ padding: 24 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <Typography.Title level={4} style={{ margin: 0 }}>
            {intl.formatMessage({ id: 'pages.compute.nodes.title' })}
          </Typography.Title>
          <Button
            icon={<ReloadOutlined spin={data.gpuLoading} />}
            onClick={data.refreshGPU}
          >
            {intl.formatMessage({ id: 'pages.gpu.cta.refresh' })}
          </Button>
        </div>
        {rows.length === 0 ? (
          <Card>
            <Empty description={intl.formatMessage({ id: 'pages.gpu.empty' })} />
          </Card>
        ) : (
          <Card>
            <Table<NodeRow>
              size="middle"
              rowKey="name"
              pagination={false}
              dataSource={rows}
              scroll={{ x: 'max-content' }}
              columns={[
                {
                  title: intl.formatMessage({ id: 'pages.compute.nodes.col.name' }),
                  dataIndex: 'name',
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.nodes.col.status' }),
                  dataIndex: 'status',
                  width: 110,
                  render: (v: string) => <NodeStatus status={v} />,
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.nodes.col.cards' }),
                  dataIndex: 'cardCount',
                  width: 80,
                  align: 'right',
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.nodes.col.model' }),
                  dataIndex: 'modelSummary',
                  render: (v: string) =>
                    v ? <Typography.Text code>{v}</Typography.Text> : '—',
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.nodes.col.slots' }),
                  key: 'slots',
                  width: 220,
                  render: (_, r) => (
                    <UsageBar used={r.slotsUsed} total={r.slotsTotal} kind="count" />
                  ),
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.nodes.col.memory' }),
                  key: 'memory',
                  width: 240,
                  render: (_, r) => (
                    <UsageBar used={r.memUsed} total={r.memTotal} kind="memory" />
                  ),
                },
                {
                  title: intl.formatMessage({ id: 'pages.compute.nodes.col.action' }),
                  key: 'action',
                  width: 80,
                  fixed: 'right',
                  render: (_, r) => (
                    <Button type="link" size="small" onClick={() => setActive(r.raw)}>
                      {intl.formatMessage({ id: 'pages.compute.nodes.detail' })}
                    </Button>
                  ),
                },
              ]}
            />
          </Card>
        )}
      </div>
      <NodeDetailDrawer
        node={active}
        open={active !== null}
        onClose={() => setActive(null)}
      />
    </DepGate>
  );
};

const NodeStatus: React.FC<{ status: string }> = ({ status }) => {
  switch (status) {
    case 'Ready':
      return <Tag color="success" icon={<CheckCircleFilled />}>{status}</Tag>;
    case 'NotReady':
      return <Tag color="error" icon={<CloseCircleFilled />}>{status}</Tag>;
    default:
      return <Tag icon={<ExclamationCircleOutlined />}>{status}</Tag>;
  }
};

const UsageBar: React.FC<{ used: number; total: number; kind: 'count' | 'memory' }> = ({
  used,
  total,
  kind,
}) => {
  if (total === 0) return <span>—</span>;
  const pct = Math.round((used / total) * 100);
  const label = kind === 'memory'
    ? `${formatMB(used)} / ${formatMB(total)}`
    : `${used} / ${total}`;
  return (
    <Tooltip title={label}>
      <Progress percent={pct} size="small" format={() => label} />
    </Tooltip>
  );
};

export default ComputeNodes;
