import {
  AlertOutlined,
  CheckCircleOutlined,
  InfoCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import { history, useIntl, useParams, useRequest } from '@umijs/max';
import {
  Card,
  Col,
  Empty,
  Result,
  Row,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import React from 'react';

import {
  getDeviceHealth,
  type DeviceAlert,
} from '@/services/kpilot/device-health';

import {
  NotInstalled,
  RefreshControl,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';

// DeviceHealth — single-page aggregation of GPU hardware health
// signals sourced from DCGM Exporter (via VictoriaMetrics through the
// worker tunnel). Sister to vGPU view: vGPU shows the slice-allocation
// side of GPU state; this page surfaces the fault side (XID, ECC,
// overheat, FB-near-full).
//
// Data flow: GET /clusters/:id/device-health → server-side fan-out to
// VM running four pre-canned PromQL queries → returns unified alert
// list with severity counts pre-computed.

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'red',
  warning: 'orange',
  info: 'blue',
};

// Map enum kind → i18n suffix. Unknown kinds (added server-side
// without a corresponding frontend update) fall through to the raw
// kind string — no crash, just less polished labels.
const KIND_I18N: Record<string, string> = {
  xid_error: 'pages.deviceHealth.kind.xidError',
  ecc_uncorrectable: 'pages.deviceHealth.kind.eccUncorrect',
  overheat: 'pages.deviceHealth.kind.overheat',
  fb_memory_near_full: 'pages.deviceHealth.kind.fbMemoryFull',
};

const DeviceHealthPage: React.FC = () => {
  const intl = useIntl();
  const { id: clusterId = '' } = useParams<{ id: string }>();

  const { data, loading, error, refresh } = useRequest(
    () => getDeviceHealth(clusterId),
    { formatResult: (res) => res, refreshDeps: [clusterId], ready: !!clusterId },
  );

  const [interval, setInter] = useAutoRefresh(refresh, !!data);

  if (error && isResourceNotAvailable(error)) {
    return (
      <PageContainer ghost>
        <NotInstalled
          clusterId={clusterId}
          titleId="pages.deviceHealth.notInstalled.title"
          subTitleId="pages.deviceHealth.notInstalled.subTitle"
          actionId="pages.deviceHealth.notInstalled.action"
        />
      </PageContainer>
    );
  }
  if (error) {
    return (
      <PageContainer ghost>
        <Result
          status="error"
          title={intl.formatMessage({ id: 'pages.deviceHealth.error.title' })}
          subTitle={(error as Error).message}
        />
      </PageContainer>
    );
  }

  const counts = data?.counts ?? { critical: 0, warning: 0, info: 0 };
  const alerts: DeviceAlert[] = data?.alerts ?? [];

  const columns: ProColumns<DeviceAlert>[] = [
    {
      title: intl.formatMessage({ id: 'pages.deviceHealth.col.severity' }),
      dataIndex: 'severity',
      width: 110,
      filters: [
        {
          text: intl.formatMessage({ id: 'pages.deviceHealth.severity.critical' }),
          value: 'critical',
        },
        {
          text: intl.formatMessage({ id: 'pages.deviceHealth.severity.warning' }),
          value: 'warning',
        },
        {
          text: intl.formatMessage({ id: 'pages.deviceHealth.severity.info' }),
          value: 'info',
        },
      ],
      onFilter: (value, record) => record.severity === value,
      render: (_, row) => (
        <Tag color={SEVERITY_COLOR[row.severity] ?? 'default'}>
          {intl.formatMessage({
            id: `pages.deviceHealth.severity.${row.severity}`,
          })}
        </Tag>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.deviceHealth.col.kind' }),
      dataIndex: 'kind',
      width: 180,
      render: (_, row) => {
        const id = KIND_I18N[row.kind];
        return id ? intl.formatMessage({ id }) : row.kind;
      },
    },
    {
      title: intl.formatMessage({ id: 'pages.deviceHealth.col.hostname' }),
      dataIndex: 'hostname',
      width: 180,
      ellipsis: true,
      render: (_, row) => {
        if (!row.hostname) return '-';
        // Drilldown: clicking the hostname jumps to the cluster's Nodes
        // page which is where remediation typically starts (cordon /
        // drain / SSH).
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
      title: intl.formatMessage({ id: 'pages.deviceHealth.col.gpu' }),
      dataIndex: 'gpu',
      width: 80,
      render: (_, row) => row.gpu ?? '-',
    },
    {
      title: intl.formatMessage({ id: 'pages.deviceHealth.col.uuid' }),
      dataIndex: 'uuid',
      width: 170,
      ellipsis: true,
      render: (_, row) => {
        if (!row.uuid) return '-';
        // Show last 8 chars only — full UUID is in the tooltip for
        // copy/paste. Same convention as the vGPU page.
        return (
          <Typography.Text copyable={{ text: row.uuid }} style={{ fontSize: 12 }}>
            …{row.uuid.slice(-8)}
          </Typography.Text>
        );
      },
    },
    {
      title: intl.formatMessage({ id: 'pages.deviceHealth.col.message' }),
      dataIndex: 'message',
      ellipsis: true,
    },
  ];

  return (
    <PageContainer
      ghost
      header={{
        title: intl.formatMessage({ id: 'pages.deviceHealth.title' }),
        extra: (
          <RefreshControl
            interval={interval}
            setInterval={setInter}
            loading={loading}
            refresh={refresh}
          />
        ),
      }}
    >
      <Spin spinning={loading && !data}>
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {/* KPI row — server pre-computes the counts so the cards
             render before the table mounts. All clear = green check
             card so the page doesn't feel "empty" when healthy. */}
          <Row gutter={16}>
            <Col xs={24} sm={8}>
              <Card>
                <Statistic
                  title={intl.formatMessage({
                    id: 'pages.deviceHealth.severity.critical',
                  })}
                  value={counts.critical}
                  prefix={<AlertOutlined style={{ color: '#ff4d4f' }} />}
                  valueStyle={{
                    color: counts.critical > 0 ? '#ff4d4f' : undefined,
                  }}
                />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card>
                <Statistic
                  title={intl.formatMessage({
                    id: 'pages.deviceHealth.severity.warning',
                  })}
                  value={counts.warning}
                  prefix={<WarningOutlined style={{ color: '#fa8c16' }} />}
                  valueStyle={{
                    color: counts.warning > 0 ? '#fa8c16' : undefined,
                  }}
                />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card>
                <Statistic
                  title={intl.formatMessage({
                    id: 'pages.deviceHealth.severity.info',
                  })}
                  value={counts.info}
                  prefix={<InfoCircleOutlined style={{ color: '#1677ff' }} />}
                />
              </Card>
            </Col>
          </Row>

          {alerts.length === 0 ? (
            <Card>
              <Empty
                image={
                  <CheckCircleOutlined
                    style={{ fontSize: 48, color: '#52c41a' }}
                  />
                }
                description={
                  <Space direction="vertical" align="center">
                    <Typography.Text strong>
                      {intl.formatMessage({
                        id: 'pages.deviceHealth.empty.title',
                      })}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      {intl.formatMessage({
                        id: 'pages.deviceHealth.empty.subTitle',
                      })}
                    </Typography.Text>
                  </Space>
                }
              />
            </Card>
          ) : (
            <ProTable<DeviceAlert>
              dataSource={alerts}
              columns={columns}
              rowKey={(row) =>
                `${row.kind}/${row.hostname || ''}/${row.gpu || ''}/${row.uuid || ''}`
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

export default DeviceHealthPage;
