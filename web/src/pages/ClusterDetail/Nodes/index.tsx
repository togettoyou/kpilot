import { ExclamationCircleOutlined } from '@ant-design/icons';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { App, Button, Modal, Space, Tag, Typography } from 'antd';
import React, { useMemo, useState } from 'react';

import { cordonNode, listNodes } from '@/services/kpilot/node';

import NodeDetailDrawer from './NodeDetailDrawer';
import NodeYamlDrawer from './NodeYamlDrawer';

const { Text } = Typography;

interface NodeRow {
  name: string;
  cells: any[];
}

// Map kubectl Table column names → our i18n keys. K8s Table API
// returns hardcoded English headers; we translate them here so zh-CN
// users see Chinese. Same pattern as Workloads/index.tsx::COL_I18N.
const COL_I18N: Record<string, string> = {
  Name: 'pages.nodes.col.name',
  Status: 'pages.nodes.col.status',
  Roles: 'pages.nodes.col.roles',
  Age: 'pages.nodes.col.age',
  Version: 'pages.nodes.col.version',
  'Internal-IP': 'pages.nodes.col.internalIp',
  'External-IP': 'pages.nodes.col.externalIp',
  'OS-Image': 'pages.nodes.col.osImage',
  'Kernel-Version': 'pages.nodes.col.kernelVersion',
  'Container-Runtime': 'pages.nodes.col.containerRuntime',
};

// renderCell maps a kubectl column to a tag/text representation.
// kubectl's printer joins multi-state STATUS / ROLES with commas.
function renderCell(name: string, value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === '' || value === '<none>') {
    return <Text type="secondary">—</Text>;
  }
  if (name === 'Status') return <StatusCell status={String(value)} />;
  if (name === 'Roles') {
    const parts = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    return (
      <Space size={4} wrap>
        {parts.map((r) => (
          <Tag
            key={r}
            color={r === 'control-plane' || r === 'master' ? 'blue' : 'default'}
          >
            {r}
          </Tag>
        ))}
      </Space>
    );
  }
  return String(value);
}

const StatusCell: React.FC<{ status: string }> = ({ status }) => {
  const parts = status.split(',').map((p) => p.trim()).filter(Boolean);
  return (
    <Space size={4} wrap>
      {parts.map((p) => {
        const color =
          p === 'Ready' ? 'success' :
          p === 'NotReady' ? 'error' :
          p === 'SchedulingDisabled' ? 'warning' : 'default';
        return <Tag key={p} color={color}>{p}</Tag>;
      })}
    </Space>
  );
};

export default function NodesPage() {
  const { id: clusterId } = useParams<{ id: string }>();
  const intl = useIntl();
  const { message, modal } = App.useApp();

  const { data, loading, refresh } = useRequest(() => listNodes(clusterId!), {
    pollingInterval: 15_000,
    formatResult: (res) => res,
    pollingWhenHidden: false,
  });

  const cols = data?.columnDefinitions ?? [];
  const statusColIdx = cols.findIndex((c) => c.name === 'Status');
  const rows: NodeRow[] = useMemo(
    () =>
      (data?.rows ?? []).map((r) => ({
        name: r.cells?.[0] ? String(r.cells[0]) : '',
        cells: r.cells ?? [],
      })),
    [data?.rows],
  );

  // active === { name, mode: 'detail' | 'yaml' } → which drawer is open.
  // Single state instead of two booleans so opening one auto-closes the
  // other and we don't end up with both drawers stacked at the same time.
  const [active, setActive] = useState<{ name: string; mode: 'detail' | 'yaml' } | null>(null);

  // handleCordon prompts confirm + flips spec.unschedulable. The current
  // schedulable state is derived from the Status cell ("SchedulingDisabled"
  // suffix kubectl appends when a node is cordoned) — saves a Get just to
  // pick the right verb.
  const handleCordon = (name: string, cordoned: boolean) => {
    const next = !cordoned;
    modal.confirm({
      title: intl.formatMessage({
        id: next ? 'pages.nodes.cordon.confirmTitle' : 'pages.nodes.uncordon.confirmTitle',
      }),
      content: intl.formatMessage(
        {
          id: next ? 'pages.nodes.cordon.confirmBody' : 'pages.nodes.uncordon.confirmBody',
        },
        { name },
      ),
      icon: <ExclamationCircleOutlined />,
      okText: intl.formatMessage({
        id: next ? 'pages.nodes.cordon.ok' : 'pages.nodes.uncordon.ok',
      }),
      okButtonProps: next ? { danger: true } : undefined,
      cancelText: intl.formatMessage({ id: 'pages.nodes.cordon.cancel' }),
      onOk: async () => {
        try {
          await cordonNode(clusterId!, name, next);
          message.success(
            intl.formatMessage({
              id: next ? 'pages.nodes.cordon.success' : 'pages.nodes.uncordon.success',
            }),
          );
          refresh();
        } catch (e: any) {
          message.error(String(e?.message ?? e));
        }
      },
    });
  };

  return (
    <div className="p-6">
      <ProTable<NodeRow>
        headerTitle={
          <Space>
            <Text strong>
              {intl.formatMessage({ id: 'pages.nodes.title' })}
            </Text>
            <Text type="secondary">({rows.length})</Text>
          </Space>
        }
        rowKey="name"
        loading={loading}
        dataSource={rows}
        scroll={{ x: 'max-content' }}
        search={false}
        pagination={false}
        options={{ reload: false }}
        columns={[
          ...cols.map((c, idx) => ({
            title: COL_I18N[c.name]
              ? intl.formatMessage({ id: COL_I18N[c.name] })
              : c.name,
            key: `col-${idx}`,
            width: idx === 0 ? 220 : undefined,
            render: (_: any, r: NodeRow) => renderCell(c.name, r.cells[idx]),
          })),
          {
            title: intl.formatMessage({ id: 'pages.nodes.col.action' }),
            key: 'action',
            width: 220,
            fixed: 'right',
            render: (_, r) => {
              const status =
                statusColIdx >= 0 ? String(r.cells[statusColIdx] ?? '') : '';
              const cordoned = status.includes('SchedulingDisabled');
              return (
                <Space size={4}>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => setActive({ name: r.name, mode: 'detail' })}
                  >
                    {intl.formatMessage({ id: 'pages.nodes.action.detail' })}
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => setActive({ name: r.name, mode: 'yaml' })}
                  >
                    {intl.formatMessage({ id: 'pages.nodes.action.view' })}
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    danger={!cordoned}
                    onClick={() => handleCordon(r.name, cordoned)}
                  >
                    {intl.formatMessage({
                      id: cordoned
                        ? 'pages.nodes.action.uncordon'
                        : 'pages.nodes.action.cordon',
                    })}
                  </Button>
                </Space>
              );
            },
          },
        ]}
      />
      <NodeDetailDrawer
        clusterId={clusterId!}
        name={active?.mode === 'detail' ? active.name : null}
        open={active?.mode === 'detail'}
        onClose={() => setActive(null)}
      />
      <NodeYamlDrawer
        clusterId={clusterId!}
        name={active?.mode === 'yaml' ? active.name : null}
        open={active?.mode === 'yaml'}
        onClose={() => setActive(null)}
      />
    </div>
  );
}
