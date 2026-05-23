import { useIntl } from '@umijs/max';
import { Col, Row, Select, Space } from 'antd';
import React, {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { useClusterRequest } from '@/hooks/useClusterRequest';
import {
  getNodeMetrics,
  type NodeMetricSeries,
  type NodeMetricsResponse,
} from '@/services/kpilot/monitoring';
import { listNodes } from '@/services/kpilot/node';

import LazySection, { ChartFallback, usePollingRefresh } from './LazySection';
import { useMonitoringCtx } from './MonitoringContext';

const MultiSeriesChart = lazy(() => import('./MonitoringCharts'));

// NodeTab — five sections, one per resource dimension. Each section
// owns its own fetch with a single ?groups= value and chart Row.
// A single tab-level node picker (multi-select) narrows ALL sections
// at once — the previous per-section text filter forced the operator
// to re-type the same node name on each row they wanted to focus on,
// which was busywork in clusters with more than a handful of nodes.
//
// Sections:
//   cpu      — utilization + load average (1/5/15) + load-per-core
//   mem      — utilization% + absolute bytes used
//   disk     — utilization% + per-mountpoint% + inode%
//   network  — Rx/Tx, errors, TCP connections, TCP retransmits
//   storage  — block-device I/O bandwidth + IOPS + iowait/svctm/%util
const NodeTab: React.FC = () => {
  const intl = useIntl();
  const { clusterId } = useMonitoringCtx();
  const t = (id: string) => intl.formatMessage({ id });
  // Tab-global node picker — empty array means "all nodes".
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [nodeOptions, setNodeOptions] = useState<string[]>([]);
  const [nodeLoading, setNodeLoading] = useState(false);
  useEffect(() => {
    if (!clusterId) return;
    let cancelled = false;
    setNodeLoading(true);
    listNodes(clusterId, 500)
      .then((tbl) => {
        if (cancelled) return;
        // Table API: prefer object.metadata.name when present,
        // fall back to the first cell (kubectl's NAME column).
        const names = (tbl?.rows ?? [])
          .map(
            (r: any) => r?.object?.metadata?.name ?? r?.cells?.[0] ?? '',
          )
          .filter((n: string) => !!n);
        setNodeOptions(names);
      })
      .catch(() => {
        if (!cancelled) setNodeOptions([]);
      })
      .finally(() => {
        if (!cancelled) setNodeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId]);

  const filterSet = useMemo(
    () => new Set(selectedNodes),
    [selectedNodes],
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Tab-global node picker. Right-aligned to mirror the Pod
          tab's namespace picker, which sits in the same spot. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: '0 4px',
        }}
      >
        <Select
          mode="multiple"
          allowClear
          size="small"
          showSearch
          loading={nodeLoading}
          style={{ minWidth: 260, maxWidth: 480 }}
          placeholder={intl.formatMessage({
            id: 'pages.monitoring.filter.node.placeholder',
          })}
          value={selectedNodes}
          onChange={setSelectedNodes}
          options={nodeOptions.map((n) => ({ label: n, value: n }))}
          maxTagCount="responsive"
          filterOption={(input, opt) =>
            (opt?.label as string)
              ?.toLowerCase()
              .includes(input.trim().toLowerCase())
          }
        />
      </div>

      <LazySection
        tab="node"
        title={t('pages.monitoring.section.node.cpu')}
        defaultOpen
      >
        {({ active }) => <CpuSection active={active} filterSet={filterSet} />}
      </LazySection>
      <LazySection
        tab="node"
        title={t('pages.monitoring.section.node.mem')}
        defaultOpen
      >
        {({ active }) => <MemSection active={active} filterSet={filterSet} />}
      </LazySection>
      <LazySection
        tab="node"
        title={t('pages.monitoring.section.node.disk')}
        defaultOpen={false}
      >
        {({ active }) => <DiskSection active={active} filterSet={filterSet} />}
      </LazySection>
      <LazySection
        tab="node"
        title={t('pages.monitoring.section.node.network')}
        defaultOpen={false}
      >
        {({ active }) => (
          <NetworkSection active={active} filterSet={filterSet} />
        )}
      </LazySection>
      <LazySection
        tab="node"
        title={t('pages.monitoring.section.node.storage')}
        defaultOpen={false}
      >
        {({ active }) => (
          <StorageSection active={active} filterSet={filterSet} />
        )}
      </LazySection>
    </Space>
  );
};

// projectSeries — pure projection helper. Maps the wire format
// (NodeMetricSeries[]) into the chart's `{ name, points }` shape and
// applies the tab-global node picker filter (empty Set = no filter,
// show all). Called inside useMemo at the section component's top
// level so the hook count stays stable.
function projectSeries(
  data: NodeMetricsResponse | undefined,
  key: string,
  filterSet: Set<string>,
  breakdown?: 'mountpoint' | 'device',
): { name: string; points: { ts: number; value: number }[] }[] {
  const rows = (data?.series?.[key] ?? []) as NodeMetricSeries[];
  const out = rows.map((s) => {
    const base = s.nodeName || s.instance;
    let label = base;
    if (breakdown === 'mountpoint' && s.mountpoint) {
      label = `${base} ${s.mountpoint}`;
    } else if (breakdown === 'device' && s.device) {
      label = `${base} ${s.device}`;
    }
    return { name: label, base, points: s.points };
  });
  if (filterSet.size === 0) return out;
  return out.filter((r) => filterSet.has(r.base));
}

type SectionProps = { active: boolean; filterSet: Set<string> };

const CpuSection: React.FC<SectionProps> = ({ active, filterSet }) => {
  const { clusterId, range, dark } = useMonitoringCtx();
  const req = useClusterRequest(
    () => getNodeMetrics(clusterId, range, 'cpu'),
    [clusterId, range],
    { ready: !!clusterId },
  );
  usePollingRefresh(req.refresh, active);
  const data = req.data;
  const cpu = useMemo(() => projectSeries(data, 'cpu', filterSet), [data, filterSet]);
  const loadPerCore = useMemo(
    () => projectSeries(data, 'loadPerCore', filterSet),
    [data, filterSet],
  );
  const load1 = useMemo(() => projectSeries(data, 'load1', filterSet), [data, filterSet]);
  const load5 = useMemo(() => projectSeries(data, 'load5', filterSet), [data, filterSet]);
  const load15 = useMemo(
    () => projectSeries(data, 'load15', filterSet),
    [data, filterSet],
  );
  return (
    <Suspense fallback={<ChartFallback />}>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.cpuByNode"
            unit="%"
            yMax={100}
            series={cpu}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.loadByNode"
            unit=""
            series={loadPerCore}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.load1"
            unit=""
            series={load1}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.load5"
            unit=""
            series={load5}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.load15"
            unit=""
            series={load15}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
      </Row>
    </Suspense>
  );
};

const MemSection: React.FC<SectionProps> = ({ active, filterSet }) => {
  const { clusterId, range, dark } = useMonitoringCtx();
  const req = useClusterRequest(
    () => getNodeMetrics(clusterId, range, 'mem'),
    [clusterId, range],
    { ready: !!clusterId },
  );
  usePollingRefresh(req.refresh, active);
  const data = req.data;
  const mem = useMemo(() => projectSeries(data, 'mem', filterSet), [data, filterSet]);
  const memUsed = useMemo(
    () => projectSeries(data, 'memUsed', filterSet),
    [data, filterSet],
  );
  return (
    <Suspense fallback={<ChartFallback />}>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.memByNode"
            unit="%"
            yMax={100}
            series={mem}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.memUsedBytes"
            unit="GiB"
            unitScale={1 / 1024 / 1024 / 1024}
            series={memUsed}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
      </Row>
    </Suspense>
  );
};

const DiskSection: React.FC<SectionProps> = ({ active, filterSet }) => {
  const { clusterId, range, dark } = useMonitoringCtx();
  const req = useClusterRequest(
    () => getNodeMetrics(clusterId, range, 'disk'),
    [clusterId, range],
    { ready: !!clusterId },
  );
  usePollingRefresh(req.refresh, active);
  const data = req.data;
  const disk = useMemo(() => projectSeries(data, 'disk', filterSet), [data, filterSet]);
  const partitions = useMemo(
    () => projectSeries(data, 'diskPartitions', filterSet, 'mountpoint'),
    [data, filterSet],
  );
  const inode = useMemo(
    () => projectSeries(data, 'inodeUtil', filterSet),
    [data, filterSet],
  );
  return (
    <Suspense fallback={<ChartFallback />}>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.diskByNode"
            unit="%"
            yMax={100}
            series={disk}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.diskPartitions"
            unit="%"
            yMax={100}
            series={partitions}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.inodeByNode"
            unit="%"
            yMax={100}
            series={inode}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
      </Row>
    </Suspense>
  );
};

const NetworkSection: React.FC<SectionProps> = ({ active, filterSet }) => {
  const { clusterId, range, dark } = useMonitoringCtx();
  const req = useClusterRequest(
    () => getNodeMetrics(clusterId, range, 'network'),
    [clusterId, range],
    { ready: !!clusterId },
  );
  usePollingRefresh(req.refresh, active);
  const data = req.data;
  const netRx = useMemo(() => projectSeries(data, 'netRx', filterSet), [data, filterSet]);
  const netTx = useMemo(() => projectSeries(data, 'netTx', filterSet), [data, filterSet]);
  const errors = useMemo(
    () => projectSeries(data, 'netErrors', filterSet),
    [data, filterSet],
  );
  const tcpConns = useMemo(
    () => projectSeries(data, 'tcpConns', filterSet),
    [data, filterSet],
  );
  const tcpRetrans = useMemo(
    () => projectSeries(data, 'tcpRetrans', filterSet),
    [data, filterSet],
  );
  // Combine Rx/Tx onto one chart with directional suffixes — the
  // upload/download symmetry is the operator-relevant signal.
  const rxTx = useMemo(
    () => [
      ...netRx.map((s) => ({ ...s, name: `${s.name} ↓` })),
      ...netTx.map((s) => ({ ...s, name: `${s.name} ↑` })),
    ],
    [netRx, netTx],
  );
  return (
    <Suspense fallback={<ChartFallback />}>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.netByNode"
            unit="MiB/s"
            unitScale={1 / 1024 / 1024}
            series={rxTx}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.netErrorsByNode"
            unit="errs/s"
            series={errors}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.tcpConns"
            unit=""
            series={tcpConns}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.tcpRetransByNode"
            unit="segs/s"
            series={tcpRetrans}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
      </Row>
    </Suspense>
  );
};

const StorageSection: React.FC<SectionProps> = ({ active, filterSet }) => {
  const intl = useIntl();
  const { clusterId, range, dark } = useMonitoringCtx();
  const readLabel = intl.formatMessage({
    id: 'pages.monitoring.direction.read',
  });
  const writeLabel = intl.formatMessage({
    id: 'pages.monitoring.direction.write',
  });
  const req = useClusterRequest(
    () => getNodeMetrics(clusterId, range, 'storage'),
    [clusterId, range],
    { ready: !!clusterId },
  );
  usePollingRefresh(req.refresh, active);
  const data = req.data;
  const diskRead = useMemo(
    () => projectSeries(data, 'diskRead', filterSet),
    [data, filterSet],
  );
  const diskWrite = useMemo(
    () => projectSeries(data, 'diskWrite', filterSet),
    [data, filterSet],
  );
  const diskReadOps = useMemo(
    () => projectSeries(data, 'diskReadOps', filterSet),
    [data, filterSet],
  );
  const diskWriteOps = useMemo(
    () => projectSeries(data, 'diskWriteOps', filterSet),
    [data, filterSet],
  );
  const ioWait = useMemo(
    () => projectSeries(data, 'diskIOWait', filterSet, 'device'),
    [data, filterSet],
  );
  const ioService = useMemo(
    () => projectSeries(data, 'diskIOService', filterSet, 'device'),
    [data, filterSet],
  );
  const ioBusy = useMemo(
    () => projectSeries(data, 'diskIOBusy', filterSet, 'device'),
    [data, filterSet],
  );
  const readWrite = useMemo(
    () => [
      ...diskRead.map((s) => ({ ...s, name: `${s.name} · ${readLabel}` })),
      ...diskWrite.map((s) => ({ ...s, name: `${s.name} · ${writeLabel}` })),
    ],
    [diskRead, diskWrite, readLabel, writeLabel],
  );
  const iops = useMemo(
    () => [
      ...diskReadOps.map((s) => ({ ...s, name: `${s.name} · ${readLabel}` })),
      ...diskWriteOps.map((s) => ({ ...s, name: `${s.name} · ${writeLabel}` })),
    ],
    [diskReadOps, diskWriteOps, readLabel, writeLabel],
  );
  return (
    <Suspense fallback={<ChartFallback />}>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.diskIoByNode"
            unit="MiB/s"
            unitScale={1 / 1024 / 1024}
            series={readWrite}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.diskIopsByNode"
            unit="ops/s"
            series={iops}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.diskIoWait"
            unit="ms"
            unitScale={1000}
            series={ioWait}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.diskIoService"
            unit="ms"
            unitScale={1000}
            series={ioService}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
        <Col xs={24} xl={12}>
          <MultiSeriesChart
            titleId="pages.monitoring.metric.diskIoBusy"
            unit="%"
            yMax={100}
            series={ioBusy}
            dark={dark}
            alwaysShowLegend
          />
        </Col>
      </Row>
    </Suspense>
  );
};

export default NodeTab;
