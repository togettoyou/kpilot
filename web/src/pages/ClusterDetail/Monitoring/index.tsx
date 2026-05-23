import { useIntl, useParams } from '@umijs/max';
import { Card, Col, Result, Row, Space, Spin, Tabs, Typography } from 'antd';
import { useThemeMode } from 'antd-style';
import React, { useCallback, useEffect, useState } from 'react';

import TimeRangePicker, {
  type TimeRangeValue,
} from '@/components/TimeRangePicker';
import { useClusterRequest } from '@/hooks/useClusterRequest';
import {
  isResourceNotAvailable,
  NotInstalled,
  RefreshControl,
  useAutoRefresh,
} from '@/pages/Compute/Volcano/shared/Layout';
import { getClusterMetrics } from '@/services/kpilot/monitoring';

import ClusterTab from './ClusterTab';
import { MonitoringCtx, type MonitoringTab } from './MonitoringContext';
import NodeTab from './NodeTab';
import PodTab from './PodTab';

// /clusters/:id/monitoring v2 — three-tab shell.
//
// Each tab body owns its own data, polling, and filter state. The
// shell only manages: range picker, refresh interval, active tab,
// and a shared polling tick that bumps on every interval fire.
// Sections inside the tabs subscribe to the tick and refresh
// themselves when active (visible tab + expanded section). Hidden
// tabs stay mounted (antd Tabs default) so flipping between them is
// instant and last-seen data survives.
//
// First-paint gate: a single tiny "probe" fetch hits cluster-metrics
// with ?groups=overview just to detect whether VictoriaMetrics is
// installed; on RESOURCE_NOT_AVAILABLE the page swaps to a single
// NotInstalled splash. Probe data is NOT piped to any section — each
// tab/section owns its own fetch so tabs stay self-contained — but
// the 4s server-side response cache makes the overlap with
// ClusterTab.OverviewBody (which also fetches ?groups=overview)
// essentially one upstream round-trip.
const MonitoringPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { isDarkMode } = useThemeMode();

  const [range, setRange] = useState<TimeRangeValue>({
    mode: 'preset',
    preset: '1h',
  });
  const [activeTab, setActiveTab] = useState<MonitoringTab>('cluster');
  // Polling tick — incremented by useAutoRefresh on every interval
  // fire. Sections subscribe to this via usePollingRefresh; only
  // sections in the active tab + expanded actually refetch.
  const [tick, setTick] = useState(0);
  // "Last refreshed" — bumped together with tick (auto or manual).
  // Drives the header timestamp. Decoupled from probe.data.generatedAt
  // so polling actually moves the indicator forward; probe doesn't
  // re-fetch on tick and using its generatedAt left the header frozen
  // at first-paint time.
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  // Probe — single fetch at page level that detects whether VM is
  // installed. Used only for the RESOURCE_NOT_AVAILABLE gate; we
  // intentionally do not pipe its data through to any section so
  // tabs own their own state. Re-fires when clusterId / range
  // changes (covers cluster swap + range picker), not on poll —
  // ClusterTab's overview section already does the polling work.
  const probe = useClusterRequest(
    () => getClusterMetrics(clusterId!, range, 'overview'),
    [clusterId, range],
    { ready: !!clusterId },
  );

  // Seed refreshedAt the first time probe data lands so the header
  // shows something useful pre-polling.
  useEffect(() => {
    if (probe.data && !refreshedAt) {
      setRefreshedAt(new Date(probe.data.generatedAt));
    }
  }, [probe.data, refreshedAt]);

  const bumpTick = useCallback(() => {
    setTick((t) => t + 1);
    setRefreshedAt(new Date());
  }, []);
  const [interval, setIntervalMs] = useAutoRefresh(bumpTick, !!clusterId);

  if (!clusterId) return null;

  if (probe.error && isResourceNotAvailable(probe.error)) {
    return (
      <NotInstalled
        clusterId={clusterId}
        titleId="pages.monitoring.notInstalled.title"
        subTitleId="pages.monitoring.notInstalled.subTitle"
        actionId="pages.monitoring.notInstalled.action"
      />
    );
  }

  // First-paint placeholder — only while the probe is in flight and
  // hasn't errored. After the first response (even an error), the
  // tabs take over.
  if (!probe.data && !probe.error) {
    return (
      <div className="p-6" style={{ textAlign: 'center' }}>
        <Spin size="large" style={{ marginTop: 48 }} />
      </div>
    );
  }

  return (
    <MonitoringCtx.Provider
      value={{
        clusterId,
        range,
        tick,
        activeTab,
        dark: isDarkMode,
      }}
    >
      <div className="p-6">
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {/* Header — range picker + refresh control + last update
              timestamp. Sits above the tabs because it applies to
              every tab. */}
          <Card size="small" styles={{ body: { padding: '8px 16px' } }}>
            <Row justify="space-between" align="middle" wrap>
              <Col>
                <Space>
                  <Typography.Text strong>
                    {intl.formatMessage({ id: 'pages.monitoring.title' })}
                  </Typography.Text>
                  {refreshedAt && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {intl.formatMessage(
                        { id: 'pages.monitoring.generatedAt' },
                        { ts: refreshedAt.toLocaleString() },
                      )}
                    </Typography.Text>
                  )}
                </Space>
              </Col>
              <Col>
                <Space>
                  <TimeRangePicker value={range} onChange={setRange} />
                  <RefreshControl
                    interval={interval}
                    setInterval={setIntervalMs}
                    refresh={bumpTick}
                    loading={false}
                  />
                </Space>
              </Col>
            </Row>
          </Card>

          {/* Tabs — destroyOnHidden=true unmounts the hidden tab's
              entire subtree, so chart instances tear down cleanly
              and a return visit re-fetches + re-mounts fresh. We
              tried preserving state across switches but G2's
              autoFit (window-resize based, NOT ResizeObserver)
              corrupts hidden plots when other tabs' content
              reflows the viewport; the only reliable fix is to
              just not keep them around. */}
          <Tabs
            activeKey={activeTab}
            onChange={(k) => setActiveTab(k as MonitoringTab)}
            destroyOnHidden
            items={[
              {
                key: 'cluster',
                label: intl.formatMessage({ id: 'pages.monitoring.tab.cluster' }),
                children: <ClusterTab />,
              },
              {
                key: 'node',
                label: intl.formatMessage({ id: 'pages.monitoring.tab.node' }),
                children: <NodeTab />,
              },
              {
                key: 'pod',
                label: intl.formatMessage({ id: 'pages.monitoring.tab.pod' }),
                children: <PodTab />,
              },
            ]}
          />

          {/* Probe failure catch-all (other than RESOURCE_NOT_AVAILABLE,
              which is handled by NotInstalled above). */}
          {probe.error && !isResourceNotAvailable(probe.error) && (
            <Result
              status="warning"
              title={intl.formatMessage({ id: 'pages.monitoring.error.title' })}
              subTitle={String(
                (probe.error as any)?.response?.data?.message ??
                  probe.error.message,
              )}
            />
          )}
        </Space>
      </div>
    </MonitoringCtx.Provider>
  );
};

export default MonitoringPage;
