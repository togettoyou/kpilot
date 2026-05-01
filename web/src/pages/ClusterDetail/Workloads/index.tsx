import { ProTable } from '@ant-design/pro-components';
import { useIntl, useParams } from '@umijs/max';
import { Space, Tag, Typography } from 'antd';
import type { ProColumns } from '@ant-design/pro-components';
import React from 'react';
import { Navigate } from 'react-router-dom';
import { ClusterLayout } from '../ClusterLayout';
import type { WorkloadItem, WorkloadResourceType } from '@/services/kpilot/workload';

const { Text } = Typography;

// ─── Mock data (replace with useRequest in P3 backend phase) ───────────────

const MOCK: Record<WorkloadResourceType, WorkloadItem[]> = {
  deployments: [
    { name: 'nginx',       namespace: 'default',     ready: '3/3', upToDate: 3, available: 3, age: '12d' },
    { name: 'api-server',  namespace: 'production',  ready: '2/2', upToDate: 2, available: 2, age: '5d'  },
    { name: 'frontend',    namespace: 'production',  ready: '1/2', upToDate: 1, available: 1, age: '2d'  },
    { name: 'worker',      namespace: 'staging',     ready: '0/1', upToDate: 0, available: 0, age: '1d'  },
  ],
  statefulsets: [
    { name: 'postgres', namespace: 'production', ready: '3/3', age: '30d' },
    { name: 'redis',    namespace: 'default',    ready: '1/1', age: '15d' },
    { name: 'etcd',     namespace: 'kube-system',ready: '3/3', age: '45d' },
  ],
  daemonsets: [
    { name: 'kube-proxy',    namespace: 'kube-system', desired: 3, current: 3, ready: 3, upToDate: 3, age: '45d' },
    { name: 'fluentd',       namespace: 'logging',     desired: 3, current: 3, ready: 2, upToDate: 3, age: '10d' },
    { name: 'node-exporter', namespace: 'monitoring',  desired: 3, current: 3, ready: 3, upToDate: 3, age: '20d' },
  ],
  pods: [
    { name: 'nginx-abc123',          namespace: 'default',     phase: 'Running',           restarts: 0,  node: 'node01', age: '12d' },
    { name: 'api-server-def456',     namespace: 'production',  phase: 'Running',           restarts: 2,  node: 'node02', age: '5d'  },
    { name: 'frontend-ghi789',       namespace: 'production',  phase: 'Running',           restarts: 0,  node: 'node01', age: '2d'  },
    { name: 'worker-jkl012',         namespace: 'staging',     phase: 'CrashLoopBackOff',  restarts: 15, node: 'node02', age: '1d'  },
    { name: 'db-migration-mno345',   namespace: 'production',  phase: 'Succeeded',         restarts: 0,  node: 'node01', age: '3d'  },
  ],
  services: [
    { name: 'kubernetes',  namespace: 'default',    type: 'ClusterIP',    clusterIP: '10.96.0.1',   ports: '443/TCP',          age: '45d' },
    { name: 'nginx-svc',   namespace: 'default',    type: 'NodePort',     clusterIP: '10.100.1.5',  ports: '80:30080/TCP',     age: '12d' },
    { name: 'api-lb',      namespace: 'production', type: 'LoadBalancer', clusterIP: '10.100.2.8',  ports: '8080:32080/TCP',   age: '5d'  },
    { name: 'redis',       namespace: 'production', type: 'ClusterIP',    clusterIP: '10.100.3.12', ports: '6379/TCP',         age: '30d' },
  ],
  ingresses: [
    { name: 'main',   namespace: 'production', hosts: 'app.example.com',  address: '192.168.1.100', age: '5d'  },
    { name: 'admin',  namespace: 'production', hosts: 'admin.example.com',address: '192.168.1.100', age: '5d'  },
    { name: 'dev',    namespace: 'staging',    hosts: 'dev.example.com',  address: '',              age: '1d'  },
  ],
  configmaps: [
    { name: 'nginx-config',     namespace: 'default',     dataCount: 3,  age: '12d' },
    { name: 'app-config',       namespace: 'production',  dataCount: 12, age: '5d'  },
    { name: 'kube-root-ca.crt', namespace: 'default',     dataCount: 1,  age: '45d' },
    { name: 'kube-root-ca.crt', namespace: 'kube-system', dataCount: 1,  age: '45d' },
  ],
  secrets: [
    { name: 'default-token', namespace: 'default',    secretType: 'kubernetes.io/service-account-token', age: '45d' },
    { name: 'tls-cert',      namespace: 'production', secretType: 'kubernetes.io/tls',                   age: '5d'  },
    { name: 'app-secret',    namespace: 'production', secretType: 'Opaque',                              age: '8d'  },
    { name: 'registry-cred', namespace: 'default',    secretType: 'kubernetes.io/dockerconfigjson',      age: '20d' },
  ],
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
  { title: intl.formatMessage({ id: 'pages.workloads.col.name' }),      dataIndex: 'name',      width: 200 },
  { title: intl.formatMessage({ id: 'pages.workloads.col.namespace' }), dataIndex: 'namespace', width: 130 },
];

const ageColumn = (intl: ReturnType<typeof useIntl>): ProColumns<WorkloadItem> =>
  ({ title: intl.formatMessage({ id: 'pages.workloads.col.age' }), dataIndex: 'age', width: 80 });

const COLUMNS: Record<WorkloadResourceType, ColFn> = {
  deployments: (intl) => [
    ...nameNsColumns(intl),
    { title: 'Ready',     dataIndex: 'ready',     width: 90,  render: (_, r) => readyCell(r.ready) },
    { title: 'Up-to-date',dataIndex: 'upToDate',  width: 100 },
    { title: 'Available', dataIndex: 'available', width: 90  },
    ageColumn(intl),
  ],
  statefulsets: (intl) => [
    ...nameNsColumns(intl),
    { title: 'Ready', dataIndex: 'ready', width: 90, render: (_, r) => readyCell(r.ready) },
    ageColumn(intl),
  ],
  daemonsets: (intl) => [
    ...nameNsColumns(intl),
    { title: 'Desired',    dataIndex: 'desired',   width: 80 },
    { title: 'Current',    dataIndex: 'current',   width: 80 },
    { title: 'Ready',      dataIndex: 'ready',     width: 80, render: (_, r) => r.ready === r.desired ? <Text type="success">{r.ready}</Text> : <Text type="warning">{r.ready}</Text> },
    { title: 'Up-to-date', dataIndex: 'upToDate',  width: 100 },
    ageColumn(intl),
  ],
  pods: (intl) => [
    ...nameNsColumns(intl),
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.status' }),
      dataIndex: 'phase', width: 160,
      render: (_, r) => (
        <Tag color={podPhaseColor[r.phase] ?? 'default'}>{r.phase}</Tag>
      ),
    },
    { title: intl.formatMessage({ id: 'pages.workloads.col.restarts' }), dataIndex: 'restarts', width: 90,
      render: (_, r) => r.restarts > 0 ? <Text type={r.restarts >= 5 ? 'danger' : 'warning'}>{r.restarts}</Text> : r.restarts,
    },
    { title: intl.formatMessage({ id: 'pages.workloads.col.node' }), dataIndex: 'node', width: 120 },
    ageColumn(intl),
  ],
  services: (intl) => [
    ...nameNsColumns(intl),
    { title: intl.formatMessage({ id: 'pages.workloads.col.type' }),      dataIndex: 'type',      width: 130,
      render: (_, r) => <Tag color={svcTypeColor[r.type] ?? 'default'}>{r.type}</Tag>,
    },
    { title: 'Cluster IP', dataIndex: 'clusterIP', width: 130 },
    { title: intl.formatMessage({ id: 'pages.workloads.col.ports' }),     dataIndex: 'ports',     width: 150 },
    ageColumn(intl),
  ],
  ingresses: (intl) => [
    ...nameNsColumns(intl),
    { title: intl.formatMessage({ id: 'pages.workloads.col.hosts' }),   dataIndex: 'hosts',   width: 200 },
    { title: intl.formatMessage({ id: 'pages.workloads.col.address' }), dataIndex: 'address', width: 150,
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

  if (!type || !VALID_TYPES.has(type)) {
    return <Navigate to={`/clusters/${clusterId}/workloads/deployments`} replace />;
  }

  const resourceType = type as WorkloadResourceType;
  const columns = COLUMNS[resourceType](intl);
  const data = MOCK[resourceType];

  return (
    <ClusterLayout selectedKey={resourceType}>
      <div className="p-6">
        <ProTable<WorkloadItem>
          headerTitle={
            <Space>
              <Text strong>{resourceType.charAt(0).toUpperCase() + resourceType.slice(1)}</Text>
              <Text type="secondary">({data.length})</Text>
            </Space>
          }
          rowKey={(r) => `${r.namespace}/${r.name}`}
          dataSource={data}
          columns={columns}
          search={false}
          pagination={false}
          options={{ reload: false }}
          loading={false}
        />
      </div>
    </ClusterLayout>
  );
}
