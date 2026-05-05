import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { history, useIntl, useParams, useRequest } from '@umijs/max';
import {
  Button,
  Card,
  Col,
  Empty,
  Progress,
  Result,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useEffect, useMemo } from 'react';

import { getClusterGPU, type GPUNodeSummary } from '@/services/kpilot/gpu';
import { listClusterPlugins } from '@/services/kpilot/plugin';

const HAMI_PLUGIN_NAME = 'hami';
const REFRESH_INTERVAL_MS = 10_000;

// Resource keys we surface in the UI. Anything else returned by the
// backend is preserved in the raw response but not rendered — the
// monitoring page covers per-metric drill-down.
const RES_GPU = 'nvidia.com/gpu';
const RES_GPUMEM = 'nvidia.com/gpumem';
const RES_GPUCORES = 'nvidia.com/gpucores';

interface KPIs {
  nodes: number;
  physicalCards: number;
  vGpuTotal: number;
  vGpuUsed: number;
  vGpuMemTotalMB: number;
  vGpuMemUsedMB: number;
}

function computeKPIs(nodes: GPUNodeSummary[]): KPIs {
  const k: KPIs = {
    nodes: nodes.length,
    physicalCards: 0,
    vGpuTotal: 0,
    vGpuUsed: 0,
    vGpuMemTotalMB: 0,
    vGpuMemUsedMB: 0,
  };
  for (const n of nodes) {
    k.physicalCards += n.devices?.length ?? 0;
    k.vGpuTotal += n.allocatable?.[RES_GPU] ?? n.capacity?.[RES_GPU] ?? 0;
    k.vGpuUsed += n.used?.[RES_GPU] ?? 0;
    k.vGpuMemTotalMB +=
      n.allocatable?.[RES_GPUMEM] ?? n.capacity?.[RES_GPUMEM] ?? 0;
    k.vGpuMemUsedMB += n.used?.[RES_GPUMEM] ?? 0;
  }
  return k;
}

const GPUPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();

  // Two parallel fetches: plugins list (for HAMI dep check) and the GPU
  // summary itself. We render the dep-check Result page if HAMI isn't
  // Running; otherwise we render the data even if the GPU call is still
  // loading (so the layout doesn't flash empty).
  const plugins = useRequest(() => listClusterPlugins(clusterId!), {
    formatResult: (res) => res,
    ready: !!clusterId,
    refreshDeps: [clusterId],
  });

  const gpu = useRequest(() => getClusterGPU(clusterId!), {
    formatResult: (res) => res,
    ready: !!clusterId,
    refreshDeps: [clusterId],
  });

  const hamiState = useMemo(() => {
    const item = (plugins.data ?? []).find(
      (p) => p.plugin.name === HAMI_PLUGIN_NAME,
    );
    if (!item || !item.enabled) return 'missing' as const;
    if (item.phase === 'Running') return 'ready' as const;
    if (
      item.phase === 'Pending' ||
      item.phase === 'Installing' ||
      item.phase === 'Upgrading'
    ) {
      return 'installing' as const;
    }
    if (item.phase === 'Failed') return 'failed' as const;
    return 'missing' as const;
  }, [plugins.data]);

  // Auto-refresh GPU usage while HAMI is up — pod start/stop changes
  // utilization continuously, the user expects to see new state without
  // manually clicking refresh.
  useEffect(() => {
    if (hamiState !== 'ready') return;
    const t = setInterval(() => gpu.refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
    // gpu.refresh is stable across renders — see the workload page note
    // about useRequest's refresh identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hamiState]);

  // Also re-poll plugins while HAMI is mid-install, so the page flips to
  // the data view as soon as install completes (mirrors the monitoring
  // page's recommended pattern).
  useEffect(() => {
    if (hamiState !== 'installing') return;
    const t = setInterval(() => plugins.refresh(), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hamiState]);

  const goToPlugins = () =>
    history.push(`/clusters/${clusterId}/plugins`);

  // Dep-check sad paths first — they own the whole viewport when active.
  if (plugins.loading && !plugins.data) {
    return (
      <div style={{ padding: 24 }}>
        <Card loading style={{ minHeight: 200 }} />
      </div>
    );
  }
  if (hamiState !== 'ready') {
    const titleKey = `pages.gpu.${hamiState}.title`;
    const subTitleKey = `pages.gpu.${hamiState}.subTitle`;
    const status = hamiState === 'failed' ? 'error' : hamiState === 'installing' ? 'info' : 'warning';
    return (
      <Result
        status={status as 'error' | 'info' | 'warning'}
        title={intl.formatMessage({ id: titleKey })}
        subTitle={intl.formatMessage({ id: subTitleKey })}
        extra={[
          <Button key="enable" type="primary" onClick={goToPlugins}>
            {intl.formatMessage({ id: 'pages.gpu.cta.goPlugins' })}
          </Button>,
          <Button
            key="refresh"
            icon={<ReloadOutlined />}
            onClick={() => plugins.refresh()}
          >
            {intl.formatMessage({ id: 'pages.gpu.cta.refresh' })}
          </Button>,
        ]}
      />
    );
  }

  const nodes = gpu.data ?? [];
  const kpis = computeKPIs(nodes);

  return (
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
          {intl.formatMessage({ id: 'pages.gpu.title' })}
        </Typography.Title>
        <Space>
          <Button
            icon={<ReloadOutlined spin={gpu.loading} />}
            onClick={() => gpu.refresh()}
          >
            {intl.formatMessage({ id: 'pages.gpu.cta.refresh' })}
          </Button>
        </Space>
      </div>

      {/* Cluster-wide KPIs */}
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
              percent={kpis.vGpuTotal > 0 ? Math.round((kpis.vGpuUsed / kpis.vGpuTotal) * 100) : 0}
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

      {/* Per-node detail. Cards stack vertically; each one shows physical
          devices, slot/memory utilization, and pods. */}
      {nodes.length === 0 ? (
        <Card>
          <Empty description={intl.formatMessage({ id: 'pages.gpu.empty' })} />
        </Card>
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {nodes.map((n) => (
            <NodeCard key={n.name} node={n} />
          ))}
        </Space>
      )}
    </div>
  );
};

const NodeCard: React.FC<{ node: GPUNodeSummary }> = ({ node }) => {
  const intl = useIntl();
  const slotsTotal =
    node.allocatable?.[RES_GPU] ?? node.capacity?.[RES_GPU] ?? 0;
  const slotsUsed = node.used?.[RES_GPU] ?? 0;
  const memTotal =
    node.allocatable?.[RES_GPUMEM] ?? node.capacity?.[RES_GPUMEM] ?? 0;
  const memUsed = node.used?.[RES_GPUMEM] ?? 0;

  const statusTag = (() => {
    switch (node.status) {
      case 'Ready':
        return <Tag color="success" icon={<CheckCircleFilled />}>{node.status}</Tag>;
      case 'NotReady':
        return <Tag color="error" icon={<CloseCircleFilled />}>{node.status}</Tag>;
      default:
        return <Tag icon={<ExclamationCircleOutlined />}>{node.status}</Tag>;
    }
  })();

  const devices = node.devices ?? [];
  const pods = node.pods ?? [];

  return (
    <Card
      title={
        <Space>
          <ThunderboltOutlined />
          <span style={{ fontWeight: 600 }}>{node.name}</span>
          {statusTag}
        </Space>
      }
      // Footer-style sub-content via `extra` would crowd the title; use
      // body sections instead.
    >
      {/* Utilization bars: vGPU slots + memory. Show both even if HAMI
          isn't doing memory virtualization (memTotal=0 just hides the
          bar). */}
      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Typography.Text type="secondary">
            {intl.formatMessage({ id: 'pages.gpu.node.slots' })}
          </Typography.Text>
          <Progress
            percent={slotsTotal > 0 ? Math.round((slotsUsed / slotsTotal) * 100) : 0}
            format={() => `${slotsUsed} / ${slotsTotal}`}
            status={slotsUsed >= slotsTotal && slotsTotal > 0 ? 'exception' : 'active'}
          />
        </Col>
        {memTotal > 0 && (
          <Col xs={24} md={12}>
            <Typography.Text type="secondary">
              {intl.formatMessage({ id: 'pages.gpu.node.memory' })}
            </Typography.Text>
            <Progress
              percent={Math.round((memUsed / memTotal) * 100)}
              format={() => `${formatMB(memUsed)} / ${formatMB(memTotal)}`}
            />
          </Col>
        )}
      </Row>

      {/* Per-card detail from HAMI annotation. Hidden on standard NVIDIA
          plugin (no devices array). */}
      {devices.length > 0 && (
        <>
          <Typography.Title level={5} style={{ marginTop: 16 }}>
            {intl.formatMessage({ id: 'pages.gpu.node.devices' })}
          </Typography.Title>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={devices}
            columns={[
              {
                title: intl.formatMessage({ id: 'pages.gpu.node.devices.type' }),
                dataIndex: 'type',
              },
              {
                title: intl.formatMessage({ id: 'pages.gpu.node.devices.id' }),
                dataIndex: 'id',
                render: (v: string) => (
                  <Tooltip title={v}>
                    <Typography.Text code style={{ fontSize: 12 }}>
                      {v.length > 20 ? v.slice(0, 20) + '…' : v}
                    </Typography.Text>
                  </Tooltip>
                ),
              },
              {
                title: intl.formatMessage({ id: 'pages.gpu.node.devices.slots' }),
                dataIndex: 'count',
                width: 80,
                align: 'right',
              },
              {
                title: intl.formatMessage({ id: 'pages.gpu.node.devices.memory' }),
                dataIndex: 'devmem',
                width: 120,
                align: 'right',
                render: (v: number) => formatMB(v),
              },
              {
                title: intl.formatMessage({ id: 'pages.gpu.node.devices.cores' }),
                dataIndex: 'devcore',
                width: 80,
                align: 'right',
                render: (v: number) => `${v}%`,
              },
              {
                title: intl.formatMessage({ id: 'pages.gpu.node.devices.numa' }),
                dataIndex: 'numa',
                width: 60,
                align: 'right',
              },
              {
                title: intl.formatMessage({ id: 'pages.gpu.node.devices.health' }),
                dataIndex: 'health',
                width: 80,
                render: (v: boolean) =>
                  v ? (
                    <Tag color="success">{intl.formatMessage({ id: 'pages.gpu.node.devices.health.ok' })}</Tag>
                  ) : (
                    <Tag color="error">{intl.formatMessage({ id: 'pages.gpu.node.devices.health.bad' })}</Tag>
                  ),
              },
            ]}
          />
        </>
      )}

      {/* Pods using GPU on this node. */}
      <Typography.Title level={5} style={{ marginTop: 16 }}>
        {intl.formatMessage({ id: 'pages.gpu.node.pods' })}
      </Typography.Title>
      {pods.length === 0 ? (
        <Typography.Text type="secondary">
          {intl.formatMessage({ id: 'pages.gpu.node.pods.empty' })}
        </Typography.Text>
      ) : (
        <Table
          size="small"
          rowKey={(r) => `${r.namespace}/${r.name}`}
          pagination={false}
          dataSource={pods}
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
              title: intl.formatMessage({ id: 'pages.gpu.node.pods.phase' }),
              dataIndex: 'phase',
              width: 100,
              render: (v: string) => <Tag>{v}</Tag>,
            },
            {
              title: intl.formatMessage({ id: 'pages.gpu.node.pods.gpu' }),
              key: 'gpu',
              width: 80,
              align: 'right',
              render: (_, r) => r.requests[RES_GPU] ?? 0,
            },
            {
              title: intl.formatMessage({ id: 'pages.gpu.node.pods.gpumem' }),
              key: 'gpumem',
              width: 120,
              align: 'right',
              render: (_, r) => formatMB(r.requests[RES_GPUMEM] ?? 0),
            },
            {
              title: intl.formatMessage({ id: 'pages.gpu.node.pods.gpucores' }),
              key: 'gpucores',
              width: 100,
              align: 'right',
              render: (_, r) => `${r.requests[RES_GPUCORES] ?? 0}%`,
            },
          ]}
        />
      )}
    </Card>
  );
};

// formatMB renders an MB integer as either MiB or GiB depending on size.
// HAMI memory advertises in MB so this is the right unit; we translate
// to GiB visually once a value exceeds ~1 GB to keep numbers readable.
function formatMB(mb: number): string {
  if (mb <= 0) return '0 MiB';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GiB`;
  return `${mb} MiB`;
}

export default GPUPage;
