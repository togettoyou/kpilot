import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { App, Button, Drawer, Dropdown, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { DownOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import * as jsyaml from 'js-yaml';
import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ClusterLayout } from '../ClusterLayout';
import { YamlEditor } from './YamlEditor';
import type { WorkloadItem, WorkloadResourceType } from '@/services/kpilot/workload';
import { applyWorkload, deleteWorkload, getWorkload, listNamespaces, listWorkloads } from '@/services/kpilot/workload';

const { Text } = Typography;

// ─── Pod status helper (mirrors kubectl's STATUS computation) ─────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computePodStatus(item: any): string {
  if (item.metadata?.deletionTimestamp) return 'Terminating';

  const phase: string = item.status?.phase ?? 'Unknown';
  if (phase === 'Succeeded') return 'Completed';

  // Init containers — show Init:<reason> or Init:<i>/<total>
  const initStatuses: any[] = item.status?.initContainerStatuses ?? [];
  const initTotal: number = item.spec?.initContainers?.length ?? 0;
  for (let i = 0; i < initStatuses.length; i++) {
    const cs = initStatuses[i];
    if (cs.state?.terminated?.exitCode === 0) continue;
    if (cs.state?.terminated) return cs.state.terminated.reason || 'Init:Error';
    if (cs.state?.waiting?.reason && cs.state.waiting.reason !== 'PodInitializing') {
      return `Init:${cs.state.waiting.reason}`;
    }
    return `Init:${i}/${initTotal}`;
  }

  // Regular containers — surface waiting/terminated reasons
  const csList: any[] = item.status?.containerStatuses ?? [];
  for (const cs of csList) {
    if (cs.state?.waiting?.reason) return cs.state.waiting.reason;
    if (cs.state?.terminated) {
      if (cs.state.terminated.exitCode !== 0) return cs.state.terminated.reason || 'Error';
    }
  }

  return phase;
}

// ─── Age helper ───────────────────────────────────────────────────────────────

function formatAge(ts: string): string {
  const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// ─── K8s JSON → WorkloadItem parsers ─────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type K8sItem = any;

const PARSERS: Record<WorkloadResourceType, (items: K8sItem[]) => WorkloadItem[]> = {
  deployments: (items) =>
    items.map((item) => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      ready: `${item.status?.readyReplicas ?? 0}/${item.spec?.replicas ?? 0}`,
      upToDate: item.status?.updatedReplicas ?? 0,
      available: item.status?.availableReplicas ?? 0,
      age: formatAge(item.metadata.creationTimestamp),
    })),

  statefulsets: (items) =>
    items.map((item) => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      ready: `${item.status?.readyReplicas ?? 0}/${item.spec?.replicas ?? 0}`,
      age: formatAge(item.metadata.creationTimestamp),
    })),

  daemonsets: (items) =>
    items.map((item) => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      desired: item.status?.desiredNumberScheduled ?? 0,
      current: item.status?.currentNumberScheduled ?? 0,
      ready: item.status?.numberReady ?? 0,
      upToDate: item.status?.updatedNumberScheduled ?? 0,
      age: formatAge(item.metadata.creationTimestamp),
    })),

  pods: (items) =>
    items.map((item) => {
      const csList: K8sItem[] = item.status?.containerStatuses ?? [];
      const restarts = csList.reduce((n: number, cs: K8sItem) => n + (cs.restartCount ?? 0), 0);
      return {
        name: item.metadata.name,
        namespace: item.metadata.namespace,
        phase: computePodStatus(item),
        restarts,
        node: item.spec?.nodeName ?? '',
        age: formatAge(item.metadata.creationTimestamp),
      };
    }),

  services: (items) =>
    items.map((item) => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      type: item.spec?.type ?? 'ClusterIP',
      clusterIP: item.spec?.clusterIP ?? '',
      ports: (item.spec?.ports ?? [])
        .map((p: K8sItem) =>
          p.nodePort ? `${p.port}:${p.nodePort}/${p.protocol}` : `${p.port}/${p.protocol}`,
        )
        .join(', '),
      age: formatAge(item.metadata.creationTimestamp),
    })),

  ingresses: (items) =>
    items.map((item) => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      hosts:
        (item.spec?.rules ?? []).map((r: K8sItem) => r.host ?? '*').join(', ') || '—',
      address: (item.status?.loadBalancer?.ingress ?? [])
        .map((i: K8sItem) => i.ip ?? i.hostname ?? '')
        .filter(Boolean)
        .join(', '),
      age: formatAge(item.metadata.creationTimestamp),
    })),

  configmaps: (items) =>
    items.map((item) => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      dataCount:
        Object.keys(item.data ?? {}).length + Object.keys(item.binaryData ?? {}).length,
      age: formatAge(item.metadata.creationTimestamp),
    })),

  secrets: (items) =>
    items.map((item) => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      secretType: item.type ?? 'Opaque',
      age: formatAge(item.metadata.creationTimestamp),
    })),
};

// ─── Column configs ────────────────────────────────────────────────────────

type ColFn = (intl: ReturnType<typeof useIntl>) => ProColumns<WorkloadItem>[];

// Defensive: ready may be stale/undefined during type transitions.
function readyCell(ready: string | undefined) {
  if (!ready || !ready.includes('/')) return <Text>{ready ?? '—'}</Text>;
  const [cur, total] = ready.split('/').map(Number);
  if (cur === total) return <Text type="success">{ready}</Text>;
  if (cur === 0) return <Text type="danger">{ready}</Text>;
  return <Text type="warning">{ready}</Text>;
}

function podStatusColor(status: string): string {
  if (status === 'Running' || status === 'Completed') return 'success';
  if (status === 'Pending' || status.startsWith('Init:')) return 'warning';
  if (
    status === 'Failed' ||
    status === 'Error' ||
    status === 'OOMKilled' ||
    status === 'CrashLoopBackOff' ||
    status === 'ErrImagePull' ||
    status === 'ImagePullBackOff' ||
    status === 'CreateContainerError' ||
    status === 'InvalidImageName'
  )
    return 'error';
  if (status === 'Terminating') return 'default';
  return 'default';
}

const svcTypeColor: Record<string, string> = {
  ClusterIP: 'default',
  NodePort: 'blue',
  LoadBalancer: 'green',
};

const nameNsColumns = (intl: ReturnType<typeof useIntl>): ProColumns<WorkloadItem>[] => [
  { title: intl.formatMessage({ id: 'pages.workloads.col.name' }), dataIndex: 'name', width: 200 },
  {
    title: intl.formatMessage({ id: 'pages.workloads.col.namespace' }),
    dataIndex: 'namespace',
    width: 130,
  },
];

const ageColumn = (intl: ReturnType<typeof useIntl>): ProColumns<WorkloadItem> => ({
  title: intl.formatMessage({ id: 'pages.workloads.col.age' }),
  dataIndex: 'age',
  width: 80,
});

const COLUMNS: Record<WorkloadResourceType, ColFn> = {
  deployments: (intl) => [
    ...nameNsColumns(intl),
    { title: 'Ready', dataIndex: 'ready', width: 90, render: (_, r) => readyCell(r.ready) },
    { title: 'Up-to-date', dataIndex: 'upToDate', width: 100 },
    { title: 'Available', dataIndex: 'available', width: 90 },
    ageColumn(intl),
  ],
  statefulsets: (intl) => [
    ...nameNsColumns(intl),
    { title: 'Ready', dataIndex: 'ready', width: 90, render: (_, r) => readyCell(r.ready) },
    ageColumn(intl),
  ],
  daemonsets: (intl) => [
    ...nameNsColumns(intl),
    { title: 'Desired', dataIndex: 'desired', width: 80 },
    { title: 'Current', dataIndex: 'current', width: 80 },
    {
      title: 'Ready',
      dataIndex: 'ready',
      width: 80,
      render: (_, r) =>
        r.ready === r.desired ? (
          <Text type="success">{r.ready}</Text>
        ) : (
          <Text type="warning">{r.ready}</Text>
        ),
    },
    { title: 'Up-to-date', dataIndex: 'upToDate', width: 100 },
    ageColumn(intl),
  ],
  pods: (intl) => [
    ...nameNsColumns(intl),
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.status' }),
      dataIndex: 'phase',
      width: 160,
      render: (_, r) => <Tag color={podStatusColor(r.phase)}>{r.phase}</Tag>,
    },
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.restarts' }),
      dataIndex: 'restarts',
      width: 90,
      render: (_, r) =>
        r.restarts > 0 ? (
          <Text type={r.restarts >= 5 ? 'danger' : 'warning'}>{r.restarts}</Text>
        ) : (
          r.restarts
        ),
    },
    { title: intl.formatMessage({ id: 'pages.workloads.col.node' }), dataIndex: 'node', width: 120 },
    ageColumn(intl),
  ],
  services: (intl) => [
    ...nameNsColumns(intl),
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.type' }),
      dataIndex: 'type',
      width: 130,
      render: (_, r) => <Tag color={svcTypeColor[r.type] ?? 'default'}>{r.type}</Tag>,
    },
    { title: 'Cluster IP', dataIndex: 'clusterIP', width: 130 },
    { title: intl.formatMessage({ id: 'pages.workloads.col.ports' }), dataIndex: 'ports', width: 150 },
    ageColumn(intl),
  ],
  ingresses: (intl) => [
    ...nameNsColumns(intl),
    { title: intl.formatMessage({ id: 'pages.workloads.col.hosts' }), dataIndex: 'hosts', width: 200 },
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.address' }),
      dataIndex: 'address',
      width: 150,
      render: (_, r) => r.address || <Text type="secondary">—</Text>,
    },
    ageColumn(intl),
  ],
  configmaps: (intl) => [
    ...nameNsColumns(intl),
    { title: intl.formatMessage({ id: 'pages.workloads.col.data' }), dataIndex: 'dataCount', width: 80 },
    ageColumn(intl),
  ],
  secrets: (intl) => [
    ...nameNsColumns(intl),
    { title: intl.formatMessage({ id: 'pages.workloads.col.type' }), dataIndex: 'secretType', width: 280 },
    ageColumn(intl),
  ],
};

const VALID_TYPES = new Set<string>(Object.keys(COLUMNS));

// ─── Inner component — remounts on resourceType change via key prop ────────

interface WorkloadsContentProps {
  clusterId: string;
  resourceType: WorkloadResourceType;
  namespaces: string[];
  nsLoading: boolean;
}

// Strip managedFields for readability; resourceVersion is kept for optimistic locking.
function toEditableYaml(raw: any): string {
  const obj = { ...raw };
  if (obj.metadata) {
    const { managedFields: _, ...rest } = obj.metadata;
    obj.metadata = rest;
  }
  return jsyaml.dump(obj, { lineWidth: -1 });
}

const PAGE_SIZE = 100;

function WorkloadsContent({ clusterId, resourceType, namespaces, nsLoading }: WorkloadsContentProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const [namespace, setNamespace] = useState('');
  const [pollingInterval, setPollingInterval] = useState(0);

  // Server-side cursor pagination.
  // pageTokens[i] = the continue token used to fetch page i.
  // pageTokens[0] is always '' (first page). pageTokens[i+1] is saved from
  // page i's response so the user can go forward without re-fetching.
  const [pageTokens, setPageTokens] = useState<string[]>(['']);
  const [pageIdx, setPageIdx] = useState(0);
  const currentToken = pageTokens[pageIdx] ?? '';

  // Reset to page 1 whenever the namespace filter changes.
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
      formatResult: (res: any) => ({
        items: PARSERS[resourceType](res?.items ?? []) as WorkloadItem[],
        nextToken: (res?.metadata?.continue as string) ?? '',
        remaining: res?.metadata?.remainingItemCount as number | undefined,
      }),
      pollingWhenHidden: false,
    },
  );

  const items = pageData?.items ?? [];
  const nextToken = pageData?.nextToken ?? '';
  const hasMore = !!nextToken;
  // Approximate total: items seen so far + remaining (if K8s reports it).
  const totalKnown =
    pageData?.remaining != null
      ? pageIdx * PAGE_SIZE + items.length + pageData.remaining
      : undefined;

  // Cache the next-page token so the user can navigate forward.
  useEffect(() => {
    if (!nextToken) return;
    setPageTokens((prev) => {
      if (prev[pageIdx + 1]) return prev; // already cached
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
          title={intl.formatMessage(
            { id: 'pages.workloads.delete.confirm' },
            { name: record.name },
          )}
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

  const columns = [...COLUMNS[resourceType](intl), actionsColumn];

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
        footer={() =>
          pageIdx > 0 || hasMore ? (
            <Space style={{ float: 'right' }}>
              <Button size="small" disabled={pageIdx === 0} onClick={() => setPageIdx((p) => p - 1)}>
                ‹ Prev
              </Button>
              <Text type="secondary">Page {pageIdx + 1}</Text>
              <Button size="small" disabled={!hasMore} onClick={() => setPageIdx((p) => p + 1)}>
                Next ›
              </Button>
            </Space>
          ) : null
        }
      />

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

  // Fetch namespaces once per cluster, shared across all type switches.
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
      {/* key forces a full remount when resourceType changes, preventing stale data
          from a previous type being rendered with the new type's columns. */}
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
