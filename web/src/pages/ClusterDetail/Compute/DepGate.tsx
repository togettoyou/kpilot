import { ReloadOutlined } from '@ant-design/icons';
import { history, useIntl, useParams } from '@umijs/max';
import { Button, Card, Result } from 'antd';
import React from 'react';

import type { HAMiState } from './useGPUData';

interface Props {
  hamiState: HAMiState;
  loading: boolean;
  onRefresh: () => void;
  // children render only when hamiState === 'ready'.
  children: React.ReactNode;
}

// DepGate centralizes the HAMi dep-check Result page so all four 智算
// sub-pages render the same loading + missing/installing/failed
// experience without copy-pasting the JSX. Children are evaluated only
// once the plugin is reported Running.
const DepGate: React.FC<Props> = ({ hamiState, loading, onRefresh, children }) => {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <Card loading style={{ minHeight: 200 }} />
      </div>
    );
  }
  if (hamiState === 'ready') {
    return <>{children}</>;
  }
  const status = hamiState === 'failed' ? 'error' : hamiState === 'installing' ? 'info' : 'warning';
  return (
    <Result
      status={status as 'error' | 'info' | 'warning'}
      title={intl.formatMessage({ id: `pages.gpu.${hamiState}.title` })}
      subTitle={intl.formatMessage({ id: `pages.gpu.${hamiState}.subTitle` })}
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
