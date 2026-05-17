import {
  CheckCircleFilled,
  ExclamationCircleOutlined,
  ExportOutlined,
  LoadingOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { history, useIntl, useParams } from '@umijs/max';

import { useClusterRequest } from '@/hooks/useClusterRequest';
import { Alert, Button, Result, Spin, Tooltip } from 'antd';
import { useThemeMode } from 'antd-style';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  listClusterPlugins,
  type ClusterPluginItem,
  type PluginPhase,
} from '@/services/kpilot/plugin';

// GrafanaEmbedConfig is the per-page knob set. The Monitoring and Logging
// pages share all the iframe / scroll-containment / theme-sync / dep-check
// machinery in this component and just hand in:
//   - which plugins must be Running before the iframe renders
//   - which plugins are nice-to-have (banner-only nudge)
//   - the Grafana dashboard UID to deep-link into
//   - the i18n prefix for page-specific strings (titles, subtitles, recommended msg)
//
// Generic strings (depState, cta, openFullscreen) live under pages.embed.*.
export interface GrafanaEmbedConfig {
  required: readonly string[];
  recommended: readonly string[];
  dashboardUID: string;
  // i18n key prefix for page-specific strings:
  //   <prefix>.missing.{title,subTitle}
  //   <prefix>.installing.{title,subTitle}
  //   <prefix>.failed.{title,subTitle}
  //   <prefix>.recommended  (with {names} placeholder)
  i18nPrefix: string;
}

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

// containIframeOverscroll injects overscroll-behavior:contain into the
// iframe's own document so a scroll-chain originating inside Grafana dies
// at the iframe boundary instead of bubbling to the host page. Same-origin
// reverse proxy makes contentDocument access safe; cross-origin would
// throw and we silently fall through.
//
// Re-applied on every load event because Grafana's SPA navigation
// between dashboards replaces the document.
function containIframeOverscroll(iframe: HTMLIFrameElement): () => void {
  const apply = () => {
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      if (doc.documentElement) {
        doc.documentElement.style.overscrollBehavior = 'contain';
      }
      if (doc.body) {
        doc.body.style.overscrollBehavior = 'contain';
      }
    } catch {
      // cross-origin guard
    }
  };
  apply();
  iframe.addEventListener('load', apply);
  return () => {
    iframe.removeEventListener('load', apply);
  };
}

const GrafanaEmbed: React.FC<GrafanaEmbedConfig> = ({
  required,
  recommended,
  dashboardUID,
  i18nPrefix,
}) => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Mirror KPilot's appearance into Grafana via ?theme=. isDarkMode is the
  // same source the ThemeToggle button writes to, so flipping the toggle
  // re-renders this component with the new value.
  const { isDarkMode } = useThemeMode();
  const grafanaTheme: 'dark' | 'light' = isDarkMode ? 'dark' : 'light';
  // Wrapper height tracked from window.innerHeight - rect.top so the
  // measurement is loop-free (depends only on chrome above us, never on
  // our own size).
  const [containerHeight, setContainerHeight] = useState<number | null>(null);

  const { data, loading, refresh } = useClusterRequest(
    () => listClusterPlugins(clusterId!),
    [clusterId],
    { ready: !!clusterId },
  );

  const summary = useMemo(() => {
    const byName = new Map<string, ClusterPluginItem>();
    for (const item of data ?? []) {
      byName.set(item.plugin.name, item);
    }
    const requiredRows = required.map((name) => {
      const item = byName.get(name);
      return {
        name,
        item,
        state: rollUp(item?.phase, item?.enabled ?? false),
      };
    });
    const recommendedRows = recommended.map((name) => {
      const item = byName.get(name);
      return {
        name,
        item,
        state: rollUp(item?.phase, item?.enabled ?? false),
      };
    });
    const allReady = requiredRows.every((r) => r.state === 'ready');
    const anyInstalling = requiredRows.some((r) => r.state === 'installing');
    const anyFailed = requiredRows.some((r) => r.state === 'failed');
    return {
      required: requiredRows,
      recommended: recommendedRows,
      allReady,
      anyInstalling,
      anyFailed,
    };
  }, [data, required, recommended]);

  // Auto-refresh while any required plugin is mid-install.
  useEffect(() => {
    if (!summary.anyInstalling) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [summary.anyInstalling, refresh]);

  // Stop scroll-chain at the iframe boundary (only when iframe is rendered).
  useEffect(() => {
    if (!summary.allReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    return containIframeOverscroll(iframe);
  }, [summary.allReady]);

  // Theme flip: rewrite iframe src preserving current Grafana path.
  // Debounced so a user clicking the SettingDrawer theme toggle a few
  // times in quick succession doesn't reload the dashboard once per
  // click — each reload re-runs every panel query against the
  // upstream Prometheus / VictoriaMetrics, which is noticeably
  // expensive on a busy cluster. 350ms is just over the visual
  // settle time of the antd theme transition.
  useEffect(() => {
    if (!summary.allReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    const t = window.setTimeout(() => {
      try {
        const cw = iframe.contentWindow;
        const cur = cw?.location?.href;
        if (!cur || cur === 'about:blank' || cur.startsWith('about:')) return;
        const url = new URL(cur);
        if (url.searchParams.get('theme') === grafanaTheme) return;
        url.searchParams.set('theme', grafanaTheme);
        iframe.src = url.toString();
      } catch {
        // cross-origin / sandbox; initial src already has the right theme
      }
    }, 350);
    return () => window.clearTimeout(t);
  }, [grafanaTheme, summary.allReady]);

  // Wrapper sizing: measure relative to viewport top so it's loop-free.
  // We rAF-throttle the update — without it, sider drag fires the
  // ResizeObserver on every mousemove, each triggering a sync layout
  // read + React render + iframe re-layout (Grafana is heavy). The
  // height itself doesn't change with sider width, but the cost of
  // measuring does.
  useEffect(() => {
    if (!summary.allReady) return;
    let pending = 0;
    const measure = () => {
      pending = 0;
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const h = Math.max(0, Math.floor(window.innerHeight - rect.top));
      setContainerHeight((prev) => (prev === h ? prev : h));
    };
    const schedule = () => {
      if (pending) return;
      pending = requestAnimationFrame(measure);
    };
    schedule();
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);
    return () => {
      if (pending) cancelAnimationFrame(pending);
      window.removeEventListener('resize', schedule);
      ro.disconnect();
    };
  }, [summary.allReady]);

  const goToPlugins = () => history.push(`/clusters/${clusterId}/plugins`);

  if (loading && !data) {
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

  if (summary.allReady) {
    const recommendedMissing = summary.recommended.filter((r) => r.state !== 'ready');
    // kiosk=1 puts Grafana into full-screen mode — hides the left sider
    // and the dashboard top bar. The toolbar above the iframe (with the
    // open-in-new-tab button) is plenty of chrome for the embedded view;
    // Grafana's own header is mostly redundant with KPilot's. The new-tab
    // URL drops kiosk so the standalone view stays fully featured.
    //
    // Empty dashboardUID = land on the Grafana home page instead of a
    // specific dashboard. The Grafana page (/clusters/:id/grafana) uses
    // that mode as an escape hatch into the full Grafana UI, with the
    // user logged in as Admin via auth.proxy — also drop kiosk in this
    // mode so the user gets Grafana's own navigation.
    const subPath = dashboardUID ? `d/${dashboardUID}/` : '';
    const kiosk = dashboardUID ? '&kiosk=1' : '';
    const grafanaURL = `/api/v1/clusters/${clusterId}/proxy/grafana/${subPath}?theme=${grafanaTheme}${kiosk}`;
    const fullscreenURL = `/api/v1/clusters/${clusterId}/proxy/grafana/${subPath}?theme=${grafanaTheme}`;
    return (
      <div
        ref={wrapperRef}
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: containerHeight != null ? containerHeight : 'calc(100vh - 56px)',
          width: '100%',
          overflow: 'hidden',
        }}
      >
        {recommendedMissing.length > 0 && (
          <Alert
            type="info"
            showIcon
            style={{ borderRadius: 0, flexShrink: 0 }}
            message={intl.formatMessage(
              { id: `${i18nPrefix}.recommended` },
              { names: recommendedMissing.map((r) => r.name).join(', ') },
            )}
            action={
              <Button size="small" type="link" onClick={goToPlugins}>
                {intl.formatMessage({ id: 'pages.embed.cta.enable' })}
              </Button>
            }
            closable
          />
        )}
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
          <Tooltip
            title={intl.formatMessage({ id: 'pages.embed.openFullscreen.tooltip' })}
          >
            <Button
              type="text"
              size="small"
              icon={<ExportOutlined />}
              onClick={() => window.open(fullscreenURL, '_blank', 'noopener,noreferrer')}
            >
              {intl.formatMessage({ id: 'pages.embed.openFullscreen' })}
            </Button>
          </Tooltip>
        </div>
        <iframe
          ref={iframeRef}
          src={grafanaURL}
          title="Grafana"
          style={{
            border: 0,
            width: '100%',
            flex: 1,
          }}
        />
      </div>
    );
  }

  // Sad paths
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
      id: `pages.embed.depState.${r.state}`,
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

  const status = summary.anyFailed ? 'error' : summary.anyInstalling ? 'info' : 'warning';
  const phaseKey = summary.anyFailed
    ? 'failed'
    : summary.anyInstalling
      ? 'installing'
      : 'missing';
  const titleKey = `${i18nPrefix}.${phaseKey}.title`;
  const subTitleKey = `${i18nPrefix}.${phaseKey}.subTitle`;

  return (
    <Result
      status={status as 'error' | 'info' | 'warning'}
      title={intl.formatMessage({ id: titleKey })}
      subTitle={intl.formatMessage({ id: subTitleKey })}
      extra={[
        <Button key="enable" type="primary" onClick={goToPlugins}>
          {intl.formatMessage({ id: 'pages.embed.cta.goPlugins' })}
        </Button>,
        <Button key="refresh" icon={<ReloadOutlined />} onClick={refresh}>
          {intl.formatMessage({ id: 'pages.embed.cta.refresh' })}
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

export default GrafanaEmbed;
