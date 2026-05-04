import {
  CheckOutlined,
  GithubOutlined,
  GlobalOutlined,
  MoonOutlined,
  SunOutlined,
} from '@ant-design/icons';
import { getLocale, setLocale, useRequest } from '@umijs/max';
import type { MenuProps } from 'antd';
import { Button } from 'antd';
import { createStyles, useThemeMode } from 'antd-style';
import React from 'react';
import { getVersion } from '@/services/kpilot/system';
import HeaderDropdown from '../HeaderDropdown';

const LOCALES = [
  { key: 'zh-CN', emoji: '🇨🇳', label: '简体中文' },
  { key: 'en-US', emoji: '🇺🇸', label: 'English' },
];

const useStyles = createStyles(({ token, css }) => ({
  action: css`
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    height: 36px !important;
    min-width: 36px;
    padding-inline: 8px !important;
    padding-block: 0 !important;
    border-radius: ${token.borderRadius}px !important;
  `,
  version: css`
    display: inline-flex;
    align-items: center;
    height: 36px;
    padding-inline: 8px;
    color: ${token.colorTextTertiary};
    font-size: ${token.fontSizeSM}px;
    font-variant-numeric: tabular-nums;
    user-select: none;
  `,
}));

const GITHUB_URL = 'https://github.com/togettoyou/kpilot';

export const VersionBadge: React.FC = () => {
  const { styles } = useStyles();
  const { data } = useRequest(getVersion, {
    formatResult: (res) => res,
    cacheKey: 'kpilot-version',
    staleTime: -1,
  });
  if (!data?.version) return null;
  return <span className={styles.version}>{data.version}</span>;
};

export const GithubLink: React.FC = () => {
  const { styles } = useStyles();
  return (
    <Button
      type="text"
      className={styles.action}
      aria-label="GitHub"
      href={GITHUB_URL}
      target="_blank"
      rel="noopener noreferrer"
      icon={<GithubOutlined />}
    />
  );
};

export const ThemeToggle: React.FC = () => {
  const { styles } = useStyles();
  const { isDarkMode, setAppearance } = useThemeMode();
  return (
    <Button
      type="text"
      className={styles.action}
      aria-label="Toggle theme"
      onClick={() => setAppearance(isDarkMode ? 'light' : 'dark')}
      icon={isDarkMode ? <SunOutlined /> : <MoonOutlined />}
    />
  );
};

export const LangDropdown: React.FC = () => {
  const { styles } = useStyles();
  const currentLocale = getLocale();

  const langItems: MenuProps['items'] = LOCALES.map(({ key, emoji, label }) => ({
    key,
    icon: key === currentLocale
      ? <CheckOutlined style={{ color: '#52c41a' }} />
      : <span style={{ display: 'inline-block', width: 14 }} />,
    label: `${emoji} ${label}`,
  }));

  return (
    <HeaderDropdown
      placement="bottomRight"
      arrow
      menu={{
        selectedKeys: [currentLocale],
        onClick: ({ key }) => setLocale(key, false),
        items: langItems,
        style: { minWidth: 160 },
      }}
    >
      <Button type="text" className={styles.action} aria-label="Language">
        <GlobalOutlined />
      </Button>
    </HeaderDropdown>
  );
};
