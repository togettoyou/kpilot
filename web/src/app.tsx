import {
  AlertOutlined,
  ApiOutlined,
  AppstoreAddOutlined,
  AppstoreOutlined,
  BlockOutlined,
  BorderInnerOutlined,
  ClockCircleOutlined,
  ControlOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  DesktopOutlined,
  FileTextOutlined,
  FundOutlined,
  LineChartOutlined,
  SafetyOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { MenuDataItem } from '@ant-design/pro-components';
import type { RequestConfig, RunTimeLayoutConfig } from '@umijs/max';
import { history, Link, useModel } from '@umijs/max';
import { ThemeProvider } from 'antd-style';
import React from 'react';
import { createPortal } from 'react-dom';

import {
  AvatarDropdown,
  Footer,
  GithubLink,
  LangDropdown,
  NamespacePicker,
  ThemeToggle,
  VersionBadge,
} from '@/components';
import { currentUser as queryCurrentUser } from '@/services/kpilot/auth';
import { errorConfig } from './requestErrorConfig';

const loginPath = '/user/login';

type CurrentUser = { name: string; access: string; avatar?: string };

export type InitialState = {
  currentUser?: CurrentUser;
  fetchUserInfo?: () => Promise<CurrentUser | undefined>;
  currentClusterId?: string | null;
  // User-resizable sider; persisted to localStorage. Layout default
  // applies if absent.
  siderWidth?: number;
};

// Sider width persistence + bounds. Default 220 (slight bump above
// ProLayout's 208 baseline); 220 is also the lower bound so users
// can't drag narrower than the level-3 menu items truncate at.
// Upper bound 480 keeps the canvas usable on smaller monitors.
const SIDER_WIDTH_KEY = 'kpilot-sider-width';
const SIDER_WIDTH_DEFAULT = 220;
const SIDER_WIDTH_MIN = 220;
const SIDER_WIDTH_MAX = 480;

function readStoredSiderWidth(): number {
  if (typeof window === 'undefined') return SIDER_WIDTH_DEFAULT;
  const raw = window.localStorage.getItem(SIDER_WIDTH_KEY);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= SIDER_WIDTH_MIN && n <= SIDER_WIDTH_MAX
    ? n
    : SIDER_WIDTH_DEFAULT;
}

function clampSiderWidth(n: number): number {
  return Math.max(SIDER_WIDTH_MIN, Math.min(SIDER_WIDTH_MAX, n));
}

// extractClusterId reads the cluster id out of the URL whether the
// user is in the K8s management platform (`/clusters/:id/...`) or the
// Compute platform (`/compute/:id/...`). Both share the same physical
// cluster — only the perspective changes — so it's a single global
// "current cluster" state, used by menuDataRender to decide which
// platform's sider sub-menu to inject.
function extractClusterId(pathname: string): string | null {
  const m = pathname.match(/^\/(?:clusters|compute)\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

export async function getInitialState(): Promise<InitialState> {
  const fetchUserInfo = async () => {
    try {
      const msg = await queryCurrentUser();
      return msg.data;
    } catch {
      const { pathname, search, hash } = history.location;
      history.replace(
        `${loginPath}?redirect=${encodeURIComponent(pathname + search + hash)}`,
      );
    }
    return undefined;
  };

  const { location } = history;
  const currentClusterId = extractClusterId(location.pathname);
  const siderWidth = readStoredSiderWidth();
  if (location.pathname !== loginPath) {
    const currentUser = await fetchUserInfo();
    return { fetchUserInfo, currentUser, currentClusterId, siderWidth };
  }
  return { fetchUserInfo, currentClusterId, siderWidth };
}

// SiderResizer renders a 4px draggable handle on the right edge of
// the sider. Drag interaction is **pure DOM manipulation** — no React
// state updates during move, only on release. Each setInitialState
// mid-drag would re-render ProLayout's entire menu tree (38+ items)
// and produce visible jank; antd's own Splitter component takes the
// same approach.
//
// Visual elements updated directly during drag:
//   - The Sider element's flex/width inline styles
//   - The handle's own `left` style (so it tracks the cursor)
// On mouseup we commit the final width to initialState (one render)
// and persist to localStorage. React re-renders then re-apply the
// same inline styles via normal render flow.
const SiderResizer: React.FC = () => {
  const { initialState, setInitialState } = useModel('@@initialState');
  const width = initialState?.siderWidth ?? SIDER_WIDTH_DEFAULT;
  // Hide when no sider is shown (landing pages, login, etc.). Sider is
  // suppressed by ProLayout when the menu is empty, so currentClusterId
  // is the right signal — both /clusters/:id and /compute/:id show one.
  const visible = !!initialState?.currentClusterId;
  const handleRef = React.useRef<HTMLDivElement>(null);

  const onMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      let currentWidth = startWidth;

      // ProLayout renders two elements for the sider area:
      //   1. A placeholder div that occupies flex-basis space (so the
      //      content doesn't slide under the fixed sider). Has
      //      `transition: all 0.2s ease` set for the collapse anim.
      //   2. The real Sider (.ant-pro-sider) — position: fixed,
      //      visible content.
      // Updating only #2 widens the visible sider but the content
      // stays put because #1's flex-basis hasn't changed. Plus the
      // placeholder's 0.2s transition lags behind cursor movement.
      // Update both, and zero out the placeholder's transition during
      // the drag.
      const sider = document.querySelector(
        '.ant-pro-sider, .ant-layout-sider',
      ) as HTMLElement | null;
      const placeholder = sider?.previousElementSibling as HTMLElement | null;
      // Both the placeholder div (inline transition for collapse anim)
      // AND the real Sider element (transition from antd's stylesheet)
      // have a 0.2s ease on width changes. Inline `transition: none`
      // overrides both — without it the visible sider lags behind the
      // cursor on fast drags and the handle visually detaches from
      // the panel edge.
      const prevPlaceholderTransition = placeholder?.style.transition ?? '';
      const prevSiderTransition = sider?.style.transition ?? '';
      if (placeholder) {
        placeholder.style.transition = 'none';
      }
      if (sider) {
        sider.style.transition = 'none';
      }

      // Iframes (Grafana monitoring/logging pages) capture pointer
      // events when the cursor crosses into them mid-drag — including
      // mouseup, which strands us in the dragging state until the
      // user clicks again. Disable pointer-events on every iframe for
      // the duration of the drag so events stay on the parent doc.
      const iframes = Array.from(
        document.querySelectorAll('iframe'),
      ) as HTMLIFrameElement[];
      const prevIframePointer = iframes.map((f) => f.style.pointerEvents);
      for (const f of iframes) {
        f.style.pointerEvents = 'none';
      }

      const apply = (px: number) => {
        if (sider) {
          sider.style.flex = `0 0 ${px}px`;
          sider.style.width = `${px}px`;
          sider.style.maxWidth = `${px}px`;
          sider.style.minWidth = `${px}px`;
        }
        if (placeholder) {
          placeholder.style.flex = `0 0 ${px}px`;
          placeholder.style.width = `${px}px`;
          placeholder.style.maxWidth = `${px}px`;
          placeholder.style.minWidth = `${px}px`;
        }
        if (handleRef.current) {
          handleRef.current.style.left = `${px - 2}px`;
        }
      };

      const move = (ev: MouseEvent) => {
        currentWidth = clampSiderWidth(startWidth + ev.clientX - startX);
        apply(currentWidth);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Restore both elements' transitions so the next collapse
        // animates normally. Setting empty string drops the inline
        // override, falling back to the original stylesheet rule.
        if (placeholder) {
          placeholder.style.transition = prevPlaceholderTransition;
        }
        if (sider) {
          sider.style.transition = prevSiderTransition;
        }
        // Restore iframe pointer-events so Grafana / embedded UIs
        // accept clicks again.
        iframes.forEach((f, i) => {
          f.style.pointerEvents = prevIframePointer[i];
        });
        // Commit the final width — single React render, fixes any
        // ancillary layout that depends on siderWidth as a prop. The
        // inline styles we set during drag get re-applied by React's
        // normal render path so there's no visual flash.
        setInitialState((s: any) => ({ ...s, siderWidth: currentWidth }));
        try {
          window.localStorage.setItem(SIDER_WIDTH_KEY, String(currentWidth));
        } catch {
          // localStorage may be disabled (private mode); width still
          // persists for the rest of the session via initialState.
        }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width, setInitialState],
  );

  if (!visible || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={handleRef}
      onMouseDown={onMouseDown}
      style={{
        position: 'fixed',
        // ProLayout's collapse trigger (.ant-pro-sider-collapsed-button,
        // the small "<" circle) sits near the top-right of the sider,
        // just below the header. Leave ~64px of clearance starting
        // from below the header so the resize handle doesn't intercept
        // clicks meant for it.
        top: 56 + 64, // 56 header + 64 trigger clearance
        bottom: 0,
        left: width - 2,
        width: 4,
        cursor: 'col-resize',
        zIndex: 100,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(22, 119, 255, 0.35)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    />,
    document.body,
  );
};

// Build the cluster sub-menu (injected dynamically when a cluster is selected).
// Synthetic group paths (e.g. `_group/network`) are used for SubMenu titles —
// they're never navigated to (antd SubMenu titles only toggle open/close).
//
// `name` is auto-translated by ProLayout via `menu.{parent}.{name}` lookup.
// Since these are children of `/clusters` (locale `menu.clusters`), child
// `name: 'nodes'` resolves to `menu.clusters.nodes`, and so on recursively.
function buildClusterSubMenu(clusterId: string): MenuDataItem[] {
  const base = `/clusters/${clusterId}`;
  return [
    {
      path: `${base}/nodes`,
      name: 'nodes',
      icon: <DesktopOutlined />,
    },
    {
      path: `${base}/_group/workloads`,
      name: 'workloads',
      icon: <AppstoreOutlined />,
      children: [
        { path: `${base}/workloads/deployments`, name: 'deployments' },
        { path: `${base}/workloads/statefulsets`, name: 'statefulsets' },
        { path: `${base}/workloads/daemonsets`, name: 'daemonsets' },
        { path: `${base}/workloads/replicasets`, name: 'replicasets' },
        { path: `${base}/workloads/pods`, name: 'pods' },
        { path: `${base}/workloads/jobs`, name: 'jobs' },
        { path: `${base}/workloads/cronjobs`, name: 'cronjobs' },
        {
          path: `${base}/workloads/horizontalpodautoscalers`,
          name: 'hpa',
        },
      ],
    },
    {
      path: `${base}/_group/network`,
      name: 'network',
      icon: <ApiOutlined />,
      children: [
        { path: `${base}/workloads/services`, name: 'services' },
        { path: `${base}/workloads/endpointslices`, name: 'endpointslices' },
        { path: `${base}/workloads/ingresses`, name: 'ingresses' },
        { path: `${base}/workloads/networkpolicies`, name: 'networkpolicies' },
        { path: `${base}/workloads/gatewayclasses`, name: 'gatewayclasses' },
        { path: `${base}/workloads/gateways`, name: 'gateways' },
        { path: `${base}/workloads/httproutes`, name: 'httproutes' },
        { path: `${base}/workloads/grpcroutes`, name: 'grpcroutes' },
      ],
    },
    {
      path: `${base}/_group/storage`,
      name: 'storage',
      icon: <DatabaseOutlined />,
      children: [
        { path: `${base}/workloads/persistentvolumeclaims`, name: 'pvc' },
        { path: `${base}/workloads/persistentvolumes`, name: 'pv' },
        { path: `${base}/workloads/storageclasses`, name: 'sc' },
      ],
    },
    {
      path: `${base}/_group/config`,
      name: 'config',
      icon: <SettingOutlined />,
      children: [
        { path: `${base}/workloads/configmaps`, name: 'configmaps' },
        { path: `${base}/workloads/secrets`, name: 'secrets' },
      ],
    },
    {
      // 安全 / RBAC group — service identities + role bindings.
      path: `${base}/_group/security`,
      name: 'security',
      icon: <SafetyOutlined />,
      children: [
        { path: `${base}/workloads/serviceaccounts`, name: 'serviceaccounts' },
        { path: `${base}/workloads/roles`, name: 'roles' },
        { path: `${base}/workloads/rolebindings`, name: 'rolebindings' },
        { path: `${base}/workloads/clusterroles`, name: 'clusterroles' },
        {
          path: `${base}/workloads/clusterrolebindings`,
          name: 'clusterrolebindings',
        },
      ],
    },
    {
      // 策略 group — quota / limits / disruption / priority / runtime.
      // PriorityClass & RuntimeClass matter for AI workload scheduling
      // (Volcano integration), so they live here even though they're
      // cluster-scoped.
      path: `${base}/_group/policy`,
      name: 'policy',
      icon: <ControlOutlined />,
      children: [
        { path: `${base}/workloads/resourcequotas`, name: 'resourcequotas' },
        { path: `${base}/workloads/limitranges`, name: 'limitranges' },
        {
          path: `${base}/workloads/poddisruptionbudgets`,
          name: 'poddisruptionbudgets',
        },
        { path: `${base}/workloads/priorityclasses`, name: 'priorityclasses' },
        { path: `${base}/workloads/runtimeclasses`, name: 'runtimeclasses' },
      ],
    },
    {
      path: `${base}/_group/extensions`,
      name: 'extensions',
      icon: <BlockOutlined />,
      children: [
        {
          path: `${base}/workloads/customresourcedefinitions`,
          name: 'crds',
          // Hidden child route — without this, navigating to the CR-
          // instances viewer (/workloads/_cr?...) drops out of any
          // matched menu item, the Extensions section auto-closes
          // (splitMenus: true), and the CRDs item loses its selected
          // state. Listing _cr as a hidden child of CRDs keeps both
          // the section open and the CRDs item highlighted while the
          // user is browsing instances of a particular CRD.
          children: [
            {
              path: `${base}/workloads/_cr`,
              name: 'crInstances',
              hideInMenu: true,
            },
          ],
        },
        {
          // DRA (Dynamic Resource Allocation) — K8s 1.32+ scheduling
          // primitive for accelerators / pluggable devices. Nested
          // under 扩展 alongside CRDs because both are extension-
          // mechanism kinds rather than core workload primitives.
          path: `${base}/_group/extensions/dra`,
          name: 'dra',
          icon: <DeploymentUnitOutlined />,
          children: [
            { path: `${base}/workloads/resourceclaims`, name: 'resourceclaims' },
            {
              path: `${base}/workloads/resourceclaimtemplates`,
              name: 'resourceclaimtemplates',
            },
            { path: `${base}/workloads/deviceclasses`, name: 'deviceclasses' },
            { path: `${base}/workloads/resourceslices`, name: 'resourceslices' },
          ],
        },
        {
          // Admission webhook + policy configs — K8s extensibility
          // mechanism. Same group as CRD / DRA conceptually (extends
          // the core API surface).
          path: `${base}/_group/extensions/admission`,
          name: 'admission',
          icon: <ApiOutlined />,
          children: [
            {
              path: `${base}/workloads/validatingwebhookconfigurations`,
              name: 'validatingwebhooks',
            },
            {
              path: `${base}/workloads/mutatingwebhookconfigurations`,
              name: 'mutatingwebhooks',
            },
            {
              path: `${base}/workloads/validatingadmissionpolicies`,
              name: 'validatingadmissionpolicies',
            },
            {
              path: `${base}/workloads/mutatingadmissionpolicies`,
              name: 'mutatingadmissionpolicies',
            },
          ],
        },
      ],
    },
    {
      path: `${base}/plugins`,
      name: 'plugins',
      icon: <AppstoreAddOutlined />,
    },
    {
      path: `${base}/monitoring`,
      name: 'monitoring',
      icon: <LineChartOutlined />,
    },
    {
      path: `${base}/logging`,
      name: 'logging',
      icon: <FileTextOutlined />,
    },
  ];
}

// buildComputeSubMenu — sider items for the Compute Scheduling platform
// once a cluster is selected. The runtime "scheduler config" view is
// the platform's headline tab, so it sits at the top; everything below
// is the resource-by-resource browser, grouped under "调度资源" so the
// long Volcano CR list doesn't dominate the sider.
function buildComputeSubMenu(clusterId: string): MenuDataItem[] {
  const base = `/compute/${clusterId}`;
  return [
    {
      path: `${base}/overview`,
      name: 'overview',
      icon: <DashboardOutlined />,
    },
    {
      path: `${base}/scheduler`,
      name: 'scheduler',
      icon: <SettingOutlined />,
    },
    {
      // vGPU cluster snapshot — sits between scheduler config (the
      // policy side) and the resource browsers (the workload side)
      // because it shows the live hardware state policies + workloads
      // act on. Top-level rather than nested under 调度资源 because
      // it's not a CR — it's an aggregated read across Node/Pod
      // annotations.
      path: `${base}/vgpu`,
      name: 'vgpu',
      icon: <BorderInnerOutlined />,
    },
    {
      // Physical GPU monitoring — DCGM Exporter scraping into the
      // existing Grafana stack. Pairs with vGPU above: vGPU shows
      // slice-level allocation, GPU monitoring shows hardware-level
      // health (temp / power / utilization / mem / SM clock). Both are
      // cluster-wide aggregates so they live next to each other.
      path: `${base}/gpu-monitoring`,
      name: 'gpuMonitoring',
      icon: <LineChartOutlined />,
    },
    {
      // Queue quota deep-dive — single-queue view of capability /
      // guarantee / allocated / deserved across every resource the
      // queue declares. Sits at the top level (not nested under 调度
      // 资源) because it's a dashboard view, not a CR list. Right after
      // GPU 监控 because both are observation pages.
      path: `${base}/queue-quota`,
      name: 'queueQuota',
      icon: <FundOutlined />,
    },
    {
      // Device health alert center — DCGM-sourced GPU faults rolled
      // into a single sortable list. Right after queue quota — both
      // are operator-side observation pages, both source from VM.
      path: `${base}/device-health`,
      name: 'deviceHealth',
      icon: <AlertOutlined />,
    },
    {
      // GPU-Hour billing report — historical hardware utilization
      // integrated over a chosen window. Stays after device health
      // because the typical user flow is "is anything broken right
      // now → how was usage last week".
      path: `${base}/gpu-hour`,
      name: 'gpuHour',
      icon: <ClockCircleOutlined />,
    },
    {
      // Group label only — has no path of its own. ProLayout opens
      // the section when any child route matches.
      path: `${base}/_group/resources`,
      name: 'resources',
      icon: <AppstoreOutlined />,
      children: [
        {
          path: `${base}/queues`,
          name: 'queues',
          icon: <DatabaseOutlined />,
        },
        {
          path: `${base}/jobs`,
          name: 'jobs',
          icon: <BlockOutlined />,
        },
        {
          path: `${base}/cronjobs`,
          name: 'cronjobs',
          icon: <BlockOutlined />,
        },
        {
          path: `${base}/podgroups`,
          name: 'podgroups',
          icon: <AppstoreOutlined />,
        },
        {
          path: `${base}/hypernodes`,
          name: 'hypernodes',
          icon: <DeploymentUnitOutlined />,
        },
        {
          path: `${base}/jobflows`,
          name: 'jobflows',
          icon: <BlockOutlined />,
        },
        {
          path: `${base}/jobtemplates`,
          name: 'jobtemplates',
          icon: <BlockOutlined />,
        },
        {
          path: `${base}/numatopologies`,
          name: 'numatopologies',
          icon: <DesktopOutlined />,
        },
        {
          path: `${base}/nodeshards`,
          name: 'nodeshards',
          icon: <DeploymentUnitOutlined />,
        },
        {
          path: `${base}/colocationconfigurations`,
          name: 'colocationconfigurations',
          icon: <ControlOutlined />,
        },
      ],
    },
  ];
}

export const layout: RunTimeLayoutConfig = ({
  initialState,
  setInitialState,
}) => {
  const currentClusterId = initialState?.currentClusterId ?? null;

  return {
    layout: 'mix',
    splitMenus: true,
    suppressSiderWhenMenuEmpty: true,
    // User-resizable. Default 220 (slight bump above ProLayout's 208
    // baseline). The user can drag the right edge to widen / narrow;
    // preference persists to localStorage via SiderResizer below.
    siderWidth: initialState?.siderWidth ?? SIDER_WIDTH_DEFAULT,
    logo: '/logo.svg',
    actionsRender: () => [
      <NamespacePicker key="ns" />,
      <VersionBadge key="version" />,
      <GithubLink key="github" />,
      <ThemeToggle key="theme" />,
      <LangDropdown key="lang" />,
    ],
    avatarProps: {
      src: initialState?.currentUser?.avatar,
      title: initialState?.currentUser?.name ?? 'Admin',
      render: (_, avatarChildren) => (
        <AvatarDropdown>{avatarChildren}</AvatarDropdown>
      ),
    },
    // Mount point for the resize handle. Returning a portaled element
    // here means the visible content (a fixed-position 4px bar) lives
    // outside the menu DOM, so the menu's footer area stays empty.
    menuFooterRender: () => <SiderResizer />,
    footerRender: () => <Footer />,
    onPageChange: () => {
      const { location } = history;
      // Auth redirect
      if (!initialState?.currentUser && location.pathname !== loginPath) {
        history.replace(
          `${loginPath}?redirect=${encodeURIComponent(location.pathname + location.search + location.hash)}`,
        );
        return;
      }
      // Track current cluster id for dynamic menu injection.
      const next = extractClusterId(location.pathname);
      if (next !== initialState?.currentClusterId) {
        setInitialState((s) => ({
          ...(s as InitialState),
          currentClusterId: next,
        }));
      }
    },
    // Override Umi's default menuItemRender — by default it omits the <Link>
    // wrapper for the currently-active menu item, which makes selected vs
    // unselected items render with different DOM nesting (and therefore
    // different computed styles, causing a 1px vertical jiggle when switching
    // tabs). Always wrap in <Link> to keep DOM structure consistent.
    menuItemRender: (menuItemProps: any, defaultDom: React.ReactNode) => {
      if (
        menuItemProps.isUrl ||
        menuItemProps.children ||
        !menuItemProps.path
      ) {
        return defaultDom;
      }
      return (
        <Link
          to={menuItemProps.path.replace('/*', '')}
          target={menuItemProps.target}
        >
          {defaultDom}
        </Link>
      );
    },
    menuDataRender: (menuData) => {
      if (!currentClusterId) return menuData;
      return menuData.map((item) => {
        if (item.path === '/clusters') {
          return {
            ...item,
            children: buildClusterSubMenu(currentClusterId),
            routes: undefined,
          };
        }
        if (item.path === '/compute') {
          return {
            ...item,
            children: buildComputeSubMenu(currentClusterId),
            routes: undefined,
          };
        }
        return item;
      });
    },
    menuHeaderRender: undefined,
  };
};

// Catppuccin Mocha dark palette
const DARK_TOKENS = {
  token: {
    colorBgLayout: '#181825',
    colorBgContainer: '#1e1e2e',
    colorBgElevated: '#313244',
    colorBgSpotlight: '#45475a',
    colorBorder: '#45475a',
    colorBorderSecondary: '#313244',
    colorPrimary: '#89b4fa',
  },
};

export function rootContainer(container: React.ReactNode) {
  // Guard against SSR / build-time environments where localStorage is unavailable.
  const saved =
    typeof window !== 'undefined'
      ? (localStorage.getItem('kpilot-theme') as 'light' | 'dark' | null)
      : null;
  const initialTheme = saved ?? 'light';

  return (
    <ThemeProvider
      // defaultThemeMode must match defaultAppearance — antd-style's ThemeObserver
      // calls setAppearance(themeMode) on mount, which would reset the appearance to
      // 'light' (the useMergeValue default) if only defaultAppearance is set.
      defaultAppearance={initialTheme}
      defaultThemeMode={initialTheme}
      theme={(appearance) => (appearance === 'dark' ? DARK_TOKENS : {})}
      onAppearanceChange={(a) => localStorage.setItem('kpilot-theme', a)}
    >
      {container}
    </ThemeProvider>
  );
}

export const request: RequestConfig = {
  baseURL: '',
  ...errorConfig,
};
