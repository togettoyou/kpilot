import { ClockCircleOutlined } from '@ant-design/icons';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import { history, useIntl, useParams, useRequest } from '@umijs/max';
import {
  Alert,
  Card,
  Col,
  Empty,
  Progress,
  Radio,
  Result,
  Row,
  Space,
  Spin,
  Statistic,
  Typography,
} from 'antd';
import React, { useState } from 'react';

import {
  getGPUHour,
  type GPUHourRange,
  type GPUHourRow,
} from '@/services/kpilot/gpu-hour';

import {
  NotInstalled,
  RefreshControl,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

// GPUHour — historical hardware utilization report. Server integrates
// DCGM_FI_DEV_GPU_UTIL/100 over the picked window into GPU-hours per
// (hostname, gpu, uuid).
//
// Known limitations (also called out on the page itself):
// - v1 groups by hardware only; queue / namespace / pod breakdowns
//   require Volcano allocation snapshots persisted on the server side
//   (P14c-ext, not implemented).
// - 30d range bumps against the default victoria-metrics-single
//   retention. Older history would silently appear empty rather than
//   error — the page banner warns the user before they over-trust the
//   30d view.

const RANGES: GPUHourRange[] = ['1h', '24h', '7d', '30d'];

const GPUHourPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId = '' } = useParams<{ id: string }>();

  const [range, setRange] = useState<GPUHourRange>('24h');

  const { data, loading, error, refresh } = useRequest(
    () => getGPUHour(clusterId, range),
    {
      formatResult: (res) => res,
      refreshDeps: [clusterId, range],
      ready: !!clusterId,
    },
  );

  const [interval, setInter] = useAutoRefresh(refresh, !!data);

  if (error && isResourceNotAvailable(error)) {
    return (
      <PageContainer ghost>
        <NotInstalled
          clusterId={clusterId}
          titleId="pages.gpuHour.notInstalled.title"
          subTitleId="pages.gpuHour.notInstalled.subTitle"
          actionId="pages.gpuHour.notInstalled.action"
        />
      </PageContainer>
    );
  }
  if (error) {
    return (
      <PageContainer ghost>
        <Result
          status="error"
          title={intl.formatMessage({ id: 'pages.gpuHour.error.title' })}
          subTitle={(error as Error).message}
        />
      </PageContainer>
    );
  }

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  // Top contributor used for the in-table progress bar's denominator.
  // Falls back to 1 when total is 0 so the Progress doesn't divide by
  // zero on a fresh cluster.
  const topHours = rows.length > 0 ? rows[0].hours : 1;

  const columns: ProColumns<GPUHourRow>[] = [
    {
      title: intl.formatMessage({ id: 'pages.gpuHour.col.hostname' }),
      dataIndex: 'hostname',
      width: 180,
      ellipsis: true,
      render: (_, row) => {
        if (!row.hostname) return '-';
        return (
          <Typography.Link
            onClick={() => history.push(`/clusters/${clusterId}/nodes`)}
          >
            {row.hostname}
          </Typography.Link>
        );
      },
    },
    {
      title: intl.formatMessage({ id: 'pages.gpuHour.col.gpu' }),
      dataIndex: 'gpu',
      width: 80,
      render: (_, row) => row.gpu ?? '-',
    },
    {
      title: intl.formatMessage({ id: 'pages.gpuHour.col.uuid' }),
      dataIndex: 'uuid',
      width: 170,
      ellipsis: true,
      render: (_, row) => {
        if (!row.uuid) return '-';
        return (
          <Typography.Text copyable={{ text: row.uuid }} style={{ fontSize: 12 }}>
            …{row.uuid.slice(-8)}
          </Typography.Text>
        );
      },
    },
    {
      title: intl.formatMessage({ id: 'pages.gpuHour.col.hours' }),
      dataIndex: 'hours',
      width: 130,
      sorter: (a, b) => a.hours - b.hours,
      defaultSortOrder: 'descend',
      render: (_, row) => (
        <Typography.Text strong>{fmtHours(row.hours)}</Typography.Text>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.gpuHour.col.share' }),
      width: 240,
      render: (_, row) => (
        <Progress
          percent={total > 0 ? (row.hours / topHours) * 100 : 0}
          size="small"
          showInfo={total > 0}
          format={() =>
            total > 0
              ? `${((row.hours / total) * 100).toFixed(1)}%`
              : '-'
          }
        />
      ),
    },
  ];

  return (
    <PageContainer
      ghost
      header={{
        title: intl.formatMessage({ id: 'pages.gpuHour.title' }),
        extra: (
          <Space>
            <Radio.Group
              value={range}
              onChange={(e) => setRange(e.target.value)}
              optionType="button"
              buttonStyle="solid"
              options={RANGES.map((r) => ({ label: r, value: r }))}
            />
            <RefreshControl
              interval={interval}
              setInterval={setInter}
              loading={loading}
              refresh={refresh}
            />
          </Space>
        ),
      }}
    >
      <Spin spinning={loading && !data}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {range === '30d' && (
            <Alert
              type="info"
              showIcon
              message={intl.formatMessage({
                id: 'pages.gpuHour.retentionWarning',
              })}
            />
          )}
          <Alert
            type="info"
            showIcon
            message={intl.formatMessage({ id: 'pages.gpuHour.limitation' })}
          />
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Card>
                <Statistic
                  title={intl.formatMessage({ id: 'pages.gpuHour.total' })}
                  value={fmtHours(total)}
                  suffix={intl.formatMessage({ id: 'pages.gpuHour.unit' })}
                  prefix={<ClockCircleOutlined />}
                />
              </Card>
            </Col>
            <Col xs={24} sm={12}>
              <Card>
                <Statistic
                  title={intl.formatMessage({ id: 'pages.gpuHour.activeGPUs' })}
                  value={rows.length}
                />
              </Card>
            </Col>
          </Row>

          {rows.length === 0 ? (
            <Card>
              <Empty
                description={intl.formatMessage({
                  id: 'pages.gpuHour.empty',
                })}
              />
            </Card>
          ) : (
            <ProTable<GPUHourRow>
              dataSource={rows}
              columns={columns}
              rowKey={(row) =>
                `${row.hostname || ''}/${row.gpu || ''}/${row.uuid || ''}`
              }
              search={false}
              options={{ reload: false, density: true, fullScreen: false }}
              pagination={{ pageSize: 20, showSizeChanger: true }}
              scroll={{ x: 'max-content' }}
            />
          )}
        </Space>
      </Spin>
    </PageContainer>
  );
};

export default GPUHourPage;

function fmtHours(h: number): string {
  if (!Number.isFinite(h)) return '0';
  if (h >= 100) return h.toFixed(0);
  if (h >= 1) return h.toFixed(2);
  return h.toFixed(3);
}
