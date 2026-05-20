import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { useIntl, useRequest } from '@umijs/max';
import { Alert, App, Button, Space, Tag, Tooltip, Typography } from 'antd';
import React, { useState } from 'react';

import type { Model } from '@/services/kpilot/model';
import {
  deleteModel,
  FAMILY_LABELS,
  listModels,
  RUNTIME_LABELS,
} from '@/services/kpilot/model';

import ModelDrawer from './ModelDrawer';

const { Text, Paragraph } = Typography;

// Catalog of deployable model presets (P15). Built-ins are seeded by
// the server (mutation-locked); admins can add custom rows. Actual
// deployment lands in P16+ — for now the drawer just edits metadata.
const ModelHubPage: React.FC = () => {
  const intl = useIntl();
  const { message, modal } = App.useApp();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);

  const { data, loading, refresh } = useRequest(listModels, {
    formatResult: (res) => res,
  });

  const rows = data ?? [];

  // Parse the JSON-encoded recommended_gpu field once per cell. Bad
  // JSON falls back to a hyphen rather than crashing the table —
  // built-in rows are validated server-side but a custom row could
  // be edited via raw API and slip through.
  const renderGPU = (raw: string) => {
    if (!raw) return <Text type="secondary">—</Text>;
    try {
      const g = JSON.parse(raw) as {
        count?: number;
        memoryGiB?: number;
        model?: string;
      };
      const parts: string[] = [];
      if (g.count) parts.push(`${g.count}×`);
      if (g.memoryGiB) parts.push(`${g.memoryGiB} GiB`);
      const head = parts.join(' ');
      const tail = g.model && g.model !== 'any' ? ` (${g.model})` : '';
      return <Text>{head + tail}</Text>;
    } catch {
      return <Text type="secondary">—</Text>;
    }
  };

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      message.success(intl.formatMessage({ id: 'pages.common.copied' }));
    } catch {
      message.error(intl.formatMessage({ id: 'pages.common.copyFailed' }));
    }
  };

  const handleDelete = (row: Model) => {
    modal.confirm({
      title: intl.formatMessage(
        { id: 'pages.models.registry.delete.confirm' },
        { name: row.display_name },
      ),
      okType: 'danger',
      onOk: async () => {
        await deleteModel(row.id);
        message.success(
          intl.formatMessage({ id: 'pages.models.registry.delete.success' }),
        );
        refresh();
      },
    });
  };

  const columns: ProColumns<Model>[] = [
    {
      title: intl.formatMessage({ id: 'pages.models.registry.col.name' }),
      dataIndex: 'display_name',
      fixed: 'left',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Text strong>{row.display_name}</Text>
            {row.is_builtin && (
              <Tag color="blue">
                {intl.formatMessage({ id: 'pages.models.registry.builtin' })}
              </Tag>
            )}
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {row.name}
          </Text>
        </Space>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.registry.col.family' }),
      dataIndex: 'family',
      width: 110,
      filters: true,
      onFilter: true,
      valueType: 'select',
      valueEnum: {
        ...Object.fromEntries(
          Object.entries(FAMILY_LABELS).map(([k, v]) => [k, { text: v }]),
        ),
        custom: {
          text: intl.formatMessage({ id: 'pages.models.registry.custom' }),
        },
      },
    },
    {
      title: intl.formatMessage({ id: 'pages.models.registry.col.runtime' }),
      dataIndex: 'runtime',
      width: 100,
      filters: true,
      onFilter: true,
      valueType: 'select',
      valueEnum: Object.fromEntries(
        Object.entries(RUNTIME_LABELS).map(([k, v]) => [k, { text: v }]),
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.registry.col.image' }),
      dataIndex: 'image',
      ellipsis: true,
      render: (_, row) => (
        <Space size={4}>
          <Text code copyable={false} style={{ fontSize: 12 }}>
            {row.image}
          </Text>
          <Tooltip title={intl.formatMessage({ id: 'pages.common.copy' })}>
            <Button
              size="small"
              type="text"
              icon={<CopyOutlined />}
              onClick={() => copyToClipboard(row.image)}
            />
          </Tooltip>
        </Space>
      ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.registry.col.hf' }),
      dataIndex: 'hugging_face_id',
      ellipsis: true,
      render: (_, row) =>
        row.hugging_face_id ? (
          <Text code style={{ fontSize: 12 }}>
            {row.hugging_face_id}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.registry.col.gpu' }),
      dataIndex: 'recommended_gpu',
      width: 160,
      render: (_, row) => renderGPU(row.recommended_gpu),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.registry.col.license' }),
      dataIndex: 'license',
      width: 110,
      render: (_, row) =>
        row.license ? (
          <Tag>{row.license}</Tag>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.registry.col.actions' }),
      width: 160,
      fixed: 'right',
      render: (_, row) => {
        const lockedTip = intl.formatMessage({
          id: 'pages.models.registry.builtinHint',
        });
        return (
          <Space size={4}>
            <Tooltip title={row.is_builtin ? lockedTip : ''}>
              <Button
                size="small"
                type="link"
                icon={<EditOutlined />}
                disabled={row.is_builtin}
                onClick={() => {
                  setEditing(row);
                  setDrawerOpen(true);
                }}
              >
                {intl.formatMessage({ id: 'pages.common.edit' })}
              </Button>
            </Tooltip>
            <Tooltip title={row.is_builtin ? lockedTip : ''}>
              <Button
                size="small"
                type="link"
                danger
                icon={<DeleteOutlined />}
                disabled={row.is_builtin}
                onClick={() => handleDelete(row)}
              >
                {intl.formatMessage({ id: 'pages.common.delete' })}
              </Button>
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  return (
    <PageContainer
      header={{
        title: intl.formatMessage({ id: 'pages.models.registry.title' }),
        subTitle: intl.formatMessage({ id: 'pages.models.registry.subtitle' }),
      }}
    >
      <ProTable<Model>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        search={false}
        scroll={{ x: 'max-content' }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        options={{ reload: () => refresh() }}
        toolBarRender={() => [
          <Button
            key="new"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditing(null);
              setDrawerOpen(true);
            }}
          >
            {intl.formatMessage({ id: 'pages.models.registry.new' })}
          </Button>,
        ]}
        locale={{
          emptyText: (
            <div style={{ padding: 24 }}>
              <Text strong>
                {intl.formatMessage({
                  id: 'pages.models.registry.empty.title',
                })}
              </Text>
              <Paragraph type="secondary" style={{ marginTop: 8 }}>
                {intl.formatMessage({
                  id: 'pages.models.registry.empty.subtitle',
                })}
              </Paragraph>
            </div>
          ),
        }}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginTop: 16 }}
        message={intl.formatMessage({
          id: 'pages.models.registry.roadmap.title',
        })}
        description={intl.formatMessage({
          id: 'pages.models.registry.roadmap.desc',
        })}
      />

      <ModelDrawer
        open={drawerOpen}
        model={editing}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => {
          setDrawerOpen(false);
          refresh();
        }}
      />
    </PageContainer>
  );
};

export default ModelHubPage;
