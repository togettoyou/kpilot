import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { Select, Space, Tag, Typography } from 'antd';
import type { ProColumns } from '@ant-design/pro-components';
import React, { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ClusterLayout } from '../ClusterLayout';
import type { WorkloadItem, WorkloadResourceType } from '@/services/kpilot/workload';
import { listNamespaces, listWorkloads } from '@/services/kpilot/workload';

const { Text } = Typography;

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
      let phase: string = item.status?.phase ?? 'Unknown';
      if (phase === 'Running') {
        for (const cs of csList) {
          if (cs.state?.waiting?.reason === 'CrashLoopBackOff') {
            phase = 'CrashLoopBackOff';
            break;
          }
        }
      }
      return {
        name: item.metadata.name,
        namespace: item.metadata.namespace,
        phase,
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

function readyCell(ready: string) {
  const [cur, total] = ready.split('/').map(Number);
  if (cur === total) return <Text type="success">{ready}</Text>;
  if (cur === 0) return <Text type="danger">{ready}</Text>;
  return <Text type="warning">{ready}</Text>;
}

const podPhaseColor: Record<string, string> = {
  Running: 'success',
  Pending: 'warning',
  Succeeded: 'processing',
  Failed: 'error',
};

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
      render: (_, r) => <Tag color={podPhaseColor[r.phase] ?? 'default'}>{r.phase}</Tag>,
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

// ─── Page ──────────────────────────────────────────────────────────────────

export default function WorkloadsPage() {
  const { id: clusterId, type } = useParams<{ id: string; type: string }>();
  const intl = useIntl();
  const [namespace, setNamespace] = useState('');

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

  const { data: items = [], loading } = useRequest(
    () => listWorkloads(clusterId!, resourceType, namespace),
    {
      refreshDeps: [clusterId, resourceType, namespace],
      formatResult: (res: any) => PARSERS[resourceType](res?.items ?? []),
      pollingWhenHidden: false,
    },
  );

  if (!isValidType) {
    return <Navigate to={`/clusters/${clusterId}/workloads/deployments`} replace />;
  }

  const columns = COLUMNS[resourceType](intl);

  return (
    <ClusterLayout selectedKey={resourceType}>
      <div className="p-6">
        <ProTable<WorkloadItem>
          headerTitle={
            <Space>
              <Text strong>{resourceType.charAt(0).toUpperCase() + resourceType.slice(1)}</Text>
              <Text type="secondary">({items.length})</Text>
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
              options={(namespaces as string[]).map((ns) => ({ label: ns, value: ns }))}
            />,
          ]}
          rowKey={(r) => `${r.namespace}/${r.name}`}
          dataSource={items}
          columns={columns}
          search={false}
          pagination={false}
          options={{ reload: false }}
          loading={loading}
        />
      </div>
    </ClusterLayout>
  );
}
