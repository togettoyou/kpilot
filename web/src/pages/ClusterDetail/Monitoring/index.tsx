import {
  CheckCircleFilled,
  ExclamationCircleOutlined,
  ExportOutlined,
  LoadingOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { history, useIntl, useParams, useRequest } from '@umijs/max';
import { Alert, Button, Result, Spin, Tooltip } from 'antd';
import React, { useEffect, useMemo } from 'react';

import {
  listClusterPlugins,
  type ClusterPluginItem,
  type PluginPhase,
} from '@/services/kpilot/plugin';

// Plugins this page reverse-proxies. Hard-required = page can't render
// without them (Grafana itself + the metrics datasource it depends on);
// recommended = nice-to-have (more node-level panels), absence is shown
// as a soft banner but doesn't block the iframe.
const REQUIRED_PLUGINS = ['grafana', 'victoria-metrics'] as const;
const RECOMMENDED_PLUGINS = ['node-exporter'] as const;

// Roll-up of one plugin's state into the four buckets the UI cares about.
// Anything not in {ready, installing, failed, missing} is mapped onto one
// of those four — keeps the rendering switch small.
type PluginGroupState = 'ready' | 'installing' | 'failed' | 'missing';

function rollUp(phase: PluginPhase | undefined, enabled: boolean): PluginGroupState {
  if (!phase) return 'missing';
  if (!enabled) return 'missing';
  switch (phase) {
    case 'Running':
      return 'ready';
    case 'Pending':
    case 'Installing':
    case 'Upgrading':
      return 'installing';
    case 'Failed':
      return 'failed';
    case 'Disabled':
    case 'Uninstalling':
    default:
      return 'missing';
  }
}

const MonitoringPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();

  const { data, loading, refresh } = useRequest(
    () => listClusterPlugins(clusterId!),
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId],
    },
  );

  // Aggregate the dep-check buckets. We snapshot what state each required
  // plugin is in so the user sees per-plugin status when something's
  // missing — not just a generic "deps not ready".
  const summary = useMemo(() => {
    const byName = new Map<string, ClusterPluginItem>();
    for (const item of data ?? []) {
      byName.set(item.plugin.name, item);
    }
    const required = REQUIRED_PLUGINS.map((name) => {
      const item = byName.get(name);
      return {
        name,
        item,
        state: rollUp(item?.phase, item?.enabled ?? false),
      };
    });
    const recommended = RECOMMENDED_PLUGINS.map((name) => {
      const item = byName.get(name);
      return {
        name,
        item,
        state: rollUp(item?.phase, item?.enabled ?? false),
      };
    });
    const allReady = required.every((r) => r.state === 'ready');
    const anyInstalling = required.some((r) => r.state === 'installing');
    const anyFailed = required.some((r) => r.state === 'failed');
    return { required, recommended, allReady, anyInstalling, anyFailed };
  }, [data]);

  // Auto-refresh while any required plugin is mid-install. 5s mirrors the
  // workload page's lowest polling tier — slow enough to not hammer the
  // backend, fast enough that the user sees the page flip to iframe within
  // a tick of the install completing.
  useEffect(() => {
    if (!summary.anyInstalling) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [summary.anyInstalling, refresh]);

  const goToPlugins = () => history.push(`/clusters/${clusterId}/plugins`);

  if (loading && !data) {
    // First-load skeleton — once data arrives the page will switch to one of
    // the four cases below.
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '60vh',
        }}
      >
        <Spin size="large" />
      </div>
    );
  }

  // Happy path: render the iframe and the optional-plugin nudge as a thin
  // banner on top. iframe URL goes through KPilot Server's reverse proxy,
  // which injects X-WEBAUTH-USER for auth.proxy on the upstream side.
  if (summary.allReady) {
    const recommendedMissing = summary.recommended.filter(
      (r) => r.state !== 'ready',
    );
    const grafanaURL = `/api/v1/clusters/${clusterId}/proxy/grafana/`;
    return (
      // Sized to the viewport minus ProLayout's header + content padding so
      // the wrapper exactly fills the visible page area — no parent scroll
      // appears, so iframe scroll has nothing to chain into. overflow:hidden
      // is the belt to that suspenders, and overscroll-behavior on the
      // iframe is the final guard if the math is off on a particular layout.
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: 'calc(100vh - 96px)',
          overflow: 'hidden',
        }}
      >
        {recommendedMissing.length > 0 && (
          <Alert
            type="info"
            showIcon
            style={{ borderRadius: 0, flexShrink: 0 }}
            message={intl.formatMessage(
              { id: 'pages.monitoring.recommended' },
              {
                names: recommendedMissing.map((r) => r.name).join(', '),
              },
            )}
            action={
              <Button size="small" type="link" onClick={goToPlugins}>
                {intl.formatMessage({ id: 'pages.monitoring.cta.enable' })}
              </Button>
            }
            closable
          />
        )}
        {/* Slim toolbar: just the "open in new tab" affordance for now.
            kept thin so the iframe gets nearly all the vertical space. */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            padding: '4px 8px',
            background: 'var(--ant-color-bg-container)',
            borderBottom: '1px solid var(--ant-color-border-secondary)',
            flexShrink: 0,
          }}
        >
          <Tooltip title={intl.formatMessage({ id: 'pages.monitoring.openFullscreen.tooltip' })}>
            <Button
              type="text"
              size="small"
              icon={<ExportOutlined />}
              onClick={() => window.open(grafanaURL, '_blank', 'noopener,noreferrer')}
            >
              {intl.formatMessage({ id: 'pages.monitoring.openFullscreen' })}
            </Button>
          </Tooltip>
        </div>
        <iframe
          // sandbox left off intentionally — Grafana legitimately needs
          // same-origin cookies, scripts, popups (open dashboard in new
          // tab), and form submission. Everything routes through KPilot's
          // proxy so there's no cross-origin surface to defend.
          src={grafanaURL}
          title="Grafana"
          style={{
            border: 0,
            width: '100%',
            flex: 1,
            // Stop scroll-chaining: when the iframe's own scroll bottoms
            // out, the wheel event would otherwise bubble up and try to
            // scroll the page underneath, causing the visible "stutter
            // when reaching the bottom" the user reported.
            overscrollBehavior: 'contain',
          }}
        />
      </div>
    );
  }

  // Sad paths: surface what's wrong with which plugin so the user knows
  // exactly what to fix.
  const buildPluginLine = (r: typeof summary.required[number]) => {
    const icon = (() => {
      switch (r.state) {
        case 'ready':
          return <CheckCircleFilled style={{ color: '#52c41a' }} />;
        case 'installing':
          return <LoadingOutlined style={{ color: '#1677ff' }} />;
        case 'failed':
          return <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />;
        case 'missing':
        default:
          return <ExclamationCircleOutlined style={{ color: '#faad14' }} />;
      }
    })();
    const label = intl.formatMessage({
      id: `pages.monitoring.depState.${r.state}`,
    });
    return (
      <div
        key={r.name}
        style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: 2 }}
      >
        {icon}
        <span style={{ fontWeight: 500 }}>{r.name}</span>
        <span style={{ color: 'var(--ant-color-text-secondary)' }}>—</span>
        <span style={{ color: 'var(--ant-color-text-secondary)' }}>{label}</span>
        {r.state === 'failed' && r.item?.message && (
          <span
            style={{
              color: 'var(--ant-color-error)',
              fontSize: 12,
              marginLeft: 4,
            }}
          >
            ({r.item.message})
          </span>
        )}
      </div>
    );
  };

  // Pick a Result status that matches the dominant bucket. Failed > installing
  // > missing — failed deserves the loudest signal since it needs a fix.
  const status = summary.anyFailed ? 'error' : summary.anyInstalling ? 'info' : 'warning';
  const titleKey = summary.anyFailed
    ? 'pages.monitoring.failed.title'
    : summary.anyInstalling
      ? 'pages.monitoring.installing.title'
      : 'pages.monitoring.missing.title';
  const subTitleKey = summary.anyFailed
    ? 'pages.monitoring.failed.subTitle'
    : summary.anyInstalling
      ? 'pages.monitoring.installing.subTitle'
      : 'pages.monitoring.missing.subTitle';

  return (
    <Result
      status={status as 'error' | 'info' | 'warning'}
      title={intl.formatMessage({ id: titleKey })}
      subTitle={intl.formatMessage({ id: subTitleKey })}
      extra={[
        <Button key="enable" type="primary" onClick={goToPlugins}>
          {intl.formatMessage({ id: 'pages.monitoring.cta.goPlugins' })}
        </Button>,
        <Button key="refresh" icon={<ReloadOutlined />} onClick={refresh}>
          {intl.formatMessage({ id: 'pages.monitoring.cta.refresh' })}
        </Button>,
      ]}
    >
      <div
        style={{
          background: 'var(--ant-color-fill-tertiary)',
          padding: '16px 24px',
          borderRadius: 8,
          maxWidth: 520,
          margin: '0 auto',
        }}
      >
        {summary.required.map(buildPluginLine)}
      </div>
    </Result>
  );
};

export default MonitoringPage;
