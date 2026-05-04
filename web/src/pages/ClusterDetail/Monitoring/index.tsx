import {
  CheckCircleFilled,
  ExclamationCircleOutlined,
  ExportOutlined,
  LoadingOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { history, useIntl, useParams, useRequest } from '@umijs/max';
import { Alert, Button, Result, Spin, Tooltip } from 'antd';
import { useThemeMode } from 'antd-style';
import React, { useEffect, useMemo, useRef, useState } from 'react';

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

// containIframeOverscroll injects overscroll-behavior:contain into the
// iframe's own document, so a scroll-chain originating inside Grafana
// dies at the iframe boundary and never bubbles to the host page.
//
// This works ONLY because KPilot reverse-proxies Grafana — the iframe
// shares an origin with the parent, so contentDocument is accessible.
// On a true cross-origin iframe this would throw; we swallow that and
// fall through silently in case future configurations expose one.
//
// Returns a cleanup that removes the inline style; we apply on every
// load (Grafana SPA navigations create a fresh document) so the cleanup
// runs against whatever document is current.
function containIframeOverscroll(iframe: HTMLIFrameElement): () => void {
  const apply = () => {
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      // Both html and body — different browsers consult different
      // levels of the iframe document depending on which element is
      // the actual scroll container.
      if (doc.documentElement) {
        doc.documentElement.style.overscrollBehavior = 'contain';
      }
      if (doc.body) {
        doc.body.style.overscrollBehavior = 'contain';
      }
    } catch {
      // cross-origin guard — should never trigger under our reverse
      // proxy, but if Grafana ever redirected us off-origin we'd see it.
    }
  };
  // Apply now (in case the iframe finished loading before this effect ran)
  // and on every subsequent load (Grafana navigates between dashboards by
  // replacing its document).
  apply();
  iframe.addEventListener('load', apply);
  return () => {
    iframe.removeEventListener('load', apply);
  };
}

const MonitoringPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Mirror KPilot's appearance into Grafana via the ?theme=... URL param,
  // which Grafana respects per-page-load (winning over default_theme and
  // any stored user preference). isDarkMode comes from antd-style's
  // ThemeProvider, the same source the KPilot ThemeToggle button writes
  // to — so flipping the toggle re-renders this page with the new value.
  const { isDarkMode } = useThemeMode();
  const grafanaTheme: 'dark' | 'light' = isDarkMode ? 'dark' : 'light';
  // The wrapper's height tracks its parent's clientHeight via ResizeObserver
  // — height:100% would collapse to 0 when ProLayout's content area doesn't
  // hand down an explicit height through every flex/block ancestor, and a
  // viewport-minus-header calc has to guess at all the chrome above us
  // (header / breadcrumb / banner padding) and never gets it exactly right.
  // Measuring the actual containing block adapts to window resize, sider
  // collapse, and any future ProLayout chrome changes for free.
  const [containerHeight, setContainerHeight] = useState<number | null>(null);

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

  // Stop scroll-chain at the iframe boundary by setting
  // overscroll-behavior:contain inside Grafana's own document. Works
  // because the reverse proxy keeps the iframe same-origin. The host
  // page's normal scroll (which makes the footer visible) is left
  // untouched.
  useEffect(() => {
    if (!summary.allReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    return containIframeOverscroll(iframe);
  }, [summary.allReady]);

  // When KPilot's theme flips, retarget the iframe to the same Grafana
  // path it's currently on but with ?theme=... updated. We don't just
  // change the iframe's `src` JSX attribute because that would reset
  // the iframe to its initial URL on every theme flip — losing whichever
  // dashboard the user navigated to. Reading contentWindow.location works
  // because the reverse proxy keeps the iframe same-origin; if reading
  // fails (initial render before iframe loads, or cross-origin redirect)
  // we just skip — the next mount will use the up-to-date initial src.
  useEffect(() => {
    if (!summary.allReady) return;
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const cw = iframe.contentWindow;
      const cur = cw?.location?.href;
      if (!cur || cur === 'about:blank' || cur.startsWith('about:')) return;
      const url = new URL(cur);
      if (url.searchParams.get('theme') === grafanaTheme) return;
      url.searchParams.set('theme', grafanaTheme);
      iframe.src = url.toString();
    } catch {
      // SecurityError on cross-origin or sandbox — initial src already
      // has the correct theme baked in, so no fallback needed here.
    }
  }, [grafanaTheme, summary.allReady]);

  // Size the wrapper to fit between its top edge and the bottom of the
  // viewport. Uses window.innerHeight - rect.top instead of the more
  // obvious parent.clientHeight because the latter is a feedback loop:
  // we ARE parent's content, so growing our wrapper grows parent's
  // clientHeight which grows our wrapper. Most flex layouts incidentally
  // dampen the loop, but an iframe error page (or any state where
  // parent's height isn't otherwise constrained) can blow up to infinity.
  //
  // window.innerHeight - rect.top depends only on chrome ABOVE us
  // (header, breadcrumbs, banner) and the viewport itself — never on
  // our own size — so the measurement is loop-free by construction.
  useEffect(() => {
    if (!summary.allReady) return;
    const update = () => {
      const el = wrapperRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const h = Math.max(0, Math.floor(window.innerHeight - rect.top));
      // Functional setter + equality check so unchanged measurements
      // don't trigger re-renders.
      setContainerHeight((prev) => (prev === h ? prev : h));
    };
    // Defer first measure one frame so styles from this render commit
    // before we measure rect.top.
    const raf = requestAnimationFrame(update);
    window.addEventListener('resize', update);
    // body resizes when banners appear / disappear or the sider
    // collapses — any chrome change above us. We measure relative to
    // wrapper.top so this can't feedback into our own size.
    const ro = new ResizeObserver(update);
    ro.observe(document.body);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
      ro.disconnect();
    };
  }, [summary.allReady]);

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
    // Open Grafana directly on the Node Exporter Full dashboard — its UID
    // is fixed by the upstream JSON we embed in the Grafana plugin's
    // overlay (see pkg/server/dashboards/builtin). Without /d/<uid>/ the
    // user would land on Grafana's empty home page and have to click into
    // Browse → Dashboards every time.
    const dashboardUID = 'rYdddlPWk';
    const grafanaURL = `/api/v1/clusters/${clusterId}/proxy/grafana/d/${dashboardUID}/?theme=${grafanaTheme}`;
    return (
      // Wrapper height comes from the ResizeObserver above (containerHeight)
      // so the iframe fills the actual parent box exactly. Falls back to
      // viewport-minus-header before the first measurement lands; once
      // measured, future window resizes keep it in sync. The host page's
      // own scroll (footer visibility, etc.) is preserved — chain
      // containment happens inside the iframe's document, not by locking
      // the host's scroll.
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
          ref={iframeRef}
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
