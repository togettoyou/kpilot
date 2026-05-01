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

export function rootContainer(container: React.ReactNode) {
  const saved = localStorage.getItem('kpilot-theme') as 'light' | 'dark' | null;
  return (
    <ThemeProvider
      defaultAppearance={saved ?? 'light'}
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
