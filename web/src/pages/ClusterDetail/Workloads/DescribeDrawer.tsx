import { CopyOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import {
  Alert,
  App,
  Button,
  Drawer,
  Space,
  Spin,
  Tag,
  theme as antdTheme,
} from 'antd';
import React, { useEffect, useState } from 'react';

import type { WorkloadResourceType } from '@/services/kpilot/workload';
import { describeWorkload } from '@/services/kpilot/workload';

interface DescribeDrawerProps {
  open: boolean;
  onClose: () => void;
  clusterId: string;
  resourceType: WorkloadResourceType;
  name: string;
  namespace: string;
}

export function DescribeDrawer({
  open,
  onClose,
  clusterId,
  resourceType,
  name,
  namespace,
}: DescribeDrawerProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const { token } = antdTheme.useToken();

  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setText('');
    describeWorkload(clusterId, resourceType, name, namespace)
      .then((res) => {
        if (!cancelled) setText(typeof res === 'string' ? res : '');
      })
      .catch((err: any) => {
        if (!cancelled) setError(String(err?.message ?? err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, clusterId, resourceType, name, namespace]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(intl.formatMessage({ id: 'pages.workloads.copied' }));
    } catch {
      message.error(intl.formatMessage({ id: 'pages.describe.copyFailed' }));
    }
  };

  return (
    <Drawer
      title={
        <Space>
          <span>{intl.formatMessage({ id: 'pages.describe.title' })}</span>
          {namespace && <Tag>{namespace}</Tag>}
          <Tag color="blue">{name}</Tag>
        </Space>
      }
      open={open}
      onClose={onClose}
      size="60vw"
      maskClosable={false}
      destroyOnHidden
      extra={
        <Button
          size="small"
          icon={<CopyOutlined />}
          disabled={!text}
          onClick={handleCopy}
        >
          {intl.formatMessage({ id: 'pages.describe.copy' })}
        </Button>
      }
      styles={{
        body: {
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        },
      }}
    >
      {error && <Alert message={error} type="error" banner />}
      {loading ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spin />
        </div>
      ) : (
        <pre
          style={{
            flex: 1,
            margin: 0,
            padding: '12px 16px',
            background: token.colorBgLayout,
            color: token.colorText,
            fontFamily:
              'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
            fontSize: 12,
            lineHeight: 1.5,
            overflow: 'auto',
            whiteSpace: 'pre',
          }}
        >
          {text}
        </pre>
      )}
    </Drawer>
  );
}
