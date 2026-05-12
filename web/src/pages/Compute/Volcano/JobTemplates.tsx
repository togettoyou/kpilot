import { PlusOutlined } from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { useIntl, useModel, useParams, useRequest } from '@umijs/max';
import { App, Button, Popconfirm, Space, Typography } from 'antd';
import React, { useState } from 'react';

import { DescribeDrawer } from '@/pages/ClusterDetail/Workloads/DescribeDrawer';
import {
  listVolcanoJobTemplates,
  type JobTemplateRow,
} from '@/services/kpilot/volcano-list';
import { deleteWorkload } from '@/services/kpilot/workload';
import {
  NotInstalled,
  RefreshControl,
  TruncatedBanner,
  formatAge,
  isResourceNotAvailable,
  useAutoRefresh,
} from './shared/Layout';
import { YamlCreateDrawer } from './shared/YamlCreateDrawer';

// JobTemplate (`flow.volcano.sh/v1alpha1`) — reusable Volcano JobSpec
// referenced by JobFlow `flows[].name`. Namespaced. YAML-only on
// create / edit; the schema is the full Volcano JobSpec which already
// has a dedicated typed form (the Job page) — duplicating it here for
// a *template* would just confuse users.

const JOB_TEMPLATE_CR = {
  group: 'flow.volcano.sh',
  version: 'v1alpha1',
  kind: 'JobTemplate',
  scope: 'Namespaced' as const,
};

function buildDefaultJobTemplateYaml(namespace: string): string {
  return `apiVersion: flow.volcano.sh/v1alpha1
kind: JobTemplate
metadata:
  name: example-template
  namespace: ${namespace || 'default'}
spec:
  minAvailable: 1
  schedulerName: volcano
  tasks:
    - name: main
      replicas: 1
      template:
        spec:
          schedulerName: volcano
          restartPolicy: OnFailure
          containers:
            - name: main
              image: busybox
              command: ['sh', '-c', 'echo hello && sleep 30']
`;
}

export default function VolcanoJobTemplatesPage() {
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

  const { data, loading, error, refresh } = useRequest(
    () => listVolcanoJobTemplates(clusterId!, ns),
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId, ns],
    },
  );

  const [interval, setInterval] = useAutoRefresh(refresh, !!clusterId);

  if (!clusterId) return null;
  if (error && isResourceNotAvailable(error)) {
    return <NotInstalled clusterId={clusterId} />;
  }

  const items = data?.items ?? [];
  const truncated = !!data?.continue;

  const doDelete = async (record: JobTemplateRow) => {
    try {
      await deleteWorkload(
        clusterId,
        '_cr',
        record.name,
        record.namespace,
        JOB_TEMPLATE_CR,
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

  const columns: ProColumns<JobTemplateRow>[] = [
    {
      title: intl.formatMessage({ id: 'pages.compute.jobTemplate.col.name' }),
      dataIndex: 'name',
      width: 200,
      fixed: 'left',
    },
    {
      title: intl.formatMessage({
        id: 'pages.compute.jobTemplate.col.namespace',
      }),
      dataIndex: 'namespace',
      width: 140,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.jobTemplate.col.queue' }),
      dataIndex: 'queue',
      width: 140,
      render: (_, r) => r.queue || 'default',
    },
    {
      title: intl.formatMessage({
        id: 'pages.compute.jobTemplate.col.minAvailable',
      }),
      dataIndex: 'minAvailable',
      width: 110,
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.jobTemplate.col.tasks' }),
      dataIndex: 'taskCount',
      width: 80,
    },
    {
      title: intl.formatMessage({
        id: 'pages.compute.jobTemplate.col.priorityClassName',
      }),
      dataIndex: 'priorityClassName',
      width: 160,
      render: (_, r) => r.priorityClassName || '-',
    },
    {
      title: intl.formatMessage({ id: 'pages.compute.jobTemplate.col.age' }),
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
      {truncated && (
        <TruncatedBanner shown={items.length} count={items.length} />
      )}
      <ProTable<JobTemplateRow>
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
            <Typography.Text strong>JobTemplate</Typography.Text>
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
            {intl.formatMessage({ id: 'pages.compute.jobTemplate.create' })}
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
        title={intl.formatMessage({
          id: 'pages.compute.jobTemplate.create.title',
        })}
        editTitle={intl.formatMessage({
          id: 'pages.compute.jobTemplate.edit.title',
        })}
        cr={JOB_TEMPLATE_CR}
        defaultYaml={buildDefaultJobTemplateYaml(ns)}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          refresh();
        }}
      />
      <YamlCreateDrawer
        open={!!editing}
        clusterId={clusterId}
        title={intl.formatMessage({
          id: 'pages.compute.jobTemplate.create.title',
        })}
        editTitle={intl.formatMessage({
          id: 'pages.compute.jobTemplate.edit.title',
        })}
        cr={JOB_TEMPLATE_CR}
        defaultYaml={buildDefaultJobTemplateYaml(ns)}
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
        cr={JOB_TEMPLATE_CR}
      />
    </div>
  );
}
