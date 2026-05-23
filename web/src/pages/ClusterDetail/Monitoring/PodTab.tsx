import { useIntl } from '@umijs/max';
import { Col, Empty, Input, Row, Select, Space, Tag } from 'antd';
import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';

import { useClusterRequest } from '@/hooks/useClusterRequest';
import {
  getPodHealth,
  getPodMetrics,
  type PodHealthRow,
  type PodMetricSeries,
  type PodMetricsResponse,
} from '@/services/kpilot/monitoring';
import { listNamespaces } from '@/services/kpilot/workload';

import LazySection, { ChartFallback, usePollingRefresh } from './LazySection';
import { useMonitoringCtx } from './MonitoringContext';

const MultiSeriesChart = lazy(() => import('./MonitoringCharts'));

// PodTab — single tab-level toolbar (namespace picker + pod search)
// drives every section's filter. Pod Health is the leading section so
// the operationally most-actionable signal (restart loops, OOMs)
// shows up first without scrolling.
//
// The namespace picker is deliberately tab-local: not tied to the
// global namespace model used by Workloads, since "monitoring this
// cluster" usually starts cluster-wide.
const PodTab: React.FC = () => {
  const intl = useIntl();
  const { clusterId } = useMonitoringCtx();
  const t = (id: string) => intl.formatMessage({ id });
  const [podNs, setPodNs] = useState('');
  const [nsList, setNsList] = useState<string[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  // Tab-global pod-name search — substring match against pod portion
  // of the series identifier (namespace is the picker's job). One
  // input above all sections so the operator doesn't re-type their
  // pod prefix on every chart.
  const [podSearch, setPodSearch] = useState('');

  useEffect(() => {
    if (!clusterId) return;
    let cancelled = false;
    setNsLoading(true);
    listNamespaces(clusterId)
      .then((list) => {
        if (!cancelled) setNsList(list ?? []);
      })
      .catch(() => {
        if (!cancelled) setNsList([]);
      })
      .finally(() => {
        if (!cancelled) setNsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Tab-global toolbar: namespace picker + pod search. Applied
          to every section below. */}
      <Space
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: '0 4px',
        }}
        size={8}
      >
        <Select
          size="small"
          style={{ width: 220 }}
          allowClear
          showSearch
          loading={nsLoading}
          placeholder={intl.formatMessage({
            id: 'pages.monitoring.filter.namespace.placeholder',
          })}
          value={podNs || undefined}
          onChange={(v) => setPodNs(v ?? '')}
          options={nsList.map((n) => ({ label: n, value: n }))}
          filterOption={(input, opt) =>
            (opt?.label as string)
              ?.toLowerCase()
              .includes(input.trim().toLowerCase())
          }
        />
        <Input.Search
          allowClear
          size="small"
          style={{ width: 220 }}
          placeholder={intl.formatMessage({
            id: 'pages.monitoring.filter.pod.placeholder',
          })}
          value={podSearch}
          onChange={(e) => setPodSearch(e.target.value)}
        />
      </Space>

      {/* Pod Health first — restart loops + OOMs are the highest-
          signal operational data and shouldn't require scrolling. */}
      <LazySection
        tab="pod"
        title={t('pages.monitoring.section.pod.health')}
        defaultOpen
      >
        {({ active }) => (
          <PodHealthSection
            active={active}
            podNs={podNs}
            podSearch={podSearch}
          />
        )}
      </LazySection>

      <LazySection
        tab="pod"
        title={t('pages.monitoring.section.pod.cpu')}
        defaultOpen
      >
        {({ active }) => (
          <PodChartSection
            active={active}
            groupKey="cpu"
            podNs={podNs}
            podSearch={podSearch}
          />
        )}
      </LazySection>
      <LazySection
        tab="pod"
        title={t('pages.monitoring.section.pod.mem')}
        defaultOpen
      >
        {({ active }) => (
          <PodChartSection
            active={active}
            groupKey="mem"
            podNs={podNs}
            podSearch={podSearch}
          />
        )}
      </LazySection>
      <LazySection
        tab="pod"
        title={t('pages.monitoring.section.pod.network')}
        defaultOpen={false}
      >
        {({ active }) => (
          <PodChartSection
            active={active}
            groupKey="network"
            podNs={podNs}
            podSearch={podSearch}
          />
        )}
      </LazySection>
      <LazySection
        tab="pod"
        title={t('pages.monitoring.section.pod.io')}
        defaultOpen={false}
      >
        {({ active }) => (
          <PodChartSection
            active={active}
            groupKey="io"
            podNs={podNs}
            podSearch={podSearch}
          />
        )}
      </LazySection>
      <LazySection
        tab="pod"
        title={t('pages.monitoring.section.pod.throttle')}
        defaultOpen={false}
      >
        {({ active }) => (
          <PodChartSection
            active={active}
            groupKey="throttle"
            podNs={podNs}
            podSearch={podSearch}
          />
        )}
      </LazySection>
      <LazySection
        tab="pod"
        title={t('pages.monitoring.section.pod.memLimit')}
        defaultOpen={false}
      >
        {({ active }) => (
          <PodChartSection
            active={active}
            groupKey="memLimit"
            podNs={podNs}
            podSearch={podSearch}
          />
        )}
      </LazySection>
    </Space>
  );
};

// PodChartSection — one section per pod metric group. groupKey drives
// which ?groups= value is fetched and which chart(s) render. Splitting
// here keeps each section to ~70 LOC instead of one mega component.
const PodChartSection: React.FC<{
  active: boolean;
  groupKey: 'cpu' | 'mem' | 'network' | 'io' | 'throttle' | 'memLimit';
  podNs: string;
  podSearch: string;
}> = ({ active, groupKey, podNs, podSearch }) => {
  const { clusterId, range, dark } = useMonitoringCtx();
  // podSearch is pushed into the server-side PromQL `pod=~...` matcher
  // so topk() runs against pods that already match. Pure client-side
  // filtering would (mis)hide the user's search target whenever it
  // wasn't already in the heaviest top-20.
  const req = useClusterRequest(
    () => getPodMetrics(clusterId, range, podNs, 20, groupKey, podSearch),
    [clusterId, range, podNs, groupKey, podSearch],
    { ready: !!clusterId },
  );
  usePollingRefresh(req.refresh, active);
  return (
    <PodChartSwitch groupKey={groupKey} data={req.data} dark={dark} />
  );
};

// PodChartSwitch — projects + renders the appropriate chart(s) for
// each groupKey. Kept as a pure component (no hooks of its own beyond
// useMemo) so the parent's hook count stays stable across re-renders
// of different keys.
const PodChartSwitch: React.FC<{
  groupKey: 'cpu' | 'mem' | 'network' | 'io' | 'throttle' | 'memLimit';
  data: PodMetricsResponse | undefined;
  dark: boolean;
}> = ({ groupKey, data, dark }) => {
  const intl = useIntl();

  // Server has already applied the pod-search filter via PromQL;
  // we just project the wire shape into chart-ready series.
  const project = (key: string) => {
    const rows = (data?.series?.[key] ?? []) as PodMetricSeries[];
    return rows.map((s) => ({
      name: `${s.namespace}/${s.pod}`,
      points: s.points,
    }));
  };

  const topN = intl.formatMessage({ id: 'pages.monitoring.topN' });

  // useMemo for each derived list. Always the same number of useMemo
  // calls per render (8) regardless of groupKey, satisfying Rules of
  // Hooks even though only one branch's data is actually shown.
  const cpu = useMemo(() => project('cpu'), [data]);
  const mem = useMemo(() => project('mem'), [data]);
  const netRx = useMemo(() => project('netRx'), [data]);
  const netTx = useMemo(() => project('netTx'), [data]);
  const fsRead = useMemo(() => project('fsRead'), [data]);
  const fsWrite = useMemo(() => project('fsWrite'), [data]);
  const cpuThrottle = useMemo(() => project('cpuThrottle'), [data]);
  const memLimitRatio = useMemo(() => project('memLimitRatio'), [data]);

  // Empty-state detection per group: the upstream check is "the
  // backend returned zero series for any key in this section". On
  // network / io that means both keys are empty.
  const isEmpty = (() => {
    switch (groupKey) {
      case 'cpu':
        return cpu.length === 0 && (data?.series?.cpu?.length ?? 0) === 0;
      case 'mem':
        return mem.length === 0 && (data?.series?.mem?.length ?? 0) === 0;
      case 'network':
        return (
          (data?.series?.netRx?.length ?? 0) === 0 &&
          (data?.series?.netTx?.length ?? 0) === 0
        );
      case 'io':
        return (
          (data?.series?.fsRead?.length ?? 0) === 0 &&
          (data?.series?.fsWrite?.length ?? 0) === 0
        );
      case 'throttle':
        return (data?.series?.cpuThrottle?.length ?? 0) === 0;
      case 'memLimit':
        return (data?.series?.memLimitRatio?.length ?? 0) === 0;
    }
  })();

  // Loading: data hasn't arrived yet (undefined). Show fallback so
  // the empty branch doesn't flash on first paint.
  if (!data) return <ChartFallback />;
  if (isEmpty) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={intl.formatMessage({
          id: 'pages.monitoring.section.pods.empty',
        })}
      />
    );
  }

  return (
    <Suspense fallback={<ChartFallback />}>
      {groupKey === 'cpu' && (
        <Row gutter={[16, 16]}>
          <Col xs={24}>
            <MultiSeriesChart
              titleId="pages.monitoring.metric.cpuByPod"
              unit="core"
              titleSuffix={topN}
              series={cpu}
              dark={dark}
              alwaysShowLegend
            />
          </Col>
        </Row>
      )}
      {groupKey === 'mem' && (
        <Row gutter={[16, 16]}>
          <Col xs={24}>
            <MultiSeriesChart
              titleId="pages.monitoring.metric.memByPod"
              unit="MiB"
              unitScale={1 / 1024 / 1024}
              titleSuffix={topN}
              series={mem}
              dark={dark}
              alwaysShowLegend
            />
          </Col>
        </Row>
      )}
      {groupKey === 'network' && (
        <Row gutter={[16, 16]}>
          <Col xs={24} xl={12}>
            <MultiSeriesChart
              titleId="pages.monitoring.metric.netRxByPod"
              unit="MiB/s"
              unitScale={1 / 1024 / 1024}
              titleSuffix={topN}
              series={netRx}
              dark={dark}
              alwaysShowLegend
            />
          </Col>
          <Col xs={24} xl={12}>
            <MultiSeriesChart
              titleId="pages.monitoring.metric.netTxByPod"
              unit="MiB/s"
              unitScale={1 / 1024 / 1024}
              titleSuffix={topN}
              series={netTx}
              dark={dark}
              alwaysShowLegend
            />
          </Col>
        </Row>
      )}
      {groupKey === 'io' && (
        <Row gutter={[16, 16]}>
          <Col xs={24} xl={12}>
            <MultiSeriesChart
              titleId="pages.monitoring.metric.fsReadByPod"
              unit="MiB/s"
              unitScale={1 / 1024 / 1024}
              titleSuffix={topN}
              series={fsRead}
              dark={dark}
              alwaysShowLegend
            />
          </Col>
          <Col xs={24} xl={12}>
            <MultiSeriesChart
              titleId="pages.monitoring.metric.fsWriteByPod"
              unit="MiB/s"
              unitScale={1 / 1024 / 1024}
              titleSuffix={topN}
              series={fsWrite}
              dark={dark}
              alwaysShowLegend
            />
          </Col>
        </Row>
      )}
      {groupKey === 'throttle' && (
        <Row gutter={[16, 16]}>
          <Col xs={24}>
            <MultiSeriesChart
              titleId="pages.monitoring.metric.cpuThrottleByPod"
              unit="%"
              titleSuffix={topN}
              series={cpuThrottle}
              dark={dark}
              alwaysShowLegend
            />
          </Col>
        </Row>
      )}
      {groupKey === 'memLimit' && (
        <Row gutter={[16, 16]}>
          <Col xs={24}>
            <MultiSeriesChart
              titleId="pages.monitoring.metric.memLimitRatioByPod"
              unit="%"
              titleSuffix={topN}
              series={memLimitRatio}
              dark={dark}
              alwaysShowLegend
            />
          </Col>
        </Row>
      )}
    </Suspense>
  );
};

// PodHealthSection — top-N restart + OOM table. Tab-global namespace
// + pod search apply here too: the namespace narrows the server-side
// fetch, the pod search narrows the rendered rows client-side.
const PodHealthSection: React.FC<{
  active: boolean;
  podNs: string;
  podSearch: string;
}> = ({ active, podNs, podSearch }) => {
  const intl = useIntl();
  const { clusterId } = useMonitoringCtx();
  // Server-side search via PromQL `pod=~...` — same reasoning as
  // PodChartSection: a client-side filter against the pre-ranked
  // top-N would silently hide the user's search target whenever it
  // wasn't already one of the noisiest restart/OOM offenders.
  const req = useClusterRequest(
    () => getPodHealth(clusterId, podNs, 10, podSearch),
    [clusterId, podNs, podSearch],
    { ready: !!clusterId },
  );
  usePollingRefresh(req.refresh, active);
  const rows = req.data?.rows ?? [];

  if (!req.data) return <ChartFallback />;
  if (rows.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={intl.formatMessage({
          id: 'pages.monitoring.podHealth.empty',
        })}
      />
    );
  }
  return (
    <table style={{ width: '100%', fontSize: 13 }}>
      <thead>
        <tr style={{ color: 'var(--ant-color-text-secondary)', textAlign: 'left' }}>
          <th style={{ padding: '6px 8px', fontWeight: 500 }}>
            {intl.formatMessage({ id: 'pages.monitoring.podHealth.col.pod' })}
          </th>
          <th
            style={{
              padding: '6px 8px',
              fontWeight: 500,
              textAlign: 'right',
              width: 120,
            }}
          >
            {intl.formatMessage({ id: 'pages.monitoring.podHealth.col.restarts' })}
          </th>
          <th
            style={{
              padding: '6px 8px',
              fontWeight: 500,
              textAlign: 'right',
              width: 120,
            }}
          >
            {intl.formatMessage({ id: 'pages.monitoring.podHealth.col.ooms' })}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r: PodHealthRow) => (
          <tr
            key={`${r.namespace}/${r.pod}`}
            style={{ borderTop: '1px solid var(--ant-color-split)' }}
          >
            <td style={{ padding: '6px 8px' }}>
              <Tag style={{ marginInlineEnd: 6 }}>{r.namespace}</Tag>
              <span>{r.pod}</span>
            </td>
            <td
              style={{
                padding: '6px 8px',
                textAlign: 'right',
                color: r.restarts > 0 ? 'var(--ant-color-warning)' : undefined,
                fontWeight: r.restarts > 0 ? 500 : 400,
              }}
            >
              {r.restarts}
            </td>
            <td
              style={{
                padding: '6px 8px',
                textAlign: 'right',
                color: r.ooms > 0 ? 'var(--ant-color-error)' : undefined,
                fontWeight: r.ooms > 0 ? 500 : 400,
              }}
            >
              {r.ooms}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export default PodTab;
