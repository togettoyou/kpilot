import { DownOutlined, ReloadOutlined } from '@ant-design/icons';
import { history, useIntl } from '@umijs/max';
import {
  Button,
  Drawer,
  Dropdown,
  Result,
  Space,
  Spin,
  Table,
  Tag,
} from 'antd';
import React, { useEffect, useRef, useState } from 'react';

import {
  getPodTop,
  type PodContainerUsage,
  type PodTopResponse,
} from '@/services/kpilot/pod';

interface PodTopDrawerProps {
  open: boolean;
  onClose: () => void;
  clusterId: string;
  namespace: string;
  podName: string;
}

// Fetches metrics.k8s.io PodMetrics for a single pod. Errors are split:
//   - RESOURCE_NOT_AVAILABLE → friendly install hint with a deep-link to
//     the cluster's Plugins page (covers both "Metrics Server not
//     installed" and "metrics-server installed but no data yet").
//   - Anything else → generic "couldn't fetch" Result.
export function PodTopDrawer({
  open,
  onClose,
  clusterId,
  namespace,
  podName,
}: PodTopDrawerProps) {
  const intl = useIntl();
  const [data, setData] = useState<PodTopResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // Polling cadence matches the rest of the app's RefreshControl
  // (off / 5s / 10s / 30s / 60s). Default 5s preserves prior behavior.
  const [interval, setIntervalMs] = useState<number>(5000);

  const fetchOnce = React.useCallback(() => {
    setLoading(true);
    setErrMsg(null);
    getPodTop(clusterId, namespace, podName)
      .then((res) => {
        setData(res);
        setUnavailable(false);
      })
      .catch((err: any) => {
        const code = err?.response?.data?.code;
        if (code === 'RESOURCE_NOT_AVAILABLE') {
          setUnavailable(true);
          setData(null);
        } else {
          setErrMsg(
            err?.response?.data?.message ?? String(err?.message ?? err),
          );
        }
      })
      .finally(() => setLoading(false));
  }, [clusterId, namespace, podName]);

  // Reset & re-fetch every time the drawer opens for a different pod.
  useEffect(() => {
    if (!open) return;
    setData(null);
    setUnavailable(false);
    setErrMsg(null);
    fetchOnce();
  }, [open, fetchOnce]);

  // Auto-refresh while open. Cadence is user-controlled (off / 5 / 10 /
  // 30 / 60s) via the RefreshControl-style dropdown in the drawer extra.
  // Keep the latest fetch closure addressable through a ref so changing
  // the interval doesn't tear-down + recreate the timer on every render
  // (fetchOnce's identity already changes whenever clusterId/ns/pod
  // change, and that's what should drive the timer).
  const fetchRef = useRef(fetchOnce);
  useEffect(() => {
    fetchRef.current = fetchOnce;
  }, [fetchOnce]);
  useEffect(() => {
    if (!open || unavailable || interval <= 0) return;
    const t = setInterval(() => fetchRef.current(), interval);
    return () => clearInterval(t);
  }, [open, unavailable, interval]);

  const goToPlugins = () => {
    onClose();
    history.push(`/clusters/${clusterId}/plugins`);
  };

  const columns = [
    {
      title: intl.formatMessage({ id: 'pages.workloads.top.col.container' }),
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: intl.formatMessage({ id: 'pages.workloads.top.col.cpu' }),
      dataIndex: 'cpu_milli',
      key: 'cpu_milli',
      align: 'right' as const,
      render: (v: number) => `${v} m`,
    },
    {
      title: intl.formatMessage({ id: 'pages.workloads.top.col.memory' }),
      dataIndex: 'memory_bytes',
      key: 'memory_bytes',
      align: 'right' as const,
      render: (v: number) => formatMemory(v),
    },
  ];

  return (
    <Drawer
      title={
        <Space>
          <span>{intl.formatMessage({ id: 'pages.workloads.top.title' })}</span>
          <Tag>{namespace}</Tag>
          <Tag color="blue">{podName}</Tag>
        </Space>
      }
      open={open}
      onClose={onClose}
      size={720}
      maskClosable={false}
      destroyOnHidden
      extra={
        <Space.Compact>
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={fetchOnce}
            disabled={unavailable}
          />
          <Dropdown
            trigger={['click']}
            disabled={unavailable}
            menu={{
              items: [
                {
                  key: '0',
                  label: intl.formatMessage({
                    id: 'pages.workloads.refresh.off',
                  }),
                },
                { type: 'divider' },
                { key: '5000', label: '5s' },
                { key: '10000', label: '10s' },
                { key: '30000', label: '30s' },
                { key: '60000', label: '60s' },
              ],
              selectedKeys: [String(interval)],
              onClick: ({ key }) => setIntervalMs(Number(key)),
            }}
          >
            <Button style={{ minWidth: 46 }} disabled={unavailable}>
              {interval > 0 ? `${interval / 1000}s` : <DownOutlined />}
            </Button>
          </Dropdown>
        </Space.Compact>
      }
    >
      {unavailable ? (
        <Result
          status="info"
          title={intl.formatMessage({
            id: 'pages.workloads.top.unavailable.title',
          })}
          subTitle={intl.formatMessage({
            id: 'pages.workloads.top.unavailable.subtitle',
          })}
          extra={
            <Button type="primary" onClick={goToPlugins}>
              {intl.formatMessage({
                id: 'pages.workloads.top.unavailable.action',
              })}
            </Button>
          }
        />
      ) : errMsg ? (
        <Result status="error" title={errMsg} />
      ) : (
        <Spin spinning={loading && !data}>
          <Table<PodContainerUsage>
            rowKey="name"
            columns={columns}
            dataSource={data?.containers ?? []}
            pagination={false}
            size="small"
          />
          {data && (
            <div style={{ marginTop: 16, color: 'var(--ant-color-text-tertiary)', fontSize: 12 }}>
              {intl.formatMessage(
                { id: 'pages.workloads.top.meta' },
                {
                  ts: new Date(data.timestamp).toLocaleString(),
                  window: data.window,
                },
              )}
            </div>
          )}
        </Spin>
      )}
    </Drawer>
  );
}

// metrics.k8s.io reports memory in bytes. Show MiB / GiB for readability.
function formatMemory(b: number): string {
  if (b <= 0) return '0';
  const mib = b / (1024 * 1024);
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(2)} GiB`;
}
