import {
  DeleteOutlined,
  FileSearchOutlined,
  MessageOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import type { TableColumnsType } from 'antd';
import {
  Alert,
  App,
  Badge,
  Button,
  Drawer,
  Empty,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import React, { useCallback, useEffect, useState } from 'react';

import type { Model, ModelInstance } from '@/services/kpilot/model';
import { listModelDeployments } from '@/services/kpilot/model';
import { deleteWorkload } from '@/services/kpilot/workload';

dayjs.extend(relativeTime);

const { Text } = Typography;

// DeploymentsDrawer lists every inference Deployment labelled with
// the model's id across every online cluster. Cluster is the source
// of truth — the server fans out a labelled list-full per cluster
// and merges the rows; we render flat with a Cluster column rather
// than grouped sections (small lists, easier scanning + a single
// sortable table).
//
// Per-row actions:
//   - Chat 调试  → opens ChatDrawer pointing at the instance Service
//   - Describe   → opens the existing /workloads/.../describe drawer
//                  (not embedded here — too heavy for a sub-drawer)
//                  (P16-B v1: we just link out to the workloads page)
//   - Delete     → DELETE the Deployment (Service / PVC orphaned;
//                  surfaced as a hint so users know to clean up)

interface Props {
  open: boolean;
  model: Model | null;
  onClose: () => void;
  onOpenChat: (m: Model, instance: ModelInstance) => void;
}

const STATUS_COLOR: Record<string, string> = {
  Running: 'green',
  Progressing: 'gold',
  Failed: 'red',
};

const DeploymentsDrawer: React.FC<Props> = ({
  open,
  model,
  onClose,
  onOpenChat,
}) => {
  const intl = useIntl();
  const { modal, message } = App.useApp();
  const { token } = theme.useToken();

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ModelInstance[]>([]);
  const [errors, setErrors] = useState<
    { cluster_id: string; cluster_name: string; error: string }[]
  >([]);

  const fetch = useCallback(async () => {
    if (!model) return;
    setLoading(true);
    try {
      const res = await listModelDeployments(model.id);
      setRows(res.instances ?? []);
      setErrors(res.errors ?? []);
    } catch (e) {
      // requestErrorConfig already toasts the user-facing code.
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [model]);

  useEffect(() => {
    if (open && model) {
      fetch();
    } else {
      // Reset on close so a stale row from the previous model
      // doesn't flash when the user opens a different card.
      setRows([]);
      setErrors([]);
    }
  }, [open, model, fetch]);

  const handleDelete = (row: ModelInstance) => {
    modal.confirm({
      title: intl.formatMessage(
        { id: 'pages.models.deployments.delete.confirm' },
        { name: row.name, cluster: row.cluster_name },
      ),
      content: intl.formatMessage({
        id: 'pages.models.deployments.delete.note',
      }),
      okType: 'danger',
      onOk: async () => {
        await deleteWorkload(
          row.cluster_id,
          'deployments',
          row.name,
          row.namespace,
        );
        message.success(
          intl.formatMessage({ id: 'pages.models.deployments.delete.success' }),
        );
        fetch();
      },
    });
  };

  const columns: TableColumnsType<ModelInstance> = [
    {
      title: intl.formatMessage({ id: 'pages.models.deployments.col.status' }),
      dataIndex: 'status',
      width: 110,
      render: (s: string, r) => (
        <Space>
          <Tag color={STATUS_COLOR[s] ?? 'default'} style={{ marginRight: 0 }}>
            {s}
          </Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {r.ready_replicas}/{r.replicas}
          </Text>
        </Space>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.deployments.col.cluster' }),
      dataIndex: 'cluster_name',
      width: 160,
      render: (n: string) => <Text>{n}</Text>,
    },
    {
      title: intl.formatMessage({
        id: 'pages.models.deployments.col.namespace',
      }),
      dataIndex: 'namespace',
      width: 140,
      render: (ns: string) => (
        <Text type="secondary" code>
          {ns}
        </Text>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.deployments.col.name' }),
      dataIndex: 'name',
      render: (n: string, r) => (
        <Space direction="vertical" size={0}>
          <Text code style={{ fontSize: 12 }}>
            {n}
          </Text>
          {r.instance_suffix && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {intl.formatMessage(
                { id: 'pages.models.deployments.instanceSuffix' },
                { v: r.instance_suffix },
              )}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.deployments.col.age' }),
      dataIndex: 'created_at',
      width: 110,
      render: (ts: string) => (
        <Tooltip title={dayjs(ts).format('YYYY-MM-DD HH:mm:ss')}>
          <Text type="secondary">{dayjs(ts).fromNow(true)}</Text>
        </Tooltip>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.common.actions' }),
      key: 'actions',
      fixed: 'right',
      width: 160,
      render: (_, row) => {
        const canChat = row.status === 'Running' && row.ready_replicas > 0;
        return (
          <Space size={2}>
            <Tooltip
              title={
                canChat
                  ? intl.formatMessage({
                      id: 'pages.models.deployments.action.chat',
                    })
                  : intl.formatMessage({
                      id: 'pages.models.deployments.action.chatDisabled',
                    })
              }
            >
              <Button
                size="small"
                type="text"
                icon={<MessageOutlined />}
                disabled={!canChat}
                onClick={() => model && onOpenChat(model, row)}
              />
            </Tooltip>
            <Tooltip
              title={intl.formatMessage({
                id: 'pages.models.deployments.action.describe',
              })}
            >
              <Button
                size="small"
                type="text"
                icon={<FileSearchOutlined />}
                onClick={() =>
                  window.open(
                    `/clusters/${row.cluster_id}/workloads?type=deployments&namespace=${encodeURIComponent(row.namespace)}&q=${encodeURIComponent(row.name)}`,
                    '_blank',
                  )
                }
              />
            </Tooltip>
            <Tooltip title={intl.formatMessage({ id: 'pages.common.delete' })}>
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => handleDelete(row)}
              />
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        <Space>
          <span>
            {intl.formatMessage({ id: 'pages.models.deployments.title' })}
          </span>
          {model && (
            <Text type="secondary" style={{ fontSize: 13 }}>
              {model.display_name}
            </Text>
          )}
          <Badge
            count={rows.length}
            showZero
            style={{
              backgroundColor: token.colorFillSecondary,
              color: token.colorTextSecondary,
            }}
          />
        </Space>
      }
      size="large"
      maskClosable={false}
      extra={
        <Button icon={<ReloadOutlined />} loading={loading} onClick={fetch}>
          {intl.formatMessage({ id: 'pages.common.refresh' })}
        </Button>
      }
    >
      <Spin spinning={loading}>
        {errors.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={intl.formatMessage({
              id: 'pages.models.deployments.partialFail.title',
            })}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {errors.map((e) => (
                  <li key={e.cluster_id}>
                    <Text>{e.cluster_name}</Text>:{' '}
                    <Text type="secondary">{e.error}</Text>
                  </li>
                ))}
              </ul>
            }
          />
        )}

        {rows.length === 0 && !loading ? (
          <Empty
            description={intl.formatMessage({
              id: 'pages.models.deployments.empty',
            })}
          />
        ) : (
          <Table
            rowKey={(r) => `${r.cluster_id}/${r.namespace}/${r.name}`}
            columns={columns}
            dataSource={rows}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
          />
        )}
      </Spin>
    </Drawer>
  );
};

export default DeploymentsDrawer;
