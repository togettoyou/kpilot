import { ReloadOutlined } from '@ant-design/icons';
import { history, useIntl, useParams } from '@umijs/max';
import { Button, Card, Result } from 'antd';
import React from 'react';

import type { GPUDepState } from './useGPUData';

interface Props {
  depState: GPUDepState;
  loading: boolean;
  onRefresh: () => void;
  // children render only when depState === 'ready'.
  children: React.ReactNode;
}

// DepGate centralizes the GPU plugin dep-check Result page so the GPU
// sub-pages render the same loading + missing/installing/failed
// experience without copy-pasting the JSX. Children are evaluated only
// once the plugin is reported Running.
const DepGate: React.FC<Props> = ({ depState, loading, onRefresh, children }) => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <Card loading style={{ minHeight: 200 }} />
      </div>
    );
  }
  if (depState === 'ready') {
    return <>{children}</>;
  }
  const status = depState === 'failed' ? 'error' : depState === 'installing' ? 'info' : 'warning';
  return (
    <Result
      status={status as 'error' | 'info' | 'warning'}
      title={intl.formatMessage({ id: `pages.gpu.${depState}.title` })}
      subTitle={intl.formatMessage({ id: `pages.gpu.${depState}.subTitle` })}
      extra={[
        <Button
          key="enable"
          type="primary"
          onClick={() => history.push(`/clusters/${clusterId}/plugins`)}
        >
          {intl.formatMessage({ id: 'pages.gpu.cta.goPlugins' })}
        </Button>,
        <Button key="refresh" icon={<ReloadOutlined />} onClick={onRefresh}>
          {intl.formatMessage({ id: 'pages.gpu.cta.refresh' })}
        </Button>,
      ]}
    />
  );
};

export default DepGate;
