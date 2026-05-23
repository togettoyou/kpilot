import {
  DownOutlined,
  ExclamationCircleOutlined,
  LeftOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import {
  App,
  Button,
  Dropdown,
  Input,
  Space,
  Tag,
  Typography,
} from 'antd';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { useBurstRefresh } from '@/hooks/useBurstRefresh';
import { cordonNode, listNodes } from '@/services/kpilot/node';

import { DescribeDrawer } from '../Workloads/DescribeDrawer';
import NodeDetailDrawer from './NodeDetailDrawer';
import NodeYamlDrawer from './NodeYamlDrawer';

const { Text } = Typography;

// Match Workloads' chunk size — Node count is bounded enough that
// the user almost always lands on a single page, but pagination
// kicks in cleanly on huge clusters without a separate code path.
const PAGE_SIZE = 100;

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

  const [pollingInterval, setPollingInterval] = useState(0);
  const [search, setSearch] = useState('');

  // Server-side cursor pagination — same shape as the Workloads page
  // (see comments there). pageTokens[i] = continue token for page i;
  // pageTokens[0] is always '' (first page).
  const [pageTokens, setPageTokens] = useState<string[]>(['']);
  const [pageIdx, setPageIdx] = useState(0);
  const currentToken = pageTokens[pageIdx] ?? '';

  const { data, loading, refresh } = useRequest(
    () => listNodes(clusterId!, PAGE_SIZE, currentToken),
    {
      refreshDeps: [currentToken],
      formatResult: (res) => res,
      pollingWhenHidden: false,
    },
  );
  // Cordon/uncordon is a Node patch — the status field flips after
  // the kubelet's next status-update tick (typically <2s). Burst
  // refresh catches the converged Ready/SchedulingDisabled state.
  const { burst } = useBurstRefresh(refresh);

  const cols = data?.columnDefinitions ?? [];
  const statusColIdx = cols.findIndex((c) => c.name === 'Status');
  const nameColIdx = cols.findIndex((c) => c.name === 'Name');
  const rolesColIdx = cols.findIndex((c) => c.name === 'Roles');

  const rows: NodeRow[] = useMemo(
    () =>
      (data?.rows ?? []).map((r) => ({
        name: r.cells?.[0] ? String(r.cells[0]) : '',
        cells: r.cells ?? [],
      })),
    [data?.rows],
  );

  // Client-side substring filter on what's already loaded — covers
  // name + roles + every other cell. Same as kubectl/Lens; the
  // K8s API has no substring search (fieldSelector on metadata.name
  // is exact-equality only).
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      for (const cell of r.cells) {
        if (cell != null && String(cell).toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [rows, search]);
  const isFiltering = search.trim().length > 0;

  const nextToken = data?.metadata?.continue ?? '';
  const hasMore = !!nextToken;
  const remaining = data?.metadata?.remainingItemCount;
  const totalKnown =
    remaining != null ? pageIdx * PAGE_SIZE + rows.length + remaining : undefined;

  // Save the next page's token once we receive it so the user can
  // page forward + back without refetching.
  useEffect(() => {
    if (!nextToken) return;
    setPageTokens((prev) => {
      if (prev[pageIdx + 1]) return prev;
      const next = [...prev];
      next[pageIdx + 1] = nextToken;
      return next;
    });
  }, [nextToken, pageIdx]);

  // Manual setInterval (not useRequest's pollingInterval) because the
  // user-selected interval is dynamic state — useRequest captures the
  // initial value and ignores subsequent changes. Same pattern as
  // Workloads/index.tsx; documented in CLAUDE.md.
  //
  // refresh is recreated on every render of the page (useRequest gives
  // a fresh function reference each time), so depending on it directly
  // would tear down + recreate the timer on every render — the timer
  // never reaches the interval and "every 5s" effectively becomes
  // "5s after the last render". Mirror it through a ref instead so the
  // effect only restarts when the interval itself changes.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (pollingInterval <= 0) return;
    const timer = setInterval(() => refreshRef.current(), pollingInterval);
    return () => clearInterval(timer);
  }, [pollingInterval]);

  // Three drawers, one at a time. `describe` is the kubectl describe
  // text dump (consistent with the Workloads page's 详情 button);
  // `overview` is the structured field/card view (Node-only, lives in
  // NodeDetailDrawer); `yaml` is the read-only YAML viewer.
  type Mode = 'describe' | 'overview' | 'yaml';
  const [active, setActive] = useState<{ name: string; mode: Mode } | null>(null);

  // Per-row cordon-in-flight tracker. Modal.confirm fires the request,
  // but the table button has no idea — without this, double-clicking
  // submits twice. Keyed by node name; the button in the action column
  // checks its name and shows a spinner while pending.
  const [cordonBusy, setCordonBusy] = useState<Set<string>>(new Set());

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
        setCordonBusy((prev) => {
          const n = new Set(prev);
          n.add(name);
          return n;
        });
        try {
          await cordonNode(clusterId!, name, next);
          message.success(
            intl.formatMessage({
              id: next ? 'pages.nodes.cordon.success' : 'pages.nodes.uncordon.success',
            }),
          );
          burst();
        } catch (e: any) {
          message.error(String(e?.message ?? e));
        } finally {
          setCordonBusy((prev) => {
            const n = new Set(prev);
            n.delete(name);
            return n;
          });
        }
      },
    });
  };

  // void-mark unused col indexes so eslint doesn't warn (kept around
  // for future use — name/roles filtering split etc.).
  void nameColIdx;
  void rolesColIdx;

  return (
    <div className="p-6">
      <ProTable<NodeRow>
        headerTitle={
          <Space>
            <Text strong>
              {intl.formatMessage({ id: 'pages.nodes.title' })}
            </Text>
            <Text type="secondary">
              {isFiltering
                ? `(${filteredRows.length} / ${rows.length})`
                : totalKnown != null
                  ? `(${totalKnown})`
                  : `(${rows.length}${hasMore ? '+' : ''})`}
            </Text>
          </Space>
        }
        toolBarRender={() => [
          <Input
            key="search"
            placeholder={intl.formatMessage({ id: 'pages.nodes.searchPlaceholder' })}
            prefix={<SearchOutlined />}
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 240 }}
          />,
          <Space.Compact key="refresh">
            <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh} />
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: '0',
                    label: intl.formatMessage({ id: 'pages.workloads.refresh.off' }),
                  },
                  { type: 'divider' },
                  { key: '5000', label: '5s' },
                  { key: '10000', label: '10s' },
                  { key: '30000', label: '30s' },
                  { key: '60000', label: '60s' },
                ],
                selectedKeys: [String(pollingInterval)],
                onClick: ({ key }) => setPollingInterval(Number(key)),
              }}
            >
              <Button style={{ minWidth: 46 }}>
                {pollingInterval > 0 ? `${pollingInterval / 1000}s` : <DownOutlined />}
              </Button>
            </Dropdown>
          </Space.Compact>,
        ]}
        rowKey="name"
        loading={loading}
        dataSource={filteredRows}
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
            width: 280,
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
                    onClick={() => setActive({ name: r.name, mode: 'describe' })}
                  >
                    {intl.formatMessage({ id: 'pages.nodes.action.describe' })}
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => setActive({ name: r.name, mode: 'overview' })}
                  >
                    {intl.formatMessage({ id: 'pages.nodes.action.overview' })}
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
                    loading={cordonBusy.has(r.name)}
                    disabled={cordonBusy.has(r.name)}
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
      {(pageIdx > 0 || hasMore) && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 8,
            padding: '12px 0',
          }}
        >
          <Button
            size="small"
            icon={<LeftOutlined />}
            disabled={pageIdx === 0}
            onClick={() => setPageIdx((p) => p - 1)}
          />
          <Text type="secondary">
            {intl.formatMessage({ id: 'pages.workloads.page' }, { n: pageIdx + 1 })}
          </Text>
          <Button
            size="small"
            icon={<RightOutlined />}
            disabled={!hasMore}
            onClick={() => setPageIdx((p) => p + 1)}
          />
        </div>
      )}
      <DescribeDrawer
        clusterId={clusterId!}
        resourceType="nodes"
        name={active?.mode === 'describe' ? active.name : ''}
        namespace=""
        open={active?.mode === 'describe'}
        onClose={() => setActive(null)}
      />
      <NodeDetailDrawer
        clusterId={clusterId!}
        name={active?.mode === 'overview' ? active.name : null}
        open={active?.mode === 'overview'}
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
