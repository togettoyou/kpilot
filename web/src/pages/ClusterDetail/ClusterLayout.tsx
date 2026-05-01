import { ArrowLeftOutlined } from '@ant-design/icons';
import { history, useIntl, useParams } from '@umijs/max';
import { Button, Layout, Menu, theme as antdTheme } from 'antd';
import { useThemeMode } from 'antd-style';
import React from 'react';

const { Sider, Content } = Layout;

const parentKeyMap: Record<string, string> = {
  deployments: 'workloads-group',
  statefulsets: 'workloads-group',
  daemonsets: 'workloads-group',
  pods: 'workloads-group',
  services: 'network-group',
  ingresses: 'network-group',
  configmaps: 'config-group',
  secrets: 'config-group',
};

interface ClusterLayoutProps {
  selectedKey: string;
  children: React.ReactNode;
}

export function ClusterLayout({ selectedKey, children }: ClusterLayoutProps) {
  const { id: clusterId } = useParams<{ id: string }>();
  const intl = useIntl();
  const { isDarkMode } = useThemeMode();
  const { token } = antdTheme.useToken();

  const go = (path: string) => history.push(`/clusters/${clusterId}/${path}`);
  const defaultOpenKeys = parentKeyMap[selectedKey] ? [parentKeyMap[selectedKey]] : [];

  const items = [
    {
      key: 'nodes',
      label: intl.formatMessage({ id: 'pages.cluster.nav.nodes' }),
      onClick: () => go('nodes'),
    },
    {
      key: 'workloads-group',
      label: intl.formatMessage({ id: 'pages.cluster.nav.workloads' }),
      children: [
        { key: 'deployments', label: 'Deployments', onClick: () => go('workloads/deployments') },
        { key: 'statefulsets', label: 'StatefulSets', onClick: () => go('workloads/statefulsets') },
        { key: 'daemonsets', label: 'DaemonSets', onClick: () => go('workloads/daemonsets') },
        { key: 'pods', label: 'Pods', onClick: () => go('workloads/pods') },
      ],
    },
    {
      key: 'network-group',
      label: intl.formatMessage({ id: 'pages.cluster.nav.network' }),
      children: [
        { key: 'services', label: 'Services', onClick: () => go('workloads/services') },
        { key: 'ingresses', label: 'Ingresses', onClick: () => go('workloads/ingresses') },
      ],
    },
    {
      key: 'config-group',
      label: intl.formatMessage({ id: 'pages.cluster.nav.config' }),
      children: [
        { key: 'configmaps', label: 'ConfigMaps', onClick: () => go('workloads/configmaps') },
        { key: 'secrets', label: 'Secrets', onClick: () => go('workloads/secrets') },
      ],
    },
    { key: 'plugins',    label: intl.formatMessage({ id: 'pages.cluster.nav.plugins' }),    disabled: true },
    { key: 'gpu',        label: intl.formatMessage({ id: 'pages.cluster.nav.gpu' }),        disabled: true },
    { key: 'models',     label: intl.formatMessage({ id: 'pages.cluster.nav.models' }),     disabled: true },
    { key: 'monitoring', label: intl.formatMessage({ id: 'pages.cluster.nav.monitoring' }), disabled: true },
    { key: 'logging',    label: intl.formatMessage({ id: 'pages.cluster.nav.logging' }),    disabled: true },
  ];

  return (
    <Layout className="h-screen overflow-hidden" style={{ background: token.colorBgLayout }}>
      <Sider
        width={200}
        theme={isDarkMode ? 'dark' : 'light'}
        style={{
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
        className="h-full overflow-y-auto flex-shrink-0"
      >
        <div
          style={{
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            padding: '16px',
          }}
        >
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => history.push('/clusters')}
            size="small"
          >
            {intl.formatMessage({ id: 'pages.cluster.back' })}
          </Button>
        </div>
        <Menu
          key={selectedKey}
          mode="inline"
          theme={isDarkMode ? 'dark' : 'light'}
          selectedKeys={[selectedKey]}
          defaultOpenKeys={defaultOpenKeys}
          items={items}
          style={{ border: 0, background: 'transparent' }}
        />
      </Sider>
      <Content style={{ background: token.colorBgLayout }} className="overflow-y-auto">
        {children}
      </Content>
    </Layout>
  );
}
