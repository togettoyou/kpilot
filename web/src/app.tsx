import {
  ApiOutlined,
  AppstoreAddOutlined,
  AppstoreOutlined,
  BlockOutlined,
  ControlOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  DesktopOutlined,
  FileTextOutlined,
  LineChartOutlined,
  SafetyOutlined,
  SettingOutlined,
  ThunderboltOutlined,
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
// ProLayout's 208 baseline). The user can drag wider for the
// workloads menu's three-level nesting, narrower if they want more
// canvas. Preference persists to localStorage.
const SIDER_WIDTH_KEY = 'kpilot-sider-width';
const SIDER_WIDTH_DEFAULT = 220;
const SIDER_WIDTH_MIN = 200;
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
// the sider. Uses createPortal so the handle isn't constrained by the
// DOM mount point (we render it via menuFooterRender so it lives
// inside the model context, but the visual is fixed-position at the
// sider edge). On drag the handle updates initialState.siderWidth in
// real-time; on mouse-up it persists the final width to localStorage.
const SiderResizer: React.FC = () => {
  const { initialState, setInitialState } = useModel('@@initialState');
  const width = initialState?.siderWidth ?? SIDER_WIDTH_DEFAULT;
  // Hide when no sider is shown (landing pages, login, etc.). Sider is
  // suppressed by ProLayout when the menu is empty, so currentClusterId
  // is the right signal — both /clusters/:id and /compute/:id show one.
  const visible = !!initialState?.currentClusterId;

  const onMouseDown = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      let currentWidth = startWidth;

      const move = (ev: MouseEvent) => {
        currentWidth = clampSiderWidth(startWidth + ev.clientX - startX);
        setInitialState((s: any) => ({ ...s, siderWidth: currentWidth }));
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
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
      onMouseDown={onMouseDown}
      style={{
        position: 'fixed',
        top: 56, // ProLayout default header height
        left: width - 2,
        width: 4,
        height: 'calc(100vh - 56px)',
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

// buildComputeSubMenu — sider items for the Compute platform once a
// cluster is selected. Phase 0 has only the resource overview; P5b
// adds GPU monitoring, P5c+ adds task management / health / etc.
function buildComputeSubMenu(clusterId: string): MenuDataItem[] {
  const base = `/compute/${clusterId}`;
  return [
    {
      path: `${base}/overview`,
      name: 'overview',
      icon: <ThunderboltOutlined />,
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
