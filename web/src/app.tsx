import type { RequestConfig, RunTimeLayoutConfig } from '@umijs/max';
import { history } from '@umijs/max';
import { ThemeProvider } from 'antd-style';
import React from 'react';

import { AvatarDropdown, Footer, LangDropdown, ThemeToggle } from '@/components';
import { currentUser as queryCurrentUser } from '@/services/kpilot/auth';
import { errorConfig } from './requestErrorConfig';

const loginPath = '/user/login';

export async function getInitialState(): Promise<{
  currentUser?: { name: string; access: string; avatar?: string };
  fetchUserInfo?: () => Promise<{ name: string; access: string; avatar?: string } | undefined>;
}> {
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
  if (location.pathname !== loginPath) {
    const currentUser = await fetchUserInfo();
    return { fetchUserInfo, currentUser };
  }
  return { fetchUserInfo };
}

export const layout: RunTimeLayoutConfig = ({ initialState }) => {
  return {
    layout: 'mix',
    logo: '/logo.svg',
    actionsRender: () => [<ThemeToggle key="theme" />, <LangDropdown key="lang" />],
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
      if (!initialState?.currentUser && location.pathname !== loginPath) {
        history.replace(
          `${loginPath}?redirect=${encodeURIComponent(location.pathname + location.search + location.hash)}`,
        );
      }
    },
    menuHeaderRender: undefined,
  };
};

const DARK_TOKENS = {
  token: {
    colorBgLayout: '#161618',
    colorBgContainer: '#1e1e22',
    colorBgElevated: '#28282d',
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
