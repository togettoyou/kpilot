import {
  ApiOutlined,
  AppstoreAddOutlined,
  AppstoreOutlined,
  BlockOutlined,
  BulbOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  DesktopOutlined,
  FileTextOutlined,
  LineChartOutlined,
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

function extractClusterId(pathname: string): string | null {
  const m = pathname.match(/^\/clusters\/([^/]+)(?:\/|$)/);
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
        { path: `${base}/workloads/ingresses`, name: 'ingresses' },
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
      ],
    },
    {
      path: `${base}/plugins`,
      name: 'plugins',
      icon: <AppstoreAddOutlined />,
    },
    {
      // 智算 group: GPU resource overview. Used to be split across
      // overview / nodes / cards / tasks but they were merged into a
      // single dashboard. Group kept as a single-child parent so the
      // navigation grouping is consistent with 模型 below (and leaves
      // room for GPU-monitoring / future siblings).
      path: `${base}/compute`,
      name: 'compute',
      icon: <ThunderboltOutlined />,
      children: [
        {
          path: `${base}/compute/overview`,
          name: 'overview',
        },
      ],
    },
    {
      // 模型 is its own parent group — children land in P7. For now a
      // single placeholder child keeps the menu shape consistent so the
      // navigation doesn't reorder when we ship the inference page.
      path: `${base}/models`,
      name: 'models',
      icon: <BulbOutlined />,
      children: [
        {
          path: `${base}/models/inference`,
          name: 'inference',
          disabled: true,
        },
      ],
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
