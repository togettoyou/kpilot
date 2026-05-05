import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useIntl, useParams } from '@umijs/max';
import { Button, Card, Col, Empty, Progress, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import React, { useMemo } from 'react';

import type { GPUNodeSummary } from '@/services/kpilot/gpu';

import DepGate from '../DepGate';
import { formatMB, RES_GPU, RES_GPUMEM } from '../format';
import { useGPUData } from '../useGPUData';

interface KPIs {
  nodes: number;
  physicalCards: number;
  vGpuTotal: number;
  vGpuUsed: number;
  vGpuMemTotalMB: number;
  vGpuMemUsedMB: number;
  cardModelDist: Map<string, number>;
}

function computeKPIs(nodes: GPUNodeSummary[]): KPIs {
  const k: KPIs = {
    nodes: nodes.length,
    physicalCards: 0,
    vGpuTotal: 0,
    vGpuUsed: 0,
    vGpuMemTotalMB: 0,
    vGpuMemUsedMB: 0,
    cardModelDist: new Map(),
  };
  for (const n of nodes) {
    k.physicalCards += n.devices?.length ?? 0;
    k.vGpuTotal += n.allocatable?.[RES_GPU] ?? n.capacity?.[RES_GPU] ?? 0;
    k.vGpuUsed += n.used?.[RES_GPU] ?? 0;
    k.vGpuMemTotalMB +=
      n.allocatable?.[RES_GPUMEM] ?? n.capacity?.[RES_GPUMEM] ?? 0;
    k.vGpuMemUsedMB += n.used?.[RES_GPUMEM] ?? 0;
    for (const d of n.devices ?? []) {
      k.cardModelDist.set(d.type, (k.cardModelDist.get(d.type) ?? 0) + 1);
    }
  }
  return k;
}

const ComputeOverview: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const data = useGPUData(clusterId);
  const kpis = useMemo(() => computeKPIs(data.nodes), [data.nodes]);

  return (
    <DepGate
      hamiState={data.hamiState}
      loading={data.pluginsLoading}
      onRefresh={data.refreshPlugins}
    >
      <div style={{ padding: 24 }}>
        <Header
          title={intl.formatMessage({ id: 'pages.compute.overview.title' })}
          loading={data.gpuLoading}
          onRefresh={data.refreshGPU}
        />
        {/* Cluster-wide KPI strip — same layout as the original combined
            page, just without the per-node detail underneath. */}
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <Card>
              <Statistic
                title={intl.formatMessage({ id: 'pages.gpu.kpi.nodes' })}
                value={kpis.nodes}
                prefix={<ThunderboltOutlined style={{ color: '#1677ff' }} />}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card>
              <Statistic
                title={intl.formatMessage({ id: 'pages.gpu.kpi.cards' })}
                value={kpis.physicalCards}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card>
              <Statistic
                title={intl.formatMessage({ id: 'pages.gpu.kpi.vgpuUsage' })}
                value={kpis.vGpuUsed}
                suffix={`/ ${kpis.vGpuTotal}`}
              />
              <Progress
                percent={kpis.vGpuTotal > 0
                  ? Math.round((kpis.vGpuUsed / kpis.vGpuTotal) * 100)
                  : 0}
                size="small"
                showInfo={false}
                style={{ marginTop: 8 }}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card>
              <Statistic
                title={intl.formatMessage({ id: 'pages.gpu.kpi.memUsage' })}
                value={formatMB(kpis.vGpuMemUsedMB)}
                suffix={`/ ${formatMB(kpis.vGpuMemTotalMB)}`}
              />
              <Progress
                percent={kpis.vGpuMemTotalMB > 0
                  ? Math.round((kpis.vGpuMemUsedMB / kpis.vGpuMemTotalMB) * 100)
                  : 0}
                size="small"
                showInfo={false}
                style={{ marginTop: 8 }}
              />
            </Card>
          </Col>
        </Row>

        {/* GPU model distribution. Useful for clusters with mixed cards
            (V100 + A100 + 4090 etc.) — operator can see at a glance how
            their fleet is composed. */}
        {kpis.cardModelDist.size > 0 && (
          <Card
            title={intl.formatMessage({ id: 'pages.compute.overview.modelDist' })}
            style={{ marginBottom: 16 }}
          >
            <Space wrap>
              {Array.from(kpis.cardModelDist.entries()).map(([type, count]) => (
                <Tag key={type} color="blue" style={{ fontSize: 14, padding: '4px 10px' }}>
                  {type} × {count}
                </Tag>
              ))}
            </Space>
          </Card>
        )}

        {/* Top consumers: top 5 pods by allocated memory across the
            cluster. Quick "who's hogging the cards" view without
            needing to click into Tasks. */}
        <TopConsumers nodes={data.nodes} />

        {kpis.nodes === 0 && (
          <Card>
            <Empty description={intl.formatMessage({ id: 'pages.gpu.empty' })} />
          </Card>
        )}
      </div>
    </DepGate>
  );
};

const Header: React.FC<{ title: string; loading: boolean; onRefresh: () => void }> = ({
  title,
  loading,
  onRefresh,
}) => {
  const intl = useIntl();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
      }}
    >
      <Typography.Title level={4} style={{ margin: 0 }}>
        {title}
      </Typography.Title>
      <Button icon={<ReloadOutlined spin={loading} />} onClick={onRefresh}>
        {intl.formatMessage({ id: 'pages.gpu.cta.refresh' })}
      </Button>
    </div>
  );
};

interface ConsumerRow {
  namespace: string;
  name: string;
  node: string;
  cardUUID: string;
  cardType: string;
  mem: number;
  cores: number;
}

const TopConsumers: React.FC<{ nodes: GPUNodeSummary[] }> = ({ nodes }) => {
  const intl = useIntl();
  const rows = useMemo<ConsumerRow[]>(() => {
    const out: ConsumerRow[] = [];
    for (const n of nodes) {
      for (const c of n.cards ?? []) {
        for (const p of c.pods ?? []) {
          out.push({
            namespace: p.namespace,
            name: p.name,
            node: n.name,
            cardUUID: c.uuid,
            cardType: c.type,
            mem: p.mem,
            cores: p.cores,
          });
        }
      }
    }
    out.sort((a, b) => b.mem - a.mem);
    return out.slice(0, 5);
  }, [nodes]);

  if (rows.length === 0) return null;
  return (
    <Card title={intl.formatMessage({ id: 'pages.compute.overview.topConsumers' })}>
      <Table
        size="small"
        rowKey={(r) => `${r.namespace}/${r.name}/${r.cardUUID}`}
        pagination={false}
        dataSource={rows}
        columns={[
          {
            title: intl.formatMessage({ id: 'pages.gpu.node.pods.namespace' }),
            dataIndex: 'namespace',
          },
          {
            title: intl.formatMessage({ id: 'pages.gpu.node.pods.name' }),
            dataIndex: 'name',
          },
          {
            title: intl.formatMessage({ id: 'pages.compute.overview.col.node' }),
            dataIndex: 'node',
          },
          {
            title: intl.formatMessage({ id: 'pages.compute.overview.col.card' }),
            dataIndex: 'cardType',
          },
          {
            title: intl.formatMessage({ id: 'pages.gpu.card.podMem' }),
            dataIndex: 'mem',
            width: 120,
            align: 'right',
            render: (v: number) => formatMB(v),
          },
          {
            title: intl.formatMessage({ id: 'pages.gpu.card.podCores' }),
            dataIndex: 'cores',
            width: 100,
            align: 'right',
            render: (v: number) => `${v}%`,
          },
        ]}
      />
    </Card>
  );
};

export default ComputeOverview;
