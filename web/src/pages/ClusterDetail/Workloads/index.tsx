import {
  DownOutlined,
  LeftOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useModel, useParams, useRequest } from '@umijs/max';
import {
  App,
  Button,
  Drawer,
  Dropdown,
  Input,
  Popconfirm,
  Space,
  Tag,
  Typography,
} from 'antd';
import * as jsyaml from 'js-yaml';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type {
  WorkloadItem,
  WorkloadResourceType,
} from '@/services/kpilot/workload';
import {
  applyWorkload,
  CLUSTER_SCOPED_TYPES,
  deleteWorkload,
  getWorkload,
  listWorkloads,
} from '@/services/kpilot/workload';
import { ApplyYamlDrawer } from './ApplyYamlDrawer';
import { DescribeDrawer } from './DescribeDrawer';
import { PodExecDrawer } from './PodExecDrawer';
import { PodLogsDrawer } from './PodLogsDrawer';
import { YamlEditor } from './YamlEditor';

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
  Volume: 'pages.workloads.col.volume',
  Capacity: 'pages.workloads.col.capacity',
  'Access Modes': 'pages.workloads.col.accessModes',
  StorageClass: 'pages.workloads.col.storageClass',
  'Reclaim Policy': 'pages.workloads.col.reclaimPolicy',
  Claim: 'pages.workloads.col.claim',
  Reason: 'pages.workloads.col.reason',
  VolumeMode: 'pages.workloads.col.volumeMode',
  VolumeAttributesClass: 'pages.workloads.col.volumeAttributesClass',
};

const COL_WIDTHS: Record<string, number> = {
  Name: 200,
  Namespace: 130,
  Age: 80,
  Status: 150,
  Ready: 90,
  Restarts: 90,
  Node: 150,
  Type: 110,
  'Cluster-IP': 130,
  'External-IP': 130,
  'Port(s)': 170,
  Hosts: 200,
  Address: 150,
  Data: 70,
  'Up-to-date': 100,
  Available: 90,
  Desired: 80,
  Current: 80,
};

const SVC_TYPE_COLOR: Record<string, string> = {
  ClusterIP: 'default',
  NodePort: 'blue',
  LoadBalancer: 'green',
};

function podStatusColor(s: string): string {
  if (s === 'Running' || s === 'Completed') return 'success';
  if (s === 'Pending' || s.startsWith('Init:')) return 'warning';
  if (
    [
      'Failed',
      'Error',
      'OOMKilled',
      'CrashLoopBackOff',
      'ErrImagePull',
      'ImagePullBackOff',
      'CreateContainerError',
      'InvalidImageName',
    ].includes(s)
  )
    return 'error';
  return 'default';
}

function renderCell(colName: string, value: any): React.ReactNode {
  const v = value != null ? String(value) : '';
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
function parseTableResponse(res: any): {
  items: WorkloadItem[];
  colDefs: any[];
} {
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
  clusterScoped = false,
): ProColumns<WorkloadItem>[] {
  const fixed: ProColumns<WorkloadItem>[] = [
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.name' }),
      dataIndex: 'name',
      width: 200,
    },
    ...(!clusterScoped
      ? [
          {
            title: intl.formatMessage({ id: 'pages.workloads.col.namespace' }),
            dataIndex: 'namespace',
            width: 130,
          } as ProColumns<WorkloadItem>,
        ]
      : []),
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
  'deployments',
  'statefulsets',
  'daemonsets',
  'pods',
  'jobs',
  'cronjobs',
  'horizontalpodautoscalers',
  'services',
  'ingresses',
  'gatewayclasses',
  'gateways',
  'httproutes',
  'grpcroutes',
  'configmaps',
  'secrets',
  'persistentvolumeclaims',
  'persistentvolumes',
]);

// CLUSTER_SCOPED_TYPES (shared with NamespacePicker) is the source of
// truth for which workload kinds have no metadata.namespace. We also use
// it here to drop the namespace column from the table.

interface WorkloadsContentProps {
  clusterId: string;
  resourceType: WorkloadResourceType;
}

// ─── Inner component — remounts on resourceType change via key prop ────────

const PAGE_SIZE = 100;

function WorkloadsContent({ clusterId, resourceType }: WorkloadsContentProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  // Cluster-scoped resources (PV) have no namespace; sending one yields 404.
  // Compute up-front so the listWorkloads call below can short-circuit.
  const isClusterScoped = CLUSTER_SCOPED_TYPES.has(resourceType);

  // Namespace selection lives in the global `namespace` model so navigating
  // between workload sub-pages preserves it; the picker UI lives in the top
  // bar (rendered by ProLayout's actionsRender, see app.tsx).
  const ns = useModel('namespace');
  const namespace = ns.get(clusterId).selected;
  const [pollingInterval, setPollingInterval] = useState(0);

  // For cluster-scoped resources, ignore the namespace state entirely.
  const effectiveNamespace = isClusterScoped ? '' : namespace;

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

  // Pod logs / exec drawer state — only relevant when resourceType === 'pods'
  const [logsTarget, setLogsTarget] = useState<WorkloadItem | null>(null);
  const [execTarget, setExecTarget] = useState<WorkloadItem | null>(null);

  // Describe drawer — available for every workload type.
  const [describeTarget, setDescribeTarget] = useState<WorkloadItem | null>(
    null,
  );

  // Generic Apply YAML drawer — always available regardless of resourceType.
  const [applyOpen, setApplyOpen] = useState(false);

  // Client-side search across the current page. K8s API has no substring
  // search (fieldSelector on metadata.name only does exact equality), so we
  // filter what's already loaded — same approach as kubectl/Lens.
  const [search, setSearch] = useState('');

  const {
    data: pageData,
    loading,
    refresh,
  } = useRequest(
    () =>
      listWorkloads(
        clusterId,
        resourceType,
        effectiveNamespace,
        PAGE_SIZE,
        currentToken,
      ),
    {
      refreshDeps: [effectiveNamespace, currentToken],
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

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((r) => {
      if (r.name?.toLowerCase().includes(q)) return true;
      if (r.namespace?.toLowerCase().includes(q)) return true;
      for (const col of colDefs) {
        const v = r[col.name];
        if (v != null && String(v).toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [items, colDefs, search]);
  const isFiltering = search.trim().length > 0;

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

  // Sequence counter to discard stale openEditor responses on fast clicks.
  const editorSeqRef = useRef(0);

  const openEditor = async (item: WorkloadItem, ro = false) => {
    const seq = ++editorSeqRef.current;
    setEditingItem(item);
    setReadOnly(ro);
    setYamlText('');
    setDrawerOpen(true);
    try {
      const raw = await getWorkload(
        clusterId,
        resourceType,
        item.name,
        item.namespace ?? '',
      );
      if (seq !== editorSeqRef.current) return;
      setYamlText(toEditableYaml(raw));
    } catch {
      if (seq !== editorSeqRef.current) return;
      message.error(intl.formatMessage({ id: 'pages.workloads.loadError' }));
      setDrawerOpen(false);
    }
  };

  const handleApply = async () => {
    if (!editingItem) return;
    setApplying(true);
    try {
      const obj = jsyaml.load(yamlText) as object;
      await applyWorkload(
        clusterId,
        resourceType,
        editingItem.name,
        editingItem.namespace ?? '',
        obj,
      );
      message.success(
        intl.formatMessage({ id: 'pages.workloads.apply.success' }),
      );
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
      await deleteWorkload(
        clusterId,
        resourceType,
        item.name,
        item.namespace ?? '',
      );
      message.success(
        intl.formatMessage({ id: 'pages.workloads.delete.success' }),
      );
      refresh();
    } catch {
      // global error handler in requestErrorConfig already shows the toast
    }
  };

  const isPods = resourceType === 'pods';

  const columns = useMemo((): ProColumns<WorkloadItem>[] => {
    const actionsColumn: ProColumns<WorkloadItem> = {
      title: intl.formatMessage({ id: 'pages.workloads.col.actions' }),
      valueType: 'option',
      width: isPods ? 300 : 180,
      fixed: 'right',
      render: (_, record) => {
        // Mirror the backend's protected-namespace list. kube-* covers
        // control-plane workloads; kpilot-* covers built-in plugin
        // installs (VictoriaMetrics / Node Exporter / VictoriaLogs / HAMi)
        // — managing those goes through the Plugins page, not the
        // workload list.
        const ns = record.namespace ?? '';
        const isProtected = ns.startsWith('kube-') || ns.startsWith('kpilot-');
        const describeBtn = (
          <Button
            key="describe"
            type="link"
            size="small"
            onClick={() => setDescribeTarget(record)}
          >
            {intl.formatMessage({ id: 'pages.workloads.describe' })}
          </Button>
        );
        const podActions = isPods
          ? [
              <Button
                key="logs"
                type="link"
                size="small"
                onClick={() => setLogsTarget(record)}
              >
                {intl.formatMessage({ id: 'pages.workloads.logs' })}
              </Button>,
              <Button
                key="exec"
                type="link"
                size="small"
                onClick={() => setExecTarget(record)}
              >
                {intl.formatMessage({ id: 'pages.workloads.exec' })}
              </Button>,
            ]
          : null;
        if (isProtected) {
          return [
            podActions,
            describeBtn,
            <Button
              key="view"
              type="link"
              size="small"
              onClick={() => openEditor(record, true)}
            >
              {intl.formatMessage({ id: 'pages.workloads.view' })}
            </Button>,
          ];
        }
        return [
          podActions,
          describeBtn,
          <Button
            key="edit"
            type="link"
            size="small"
            onClick={() => openEditor(record)}
          >
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
    return [...buildColumns(colDefs, intl, isClusterScoped), actionsColumn];
  }, [colDefs, intl, isClusterScoped, isPods, openEditor, handleDelete]);

  return (
    <div className="p-6">
      <ProTable<WorkloadItem>
        headerTitle={
          <Space>
            <Text strong>
              {resourceType.charAt(0).toUpperCase() + resourceType.slice(1)}
            </Text>
            <Text type="secondary">
              {isFiltering
                ? `(${filteredItems.length} / ${
                    totalKnown != null
                      ? totalKnown
                      : `${items.length}${hasMore ? '+' : ''}`
                  })`
                : totalKnown != null
                  ? `(${totalKnown})`
                  : `(${items.length}${hasMore ? '+' : ''})`}
            </Text>
          </Space>
        }
        toolBarRender={() => [
          <Input
            key="search"
            placeholder={intl.formatMessage({
              id: 'pages.workloads.searchPlaceholder',
            })}
            prefix={<SearchOutlined />}
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 240 }}
          />,
          <Button
            key="apply"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setApplyOpen(true)}
          >
            {intl.formatMessage({ id: 'pages.applyYaml.title' })}
          </Button>,
          <Space.Compact key="refresh">
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={refresh}
            />
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: '0',
                    label: intl.formatMessage({
                      id: 'pages.workloads.refresh.off',
                    }),
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
                {pollingInterval > 0 ? (
                  `${pollingInterval / 1000}s`
                ) : (
                  <DownOutlined />
                )}
              </Button>
            </Dropdown>
          </Space.Compact>,
        ]}
        rowKey={(r) => `${r.namespace}/${r.name}`}
        dataSource={filteredItems}
        columns={columns}
        // Honor explicit column widths and scroll horizontally when the sum
        // exceeds the container — otherwise antd squeezes columns and Chinese
        // headers wrap one character per line.
        scroll={{ x: 'max-content' }}
        search={false}
        pagination={false}
        options={{ reload: false }}
        loading={loading}
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
            {intl.formatMessage(
              { id: 'pages.workloads.page' },
              { n: pageIdx + 1 },
            )}
          </Text>
          <Button
            size="small"
            icon={<RightOutlined />}
            disabled={!hasMore}
            onClick={() => setPageIdx((p) => p + 1)}
          />
        </div>
      )}

      <Drawer
        title={intl.formatMessage(
          {
            id: readOnly
              ? 'pages.workloads.view'
              : 'pages.workloads.editor.title',
          },
          { type: resourceType, name: editingItem?.name ?? '' },
        )}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        size={680}
        maskClosable={false}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => setDrawerOpen(false)}>
              {intl.formatMessage({ id: 'pages.workloads.cancel' })}
            </Button>
            {!readOnly && (
              <Button type="primary" loading={applying} onClick={handleApply}>
                {intl.formatMessage({ id: 'pages.workloads.apply' })}
              </Button>
            )}
          </Space>
        }
      >
        {yamlText === '' ? (
          <div style={{ padding: 16, color: '#888' }}>
            {intl.formatMessage({ id: 'pages.workloads.loading' })}
          </div>
        ) : (
          <YamlEditor
            value={yamlText}
            onChange={setYamlText}
            readOnly={readOnly}
          />
        )}
      </Drawer>
      {logsTarget && (
        <PodLogsDrawer
          open={!!logsTarget}
          onClose={() => setLogsTarget(null)}
          clusterId={clusterId}
          namespace={logsTarget.namespace ?? ''}
          podName={logsTarget.name}
        />
      )}
      {execTarget && (
        <PodExecDrawer
          open={!!execTarget}
          onClose={() => setExecTarget(null)}
          clusterId={clusterId}
          namespace={execTarget.namespace ?? ''}
          podName={execTarget.name}
        />
      )}
      {describeTarget && (
        <DescribeDrawer
          open={!!describeTarget}
          onClose={() => setDescribeTarget(null)}
          clusterId={clusterId}
          resourceType={resourceType}
          name={describeTarget.name}
          namespace={describeTarget.namespace ?? ''}
        />
      )}
      <ApplyYamlDrawer
        open={applyOpen}
        onClose={() => setApplyOpen(false)}
        onApplied={() => {
          refresh();
          // Applied YAML may have created a Namespace — ask the model to
          // refetch so the global picker shows it without a browser reload.
          ns.refresh(clusterId);
        }}
        clusterId={clusterId}
        resourceType={resourceType}
      />
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function WorkloadsPage() {
  const { id: clusterId, type } = useParams<{ id: string; type: string }>();

  const isValidType = !!type && VALID_TYPES.has(type);
  const resourceType = (
    isValidType ? type : 'deployments'
  ) as WorkloadResourceType;

  if (!isValidType) {
    return (
      <Navigate to={`/clusters/${clusterId}/workloads/deployments`} replace />
    );
  }

  return (
    <WorkloadsContent
      key={resourceType}
      clusterId={clusterId!}
      resourceType={resourceType}
    />
  );
}
