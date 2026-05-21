import {
  DeleteOutlined,
  FileSearchOutlined,
  MessageOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { history, useIntl } from '@umijs/max';
import {
  Alert,
  App,
  Avatar,
  Button,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  ModelFamily,
  ModelInstance,
  ModelRuntime,
} from '@/services/kpilot/model';
import {
  FAMILY_META,
  listDeployments,
  MODEL_FAMILIES,
  MODEL_RUNTIMES,
  RUNTIME_LABELS,
} from '@/services/kpilot/model';
import { deleteWorkload } from '@/services/kpilot/workload';

dayjs.extend(relativeTime);

const { Text } = Typography;

// ModelDeployments — platform-level survey of every KPilot-managed
// inference Deployment across every online cluster. Pairs with the
// Catalog page (templates) and Chat page (debug) as the three peers
// under the 模型服务 menu.
//
// Design choices:
//   - Single ProTable with column-level filters (Cluster / Status)
//     and a top-bar search by model name. No grouping — the cluster /
//     model / namespace tuple is short and easy to scan.
//   - Per-row actions match what the (now-removed) per-model drawer
//     had: Chat / Describe / Delete. Chat navigates to /models/chat
//     with the instance pinned via URL params.
//   - Refresh button in the toolbar; we don't auto-refresh because
//     deployments don't churn fast and a cross-cluster fan-out is
//     not free (every online worker pays for it).

const STATUS_COLOR: Record<string, string> = {
  Running: 'green',
  Progressing: 'gold',
  Failed: 'red',
};

const ModelDeploymentsPage: React.FC = () => {
  const intl = useIntl();
  const { modal, message } = App.useApp();

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<ModelInstance[]>([]);
  const [errors, setErrors] = useState<
    { cluster_id: string; cluster_name: string; error: string }[]
  >([]);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listDeployments();
      setRows(res.instances ?? []);
      setErrors(res.errors ?? []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  // Distinct cluster list for the column filter — derived from
  // current rows so we never advertise a cluster that has zero hits.
  const clusterFilters = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) seen.set(r.cluster_id, r.cluster_name);
    return Array.from(seen.entries()).map(([id, name]) => ({
      text: name,
      value: id,
    }));
  }, [rows]);

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

  const openChat = (row: ModelInstance) => {
    // Use query params so the chat URL is shareable and copy-pasting
    // it into another tab restores the exact target instance. The
    // chat page reads cluster / namespace / name from `location.search`.
    history.push(
      `/models/chat?cluster=${encodeURIComponent(row.cluster_id)}&ns=${encodeURIComponent(row.namespace)}&name=${encodeURIComponent(row.name)}`,
    );
  };

  const columns: ProColumns<ModelInstance>[] = [
    {
      title: intl.formatMessage({ id: 'pages.models.deployments.col.model' }),
      key: 'model',
      width: 220,
      render: (_, row) => {
        const family = row.model_family as ModelFamily | undefined;
        const meta =
          family && family !== 'custom'
            ? FAMILY_META[family as Exclude<ModelFamily, 'custom'>]
            : null;
        return (
          <Space>
            <Avatar
              shape="square"
              size={28}
              src={meta?.iconUrl}
              style={{
                backgroundColor: meta?.color ?? '#8c8c8c',
                color: '#fff',
                flexShrink: 0,
              }}
            >
              {row.model_display_name.charAt(0).toUpperCase()}
            </Avatar>
            <Space direction="vertical" size={0}>
              <Text strong style={{ fontSize: 13 }}>
                {row.model_display_name}
              </Text>
              {row.model_id === 0 && (
                <Tag color="red" style={{ marginRight: 0, fontSize: 10 }}>
                  {intl.formatMessage({
                    id: 'pages.models.deployments.orphanTag',
                  })}
                </Tag>
              )}
            </Space>
          </Space>
        );
      },
    },
    {
      title: intl.formatMessage({ id: 'pages.models.deployments.col.runtime' }),
      dataIndex: 'model_runtime',
      width: 90,
      filters: MODEL_RUNTIMES.map((r) => ({
        text: RUNTIME_LABELS[r],
        value: r,
      })),
      onFilter: (val, row) => row.model_runtime === val,
      render: (_, row) =>
        row.model_runtime ? (
          <Tag style={{ marginRight: 0 }}>
            {RUNTIME_LABELS[row.model_runtime as ModelRuntime]}
          </Tag>
        ) : (
          '—'
        ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.deployments.col.cluster' }),
      dataIndex: 'cluster_id',
      width: 160,
      filters: clusterFilters,
      onFilter: (val, row) => row.cluster_id === val,
      render: (_, row) => <Text>{row.cluster_name}</Text>,
    },
    {
      title: intl.formatMessage({
        id: 'pages.models.deployments.col.namespace',
      }),
      dataIndex: 'namespace',
      width: 140,
      render: (ns: React.ReactNode) => (
        <Text type="secondary" code>
          {ns}
        </Text>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.deployments.col.name' }),
      dataIndex: 'name',
      width: 220,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text code style={{ fontSize: 12 }}>
            {row.name}
          </Text>
          {row.instance_suffix && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {intl.formatMessage(
                { id: 'pages.models.deployments.instanceSuffix' },
                { v: row.instance_suffix },
              )}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.deployments.col.status' }),
      dataIndex: 'status',
      width: 130,
      filters: [
        { text: 'Running', value: 'Running' },
        { text: 'Progressing', value: 'Progressing' },
        { text: 'Failed', value: 'Failed' },
      ],
      onFilter: (val, row) => row.status === val,
      render: (_, row) => (
        <Space>
          <Tag
            color={STATUS_COLOR[row.status] ?? 'default'}
            style={{ marginRight: 0 }}
          >
            {row.status}
          </Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {row.ready_replicas}/{row.replicas}
          </Text>
        </Space>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.deployments.col.age' }),
      dataIndex: 'created_at',
      width: 110,
      sorter: (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      render: (_, row) => (
        <Tooltip title={dayjs(row.created_at).format('YYYY-MM-DD HH:mm:ss')}>
          <Text type="secondary">{dayjs(row.created_at).fromNow(true)}</Text>
        </Tooltip>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.common.actions' }),
      key: 'actions',
      fixed: 'right',
      width: 130,
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
                onClick={() => openChat(row)}
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
                    `/clusters/${row.cluster_id}/workloads/deployments`,
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

  // Subset of MODEL_FAMILIES that show up in actual data. Used for
  // the family filter Tag row above the table — empty state hides
  // the tag row entirely.
  const familyFilterTags = useMemo(() => {
    const seen = new Set<ModelFamily>();
    for (const r of rows) {
      if (r.model_family) seen.add(r.model_family as ModelFamily);
    }
    return MODEL_FAMILIES.filter((f) => seen.has(f));
  }, [rows]);
  const [activeFamily, setActiveFamily] = useState<ModelFamily | null>(null);

  const displayedRows = useMemo(
    () =>
      activeFamily ? rows.filter((r) => r.model_family === activeFamily) : rows,
    [rows, activeFamily],
  );

  return (
    <PageContainer
      breadcrumbRender={false}
      header={{
        title: intl.formatMessage({ id: 'pages.models.deployments.title' }),
        subTitle: intl.formatMessage({
          id: 'pages.models.deployments.subtitle',
        }),
        breadcrumb: undefined,
      }}
    >
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

      <ProTable<ModelInstance>
        rowKey={(r) => `${r.cluster_id}/${r.namespace}/${r.name}`}
        columns={columns}
        dataSource={displayedRows}
        loading={loading}
        search={false}
        options={false}
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        toolBarRender={() => [
          // Family quick-filter chips — single-select. Click to
          // narrow to one family; click again or "全部" to clear.
          familyFilterTags.length > 0 && (
            <Space key="family-filter" wrap size={4}>
              <Tag.CheckableTag
                checked={activeFamily === null}
                onChange={() => setActiveFamily(null)}
              >
                {intl.formatMessage({
                  id: 'pages.models.deployments.familyAll',
                })}
              </Tag.CheckableTag>
              {familyFilterTags.map((f) => {
                const meta =
                  f === 'custom'
                    ? null
                    : FAMILY_META[f as Exclude<ModelFamily, 'custom'>];
                return (
                  <Tag.CheckableTag
                    key={f}
                    checked={activeFamily === f}
                    onChange={(checked) => setActiveFamily(checked ? f : null)}
                  >
                    {meta?.label ?? f}
                  </Tag.CheckableTag>
                );
              })}
            </Space>
          ),
          <Button
            key="refresh"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={fetch}
          >
            {intl.formatMessage({ id: 'pages.common.refresh' })}
          </Button>,
        ]}
      />
    </PageContainer>
  );
};

export default ModelDeploymentsPage;
