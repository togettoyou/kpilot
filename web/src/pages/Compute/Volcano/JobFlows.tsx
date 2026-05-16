import { PlusOutlined } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useModel, useParams } from '@umijs/max';

import { useClusterRequest } from '@/hooks/useClusterRequest';
import { App, Button, Popconfirm, Space, Tag, Typography } from 'antd';
import React, { useState } from 'react';

import { DescribeDrawer } from '@/pages/ClusterDetail/Workloads/DescribeDrawer';
import {
  listVolcanoJobFlows,
  type JobFlowRow,
} from '@/services/kpilot/volcano-list';
import { deleteWorkload } from '@/services/kpilot/workload';
import {
  NotInstalled,
  RefreshControl,
  ResourceIntro,
  TruncatedBanner,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';
import { YamlCreateDrawer } from './shared/YamlCreateDrawer';

// JobFlow (`flow.volcano.sh/v1alpha1`) — Volcano's DAG orchestration
// CR. References JobTemplates via `flows[].dependsOn` (HTTP / TCP /
// task-status probes). Namespaced. Create / edit uses YAML — the
// DAG + probe shapes are too rich for a typed form.

const JOB_FLOW_CR = {
  group: 'flow.volcano.sh',
  version: 'v1alpha1',
  kind: 'JobFlow',
  scope: 'Namespaced' as const,
};

// Starter template — minimal valid JobFlow that references two
// JobTemplates with a single dependency edge. namespace is templated
// from the current NamespacePicker selection at drawer open time so
// "current namespace = foo, click Create" lands the new flow in foo,
// not in `default`.
function buildDefaultJobFlowYaml(namespace: string): string {
  return `apiVersion: flow.volcano.sh/v1alpha1
kind: JobFlow
metadata:
  name: example-flow
  namespace: ${namespace || 'default'}
spec:
  jobRetainPolicy: retain
  flows:
    - name: prepare-data
    - name: train-model
      dependsOn:
        targets:
          - prepare-data
`;
}

export default function VolcanoJobFlowsPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const { message } = App.useApp();
  const namespaceModel = useModel('namespace');
  const ns = clusterId ? namespaceModel.get(clusterId).selected : '';

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<{
    name: string;
    namespace: string;
  } | null>(null);
  const [describing, setDescribing] = useState<{
    name: string;
    namespace: string;
  } | null>(null);

  const { data, loading, error, refresh } = useClusterRequest(
    () => listVolcanoJobFlows(clusterId!, ns),
    [clusterId, ns],
    { ready: !!clusterId },
  );

  const [interval, setInterval] = useAutoRefresh(refresh, !!clusterId);

  if (!clusterId) return null;
  if (error && isResourceNotAvailable(error)) {
    return <NotInstalled clusterId={clusterId} />;
  }

  const items = data?.items ?? [];
  const truncated = !!data?.continue;

  const doDelete = async (record: JobFlowRow) => {
    try {
      await deleteWorkload(
        clusterId,
        '_cr',
        record.name,
        record.namespace,
        JOB_FLOW_CR,
      );
      message.success(
        intl.formatMessage({ id: 'pages.workloads.delete.success' }),
      );
      refresh();
    } catch (e: any) {
      const m = e?.response?.data?.message ?? e?.message;
      if (m) message.error(String(m));
    }
  };

  const columns: ProColumns<JobFlowRow>[] = [
    {
      title: intl.formatMessage({ id: 'pages.compute.jobFlow.col.name' }),
      dataIndex: 'name',
      width: 200,
      fixed: 'left',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.jobFlow.col.namespace' }),
      dataIndex: 'namespace',
      width: 140,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.jobFlow.col.phase' }),
      dataIndex: 'phase',
      width: 110,
      render: (_, r) => <JobFlowPhaseTag phase={r.phase} />,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.jobFlow.col.flows' }),
      dataIndex: 'flowCount',
      width: 80,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.jobFlow.col.progress' }),
      key: 'progress',
      width: 260,
      render: (_, r) => <JobFlowProgressCell row={r} />,
    },
    {
      title: intl.formatMessage({
        id: 'pages.compute.jobFlow.col.retainPolicy',
      }),
      dataIndex: 'jobRetainPolicy',
      width: 110,
      render: (_, r) => r.jobRetainPolicy || '-',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.jobFlow.col.age' }),
      key: 'age',
      width: 80,
      render: (_, r) => formatAge(r.creationTimestamp),
    },
    {
      title: intl.formatMessage({ id: 'pages.workloads.col.actions' }),
      key: 'action',
      fixed: 'right',
      width: 220,
      render: (_, record) => (
        <Space size={0}>
          <Button
            type="link"
            size="small"
            onClick={() =>
              setDescribing({ name: record.name, namespace: record.namespace })
            }
          >
            {intl.formatMessage({ id: 'pages.workloads.describe' })}
          </Button>
          <Button
            type="link"
            size="small"
            onClick={() =>
              setEditing({ name: record.name, namespace: record.namespace })
            }
          >
            {intl.formatMessage({ id: 'pages.workloads.edit' })}
          </Button>
          <Popconfirm
            title={intl.formatMessage(
              { id: 'pages.workloads.delete.confirm' },
              { name: record.name },
            )}
            onConfirm={() => doDelete(record)}
            okType="danger"
          >
            <Button type="link" size="small" danger>
              {intl.formatMessage({ id: 'pages.workloads.delete' })}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="p-6">
      <ResourceIntro id="pages.compute.intro.jobflow" />
      {truncated && (
        <TruncatedBanner shown={items.length} count={items.length} />
      )}
      <ProTable<JobFlowRow>
        rowKey="uid"
        columns={columns}
        dataSource={items}
        loading={loading}
        search={false}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
        options={{ reload: false }}
        headerTitle={
          <Space>
            <Typography.Text strong>JobFlow</Typography.Text>
            <Typography.Text type="secondary">({items.length})</Typography.Text>
          </Space>
        }
        toolBarRender={() => [
          <Button
            key="new"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
          >
            {intl.formatMessage({ id: 'pages.compute.jobFlow.create' })}
          </Button>,
          <RefreshControl
            key="refresh"
            interval={interval}
            setInterval={setInterval}
            refresh={refresh}
            loading={loading}
          />,
        ]}
      />
      <YamlCreateDrawer
        open={createOpen}
        clusterId={clusterId}
        title={intl.formatMessage({ id: 'pages.compute.jobFlow.create.title' })}
        editTitle={intl.formatMessage({
          id: 'pages.compute.jobFlow.edit.title',
        })}
        cr={JOB_FLOW_CR}
        defaultYaml={buildDefaultJobFlowYaml(ns)}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          refresh();
        }}
      />
      <YamlCreateDrawer
        open={!!editing}
        clusterId={clusterId}
        title={intl.formatMessage({ id: 'pages.compute.jobFlow.create.title' })}
        editTitle={intl.formatMessage({
          id: 'pages.compute.jobFlow.edit.title',
        })}
        cr={JOB_FLOW_CR}
        defaultYaml={buildDefaultJobFlowYaml(ns)}
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
      <DescribeDrawer
        open={!!describing}
        onClose={() => setDescribing(null)}
        clusterId={clusterId}
        resourceType="_cr"
        name={describing?.name ?? ''}
        namespace={describing?.namespace ?? ''}
        cr={JOB_FLOW_CR}
      />
    </div>
  );
}

// JobFlowPhaseTag picks a colour per Volcano JobFlow phase. The enum
// is small (Succeed / Terminating / Failed / Running / Pending) so a
// switch is fine; unknown / empty phases render neutral.
function JobFlowPhaseTag({ phase }: { phase: string }) {
  if (!phase) return <Tag>-</Tag>;
  const color =
    phase === 'Succeed'
      ? 'green'
      : phase === 'Running'
        ? 'blue'
        : phase === 'Pending'
          ? 'gold'
          : phase === 'Failed'
            ? 'red'
            : phase === 'Terminating'
              ? 'orange'
              : 'default';
  return <Tag color={color}>{phase}</Tag>;
}

// JobFlowProgressCell renders the per-state job counts compactly so
// users can spot a stuck/failing flow at a glance without opening
// Describe. Zero buckets are dropped.
function JobFlowProgressCell({ row }: { row: JobFlowRow }) {
  const parts: Array<[string, number, string]> = [
    ['Running', row.runningCount, 'blue'],
    ['Pending', row.pendingCount, 'gold'],
    ['Completed', row.completedCount, 'green'],
    ['Failed', row.failedCount, 'red'],
    ['Terminated', row.terminatedCount, 'orange'],
    ['Unknown', row.unknownCount, 'default'],
  ];
  const live = parts.filter(([, n]) => n > 0);
  if (live.length === 0) {
    return <Typography.Text type="secondary">-</Typography.Text>;
  }
  return (
    <Space size={4} wrap>
      {live.map(([label, n, color]) => (
        <Tag key={label} color={color} style={{ marginInlineEnd: 0 }}>
          {label} {n}
        </Tag>
      ))}
    </Space>
  );
}
