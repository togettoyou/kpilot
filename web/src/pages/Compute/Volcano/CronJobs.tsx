import { PlusOutlined } from '@ant-design/icons';
import { useIntl, useParams, useRequest } from '@umijs/max';
import { App, Button, Popconfirm, Spin, Tag } from 'antd';
import React, { useContext, useState } from 'react';

import type { WorkloadItem } from '@/services/kpilot/workload';
import { WorkloadRefreshTickContext } from '@/pages/ClusterDetail/Workloads';
import { applyManifest } from '@/services/kpilot/volcano';
import { VolcanoCRPage } from './CRPage';
import { CronJobFormDrawer } from './CronJobForm';
import { fetchOnce } from './sharedFetch';

const CRONJOB_CR = {
  group: 'batch.volcano.sh',
  version: 'v1alpha1',
  kind: 'CronJob',
  scope: 'Namespaced' as const,
};

function CronJobSuspendCell({
  name,
  namespace,
}: {
  name: string;
  namespace: string;
}) {
  const { id: clusterId } = useParams<{ id: string }>();
  const tick = useContext(WorkloadRefreshTickContext);
  const { data, loading } = useRequest(
    () => fetchOnce(clusterId!, CRONJOB_CR, name, namespace, tick),
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId, name, namespace, tick],
    },
  );
  if (loading && !data) return <Spin size="small" />;
  const suspended =
    (data as { spec?: { suspend?: boolean } } | undefined)?.spec?.suspend ===
    true;
  return (
    <Tag color={suspended ? 'orange' : 'green'}>
      {suspended ? '已暂停' : '运行中'}
    </Tag>
  );
}

// Volcano CronJob (`batch.volcano.sh/v1alpha1`) — schedules a Volcano
// Job on a cron expression. Has the same structure as Job below the
// schedule level. Per-row "暂停 / 恢复" toggles spec.suspend on the
// CronJob; we patch the bool through /apply (SSA), no Command CR
// involved.
export default function VolcanoCronJobsPage() {
  const intl = useIntl();
  return (
    <VolcanoCRPage
      cr={CRONJOB_CR}
      extraToolbarButtons={({ refresh }) => (
        <CronJobCreateButton key="new" refresh={refresh} />
      )}
      extraRowActions={(record, { refresh }) => (
        <CronJobSuspendAction key="suspend" record={record} refresh={refresh} />
      )}
      replaceEditAction={(record, { refresh }) => (
        <CronJobEditButton record={record} refresh={refresh} />
      )}
      // Volcano's CronJob CRD has no printer columns — Table API row
      // gives only NAME + AGE. Inject a Suspend column so users can
      // tell at a glance whether a CronJob is paused.
      extraColumns={[
        {
          title: intl.formatMessage({
            id: 'pages.compute.cronJob.col.state',
          }),
          key: 'suspend',
          width: 100,
          render: (_, record) => (
            <CronJobSuspendCell name={record.name} namespace={record.namespace} />
          ),
        },
      ]}
    />
  );
}

function CronJobCreateButton({ refresh }: { refresh: () => void }) {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const [open, setOpen] = useState(false);
  if (!clusterId) return null;
  return (
    <>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={() => setOpen(true)}
      >
        {intl.formatMessage({ id: 'pages.compute.cronJob.create' })}
      </Button>
      <CronJobFormDrawer
        open={open}
        clusterId={clusterId}
        onClose={() => setOpen(false)}
        onSaved={refresh}
      />
    </>
  );
}

function CronJobEditButton({
  record,
  refresh,
}: {
  record: WorkloadItem;
  refresh: () => void;
}) {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();
  const [open, setOpen] = useState(false);
  if (!clusterId) return null;
  return (
    <>
      <Button type="link" size="small" onClick={() => setOpen(true)}>
        {intl.formatMessage({ id: 'pages.workloads.edit' })}
      </Button>
      <CronJobFormDrawer
        open={open}
        clusterId={clusterId}
        editing={{ name: record.name, namespace: record.namespace }}
        onClose={() => setOpen(false)}
        onSaved={refresh}
      />
    </>
  );
}

// CronJobSuspendAction patches spec.suspend. Volcano's CronJob CRD
// doesn't declare additionalPrinterColumns, so the K8s Table response
// has no SUSPEND column to scan — we fetch the full CronJob object
// per row and read .spec.suspend directly.
function CronJobSuspendAction({
  record,
  refresh,
}: {
  record: WorkloadItem;
  refresh: () => void;
}) {
  const intl = useIntl();
  const { message } = App.useApp();
  const { id: clusterId } = useParams<{ id: string }>();
  const tick = useContext(WorkloadRefreshTickContext);

  const stateReq = useRequest(
    () =>
      fetchOnce(
        clusterId!,
        CRONJOB_CR,
        record.name,
        record.namespace,
        tick,
      ),
    {
      formatResult: (res) => res,
      ready: !!clusterId,
      refreshDeps: [clusterId, record.name, record.namespace, tick],
    },
  );
  const suspended =
    (stateReq.data as { spec?: { suspend?: boolean } } | undefined)?.spec
      ?.suspend === true;

  if (!clusterId) return null;

  const next = !suspended;
  const labelId = suspended
    ? 'pages.compute.cronJob.action.resume'
    : 'pages.compute.cronJob.action.suspend';
  const confirmId = suspended
    ? 'pages.compute.cronJob.confirm.resume'
    : 'pages.compute.cronJob.confirm.suspend';

  const onConfirm = async () => {
    // SSA-patch via /apply: send a minimal manifest that touches only
    // the suspend flag. Other fields are left to whoever owns them.
    try {
      const res = await applyManifest(clusterId, {
        apiVersion: 'batch.volcano.sh/v1alpha1',
        kind: 'CronJob',
        metadata: { name: record.name, namespace: record.namespace },
        spec: { suspend: next },
      });
      const fail = res?.results?.find((r) => !r.success);
      if (fail) {
        message.error(fail.error ?? 'patch failed');
        return;
      }
      message.success(
        intl.formatMessage({
          id: next
            ? 'pages.compute.cronJob.suspended'
            : 'pages.compute.cronJob.resumed',
        }),
      );
      refresh();
      // Re-poll the local spec.suspend so the button label flips
      // even if the user has the table polling off. SSA-patches are
      // applied immediately, so a single short retry is enough.
      setTimeout(() => stateReq.refresh(), 600);
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message;
      if (msg) message.error(String(msg));
    }
  };

  // Suspend stops future triggers — paint danger so it's visually
  // distinct from the safe "Resume" flip.
  const isSuspending = next; // we're about to set suspend=true
  return (
    <Popconfirm
      title={intl.formatMessage({ id: confirmId }, { name: record.name })}
      onConfirm={onConfirm}
      okType={isSuspending ? 'danger' : 'primary'}
    >
      <Button
        type="link"
        size="small"
        danger={isSuspending}
        loading={stateReq.loading && !stateReq.data}
      >
        {intl.formatMessage({ id: labelId })}
      </Button>
    </Popconfirm>
  );
}
