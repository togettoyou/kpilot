import {
  CheckOutlined,
  ExclamationCircleFilled,
  GithubOutlined,
  GlobalOutlined,
  MoonOutlined,
  SunOutlined,
} from '@ant-design/icons';
import { getLocale, setLocale, useIntl, useModel, useRequest } from '@umijs/max';
import type { MenuProps } from 'antd';
import { Button, Tooltip } from 'antd';
import { createStyles, useThemeMode } from 'antd-style';
import React, { useEffect, useRef } from 'react';
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
}));

const GITHUB_URL = 'https://github.com/togettoyou/kpilot';

export const VersionBadge: React.FC = () => {
  const { data } = useRequest(getVersion, {
    formatResult: (res) => res,
    cacheKey: 'kpilot-version',
    staleTime: -1,
  });
  const rootRef = useRef<HTMLSpanElement>(null);

  // Strip ProLayout's `*-header-actions-item / -hover` wrapper class so the
  // version text doesn't pick up button-style hover/padding. Same trick
  // NamespacePicker uses — :has()/class-chain overrides don't beat the
  // hashed cssinjs rules in practice.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const wrapper = root.parentElement;
    if (!wrapper) return;
    const offenders = Array.from(wrapper.classList).filter(
      (c) => c.includes('actions-item') || c.includes('actions-hover'),
    );
    offenders.forEach((c) => wrapper.classList.remove(c));
  });

  if (!data?.version) return null;
  return (
    <span
      ref={rootRef}
      style={{
        fontSize: 13,
        color: 'var(--ant-color-text-tertiary)',
        fontVariantNumeric: 'tabular-nums',
        userSelect: 'none',
        marginInlineEnd: 8,
      }}
    >
      {data.version}
    </span>
  );
};

// DefaultPasswordWarning renders a small amber exclamation icon in the
// header actions area when the server reports that ADMIN_PASSWORD is
// still the seed value. Hover surfaces a Tooltip telling the operator
// to rotate. Hides itself when the password is custom (the common
// case after first-time setup).
export const DefaultPasswordWarning: React.FC = () => {
  const { initialState } = useModel('@@initialState');
  const intl = useIntl();
  if (!initialState?.currentUser?.mustRotatePassword) return null;
  return (
    <Tooltip title={intl.formatMessage({ id: 'pages.global.defaultPasswordWarning' })}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          color: '#faad14',
          cursor: 'help',
          fontSize: 13,
          marginInlineEnd: 8,
        }}
        aria-label="default-password-warning"
      >
        <ExclamationCircleFilled style={{ fontSize: 16 }} />
      </span>
    </Tooltip>
  );
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
