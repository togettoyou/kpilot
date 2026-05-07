import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { Descriptions, Empty, Space, Spin, Tag, Typography } from 'antd';
import React, { useMemo } from 'react';

import { getNode, listNodes } from '@/services/kpilot/node';

const { Text } = Typography;

interface NodeRow {
  name: string;
  cells: any[];
}

// renderCell maps a kubectl column to a tag/text representation.
// kubectl's printer joins multi-state STATUS with commas (e.g.
// "Ready,SchedulingDisabled" for cordoned nodes), and ROLES with
// commas too — split + tag each so the row reads at a glance.
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
          <Tag key={r} color={r === 'control-plane' || r === 'master' ? 'blue' : 'default'}>
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

  const { data, loading } = useRequest(() => listNodes(clusterId!), {
    pollingInterval: 15_000,
    formatResult: (res) => res,
    pollingWhenHidden: false,
  });

  const cols = data?.columnDefinitions ?? [];
  const rows: NodeRow[] = useMemo(
    () =>
      (data?.rows ?? []).map((r) => ({
        name: r.cells?.[0] ? String(r.cells[0]) : '',
        cells: r.cells ?? [],
      })),
    [data?.rows],
  );

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
        expandable={{
          expandedRowRender: (record) => (
            <NodeDetail clusterId={clusterId!} name={record.name} />
          ),
        }}
        columns={cols.map((c, idx) => ({
          title: c.name,
          key: `col-${idx}`,
          width: idx === 0 ? 220 : undefined,
          render: (_, r) => renderCell(c.name, r.cells[idx]),
        }))}
      />
    </div>
  );
}

// NodeDetail lazy-fetches the full Node JSON for the expand row, so
// the list call stays cheap (cells only) and we only pay for the
// detail when a user actually opens a row. Pod CIDR + taints +
// labels + annotations live in spec/metadata, not in Table cells.
const NodeDetail: React.FC<{ clusterId: string; name: string }> = ({
  clusterId,
  name,
}) => {
  const intl = useIntl();
  const { data, loading } = useRequest(() => getNode(clusterId, name), {
    formatResult: (res) => res,
  });
  if (loading) return <div className="p-4"><Spin /></div>;
  if (!data) return <div className="p-4"><Empty /></div>;

  const labels: Record<string, string> = data?.metadata?.labels ?? {};
  const annotations: Record<string, string> = data?.metadata?.annotations ?? {};
  const taints: { key: string; value?: string; effect: string }[] =
    data?.spec?.taints ?? [];
  const podCIDR: string = data?.spec?.podCIDR ?? '';
  const unschedulable: boolean = data?.spec?.unschedulable ?? false;

  return (
    <div className="p-4 flex flex-col gap-4">
      <Descriptions
        size="small"
        column={3}
        bordered
        items={[
          {
            key: 'podCIDR',
            label: intl.formatMessage({ id: 'pages.nodes.detail.podCIDR' }),
            children: podCIDR || '—',
          },
          {
            key: 'unschedulable',
            label: intl.formatMessage({ id: 'pages.nodes.detail.unschedulable' }),
            children: unschedulable ? <Tag color="warning">true</Tag> : 'false',
          },
          {
            key: 'taints',
            label: intl.formatMessage({ id: 'pages.nodes.detail.taints' }),
            children: taints.length === 0 ? (
              '—'
            ) : (
              <Space size={4} wrap>
                {taints.map((t, i) => (
                  <Tag key={`${t.key}-${i}`}>
                    {t.key}{t.value ? `=${t.value}` : ''}:{t.effect}
                  </Tag>
                ))}
              </Space>
            ),
          },
        ]}
      />
      <div className="grid grid-cols-2 gap-4">
        <Descriptions
          title="Labels"
          size="small"
          column={1}
          bordered
          items={Object.entries(labels).map(([k, v]) => ({
            key: k,
            label: k,
            children: v,
          }))}
        />
        <Descriptions
          title="Annotations"
          size="small"
          column={1}
          bordered
          items={Object.entries(annotations).map(([k, v]) => ({
            key: k,
            label: k,
            children: v,
          }))}
        />
      </div>
    </div>
  );
};
