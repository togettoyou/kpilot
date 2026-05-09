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
import { history, Link } from '@umijs/max';
import { ThemeProvider } from 'antd-style';
import React from 'react';

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
};

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
  if (location.pathname !== loginPath) {
    const currentUser = await fetchUserInfo();
    return { fetchUserInfo, currentUser, currentClusterId };
  }
  return { fetchUserInfo, currentClusterId };
}

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
    // 220 not 208 (ProLayout default) — minor bump to keep three-level
    // nesting (扩展 → DRA → ResourceClaims etc.) from clipping the
    // English kind names without making the main content area noticeably
    // narrower.
    siderWidth: 220,
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
