import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { App, Button, Drawer, Dropdown, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { DownOutlined, LeftOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import * as jsyaml from 'js-yaml';
import React, { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ClusterLayout } from '../ClusterLayout';
import { YamlEditor } from './YamlEditor';
import type { WorkloadItem, WorkloadResourceType } from '@/services/kpilot/workload';
import { applyWorkload, deleteWorkload, getWorkload, listNamespaces, listWorkloads } from '@/services/kpilot/workload';

const { Text } = Typography;

// ─── Table API helpers ────────────────────────────────────────────────────────

// Maps K8s Table API column names → our i18n keys.
const COL_I18N: Record<string, string> = {
  Name: 'pages.workloads.col.name',
  Namespace: 'pages.workloads.col.namespace',
  Age: 'pages.workloads.col.age',
  Status: 'pages.workloads.col.status',
  Ready: 'pages.workloads.col.ready',
  Restarts: 'pages.workloads.col.restarts',
  Node: 'pages.workloads.col.node',
  Type: 'pages.workloads.col.type',
  'Port(s)': 'pages.workloads.col.ports',
  Ports: 'pages.workloads.col.ports',
  Hosts: 'pages.workloads.col.hosts',
  Address: 'pages.workloads.col.address',
  Data: 'pages.workloads.col.data',
  'Up-to-date': 'pages.workloads.col.upToDate',
  Available: 'pages.workloads.col.available',
  Containers: 'pages.workloads.col.containers',
  Images: 'pages.workloads.col.images',
  Selector: 'pages.workloads.col.selector',
  Desired: 'pages.workloads.col.desired',
  Current: 'pages.workloads.col.current',
  IP: 'pages.workloads.col.ip',
  'Node Selector': 'pages.workloads.col.nodeSelector',
  'Nominated Node': 'pages.workloads.col.nominatedNode',
  'Readiness Gates': 'pages.workloads.col.readinessGates',
  Class: 'pages.workloads.col.class',
  'Cluster-IP': 'pages.workloads.col.clusterIp',
  'External-IP': 'pages.workloads.col.externalIp',
};

const COL_WIDTHS: Record<string, number> = {
  Name: 200, Namespace: 130, Age: 80, Status: 150, Ready: 90,
  Restarts: 90, Node: 150, Type: 110, 'Cluster-IP': 130,
  'External-IP': 130, 'Port(s)': 170, Hosts: 200, Address: 150,
  Data: 70, 'Up-to-date': 100, Available: 90, Desired: 80, Current: 80,
};

const SVC_TYPE_COLOR: Record<string, string> = {
  ClusterIP: 'default', NodePort: 'blue', LoadBalancer: 'green',
};

function podStatusColor(s: string): string {
  if (s === 'Running' || s === 'Completed') return 'success';
  if (s === 'Pending' || s.startsWith('Init:')) return 'warning';
  if (['Failed', 'Error', 'OOMKilled', 'CrashLoopBackOff',
       'ErrImagePull', 'ImagePullBackOff', 'CreateContainerError',
       'InvalidImageName'].includes(s)) return 'error';
  return 'default';
}

function renderCell(colName: string, value: string): React.ReactNode {
  const v = value ?? '';
  if (!v || v === '<none>' || v === '<unknown>') {
    return <Text type="secondary">{v || '—'}</Text>;
  }
  switch (colName) {
    case 'Status':
      return <Tag color={podStatusColor(v)}>{v}</Tag>;
    case 'Ready': {
      if (!v.includes('/')) return <>{v}</>;
      const [cur, total] = v.split('/').map(Number);
      if (cur === total) return <Text type="success">{v}</Text>;
      if (cur === 0) return <Text type="danger">{v}</Text>;
      return <Text type="warning">{v}</Text>;
    }
    case 'Restarts': {
      const n = parseInt(v, 10);
      if (isNaN(n) || n === 0) return <>{v}</>;
      return <Text type={n >= 5 ? 'danger' : 'warning'}>{v}</Text>;
    }
    case 'Type':
      return <Tag color={SVC_TYPE_COLOR[v] ?? 'default'}>{v}</Tag>;
    default:
      return <>{v}</>;
  }
}

// Parse a K8s Table API response into WorkloadItems + column definitions.
// Only priority=0 columns are kept (same as kubectl default, no "-o wide").
// Name and Namespace are always sourced from object.metadata instead.
function parseTableResponse(res: any): { items: WorkloadItem[]; colDefs: any[] } {
  if (res?.kind !== 'Table') return { items: [], colDefs: [] };

  const allColDefs: any[] = res.columnDefinitions ?? [];
  const allNames = allColDefs.map((c: any) => c.name as string);

  // Skip Name/Namespace — always sourced from object.metadata instead.
  // Keep all columns including priority>0 (wide columns like IP, Node, Images).
  const colDefs = allColDefs.filter(
    (c: any) => c.name !== 'Name' && c.name !== 'Namespace',
  );

  const items: WorkloadItem[] = (res.rows ?? []).map((row: any) => {
    const cells: any[] = row.cells ?? [];
    const meta = row.object?.metadata ?? {};
    const item: WorkloadItem = {
      name: meta.name ?? cells[allNames.indexOf('Name')] ?? '',
      namespace: meta.namespace ?? '',
      age: '',
    };
    for (const col of colDefs) {
      const idx = allNames.indexOf(col.name);
      item[col.name] = idx >= 0 ? (cells[idx] ?? '') : '';
    }
    return item;
  });

  return { items, colDefs };
}

// ─── Dynamic column builder ───────────────────────────────────────────────────

function buildColumns(
  colDefs: any[],
  intl: ReturnType<typeof useIntl>,
): ProColumns<WorkloadItem>[] {
  const fixed: ProColumns<WorkloadItem>[] = [
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.name' }),
      dataIndex: 'name',
      width: 200,
    },
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.namespace' }),
      dataIndex: 'namespace',
      width: 130,
    },
  ];

  const dynamic: ProColumns<WorkloadItem>[] = colDefs.map((col: any) => ({
    title: COL_I18N[col.name]
      ? intl.formatMessage({ id: COL_I18N[col.name] })
      : col.name,
    dataIndex: col.name,
    width: COL_WIDTHS[col.name] ?? 120,
    render: (_, record) => renderCell(col.name, record[col.name]),
  }));

  return [...fixed, ...dynamic];
}

// ─── YAML editor helpers ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEditableYaml(raw: any): string {
  const obj = { ...raw };
  if (obj.metadata) {
    const { managedFields: _, ...rest } = obj.metadata;
    obj.metadata = rest;
  }
  return jsyaml.dump(obj, { lineWidth: -1 });
}

// ─── Types ────────────────────────────────────────────────────────────────────

const VALID_TYPES = new Set<string>([
  'deployments', 'statefulsets', 'daemonsets', 'pods',
  'services', 'ingresses', 'configmaps', 'secrets',
]);

interface WorkloadsContentProps {
  clusterId: string;
  resourceType: WorkloadResourceType;
  namespaces: string[];
  nsLoading: boolean;
}

// ─── Inner component — remounts on resourceType change via key prop ────────

const PAGE_SIZE = 100;

function WorkloadsContent({ clusterId, resourceType, namespaces, nsLoading }: WorkloadsContentProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const [namespace, setNamespace] = useState('');
  const [pollingInterval, setPollingInterval] = useState(0);

  // Server-side cursor pagination.
  const [pageTokens, setPageTokens] = useState<string[]>(['']);
  const [pageIdx, setPageIdx] = useState(0);
  const currentToken = pageTokens[pageIdx] ?? '';

  useEffect(() => {
    setPageIdx(0);
    setPageTokens(['']);
  }, [namespace]);

  // YAML drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<WorkloadItem | null>(null);
  const [yamlText, setYamlText] = useState('');
  const [applying, setApplying] = useState(false);
  const [readOnly, setReadOnly] = useState(false);

  const { data: pageData, loading, refresh } = useRequest(
    () => listWorkloads(clusterId, resourceType, namespace, PAGE_SIZE, currentToken),
    {
      refreshDeps: [namespace, currentToken],
      formatResult: (res: any) => {
        const { items, colDefs } = parseTableResponse(res);
        return {
          items,
          colDefs,
          nextToken: (res?.metadata?.continue as string) ?? '',
          remaining: res?.metadata?.remainingItemCount as number | undefined,
        };
      },
      pollingWhenHidden: false,
    },
  );

  const items = pageData?.items ?? [];
  const colDefs = pageData?.colDefs ?? [];
  const nextToken = pageData?.nextToken ?? '';
  const hasMore = !!nextToken;
  const totalKnown =
    pageData?.remaining != null
      ? pageIdx * PAGE_SIZE + items.length + pageData.remaining
      : undefined;

  useEffect(() => {
    if (!nextToken) return;
    setPageTokens((prev) => {
      if (prev[pageIdx + 1]) return prev;
      const next = [...prev];
      next[pageIdx + 1] = nextToken;
      return next;
    });
  }, [nextToken, pageIdx]);

  useEffect(() => {
    if (pollingInterval <= 0) return;
    const timer = setInterval(refresh, pollingInterval);
    return () => clearInterval(timer);
  }, [pollingInterval, refresh]);

  const openEditor = async (item: WorkloadItem, ro = false) => {
    setEditingItem(item);
    setReadOnly(ro);
    setYamlText('');
    setDrawerOpen(true);
    try {
      const raw = await getWorkload(clusterId, resourceType, item.name, item.namespace ?? '');
      setYamlText(toEditableYaml(raw));
    } catch {
      message.error('Failed to load resource');
      setDrawerOpen(false);
    }
  };

  const handleApply = async () => {
    if (!editingItem) return;
    setApplying(true);
    try {
      const obj = jsyaml.load(yamlText) as object;
      await applyWorkload(clusterId, resourceType, editingItem.name, editingItem.namespace ?? '', obj);
      message.success(intl.formatMessage({ id: 'pages.workloads.apply.success' }));
      setDrawerOpen(false);
      refresh();
    } catch {
      // global error handler in requestErrorConfig already shows the toast
    } finally {
      setApplying(false);
    }
  };

  const handleDelete = async (item: WorkloadItem) => {
    try {
      await deleteWorkload(clusterId, resourceType, item.name, item.namespace ?? '');
      message.success(intl.formatMessage({ id: 'pages.workloads.delete.success' }));
      refresh();
    } catch {
      // global error handler in requestErrorConfig already shows the toast
    }
  };

  const actionsColumn: ProColumns<WorkloadItem> = {
    title: intl.formatMessage({ id: 'pages.workloads.col.actions' }),
    valueType: 'option',
    width: 120,
    render: (_, record) => {
      const isProtected = (record.namespace ?? '').startsWith('kube-');
      if (isProtected) {
        return [
          <Button key="view" type="link" size="small" onClick={() => openEditor(record, true)}>
            {intl.formatMessage({ id: 'pages.workloads.view' })}
          </Button>,
        ];
      }
      return [
        <Button key="edit" type="link" size="small" onClick={() => openEditor(record)}>
          {intl.formatMessage({ id: 'pages.workloads.edit' })}
        </Button>,
        <Popconfirm
          key="delete"
          title={intl.formatMessage({ id: 'pages.workloads.delete.confirm' }, { name: record.name })}
          onConfirm={() => handleDelete(record)}
          okType="danger"
        >
          <Button type="link" size="small" danger>
            {intl.formatMessage({ id: 'pages.workloads.delete' })}
          </Button>
        </Popconfirm>,
      ];
    },
  };

  const columns = useMemo(
    () => [...buildColumns(colDefs, intl), actionsColumn],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colDefs, intl],
  );

  return (
    <div className="p-6">
      <ProTable<WorkloadItem>
        headerTitle={
          <Space>
            <Text strong>{resourceType.charAt(0).toUpperCase() + resourceType.slice(1)}</Text>
            <Text type="secondary">
              {totalKnown != null ? `(${totalKnown})` : `(${items.length}${hasMore ? '+' : ''})`}
            </Text>
          </Space>
        }
        toolBarRender={() => [
          <Select
            key="ns"
            loading={nsLoading}
            allowClear
            placeholder={intl.formatMessage({ id: 'pages.workloads.allNamespaces' })}
            style={{ width: 200 }}
            value={namespace || undefined}
            onChange={(v) => setNamespace(v ?? '')}
            options={namespaces.map((ns) => ({ label: ns, value: ns }))}
          />,
          <Space.Compact key="refresh">
            <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh} />
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  { key: '0', label: intl.formatMessage({ id: 'pages.workloads.refresh.off' }) },
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
        rowKey={(r) => `${r.namespace}/${r.name}`}
        dataSource={items}
        columns={columns}
        search={false}
        pagination={false}
        options={{ reload: false }}
        loading={loading}
      />
      {(pageIdx > 0 || hasMore) && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '12px 0' }}>
          <Button size="small" icon={<LeftOutlined />} disabled={pageIdx === 0} onClick={() => setPageIdx((p) => p - 1)} />
          <Text type="secondary">
            {intl.formatMessage({ id: 'pages.workloads.page' }, { n: pageIdx + 1 })}
          </Text>
          <Button size="small" icon={<RightOutlined />} disabled={!hasMore} onClick={() => setPageIdx((p) => p + 1)} />
        </div>
      )}

      <Drawer
        title={intl.formatMessage(
          { id: readOnly ? 'pages.workloads.view' : 'pages.workloads.editor.title' },
          { type: resourceType, name: editingItem?.name ?? '' },
        )}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={680}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => setDrawerOpen(false)}>Cancel</Button>
            {!readOnly && (
              <Button type="primary" loading={applying} onClick={handleApply}>
                {intl.formatMessage({ id: 'pages.workloads.apply' })}
              </Button>
            )}
          </Space>
        }
      >
        {yamlText === '' ? (
          <div style={{ padding: 16, color: '#888' }}>Loading…</div>
        ) : (
          <YamlEditor value={yamlText} onChange={setYamlText} readOnly={readOnly} />
        )}
      </Drawer>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function WorkloadsPage() {
  const { id: clusterId, type } = useParams<{ id: string; type: string }>();

  const isValidType = !!type && VALID_TYPES.has(type);
  const resourceType = (isValidType ? type : 'deployments') as WorkloadResourceType;

  const { data: namespaces = [], loading: nsLoading } = useRequest(
    () => listNamespaces(clusterId!),
    {
      refreshDeps: [clusterId],
      formatResult: (res) => res,
      pollingWhenHidden: false,
    },
  );

  if (!isValidType) {
    return <Navigate to={`/clusters/${clusterId}/workloads/deployments`} replace />;
  }

  return (
    <ClusterLayout selectedKey={resourceType}>
      <WorkloadsContent
        key={resourceType}
        clusterId={clusterId!}
        resourceType={resourceType}
        namespaces={namespaces as string[]}
        nsLoading={nsLoading}
      />
    </ClusterLayout>
  );
}
