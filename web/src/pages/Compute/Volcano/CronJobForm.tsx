import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useIntl, useModel } from '@umijs/max';
import {
  App,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
} from 'antd';
import React, { useEffect, useState } from 'react';

import {
  applyManifest,
  buildCronJobManifest,
  type CronJobInput,
} from '@/services/kpilot/volcano';
import { getWorkload } from '@/services/kpilot/workload';

interface CronJobFormDrawerProps {
  open: boolean;
  clusterId: string;
  editing?: { name: string; namespace: string } | null;
  onClose: () => void;
  onSaved: () => void;
}

const CRONJOB_CR = {
  group: 'batch.volcano.sh',
  version: 'v1alpha1',
  kind: 'CronJob',
  scope: 'Namespaced' as const,
};

interface TaskFV {
  name: string;
  replicas: number;
  image: string;
  command?: string;
  args?: string;
  cpu?: string;
  memory?: string;
  vgpuNumber?: string;
  vgpuMemory?: string;
  vgpuCores?: string;
  restartPolicy: 'OnFailure' | 'Never' | 'Always';
}

interface FormValues {
  name: string;
  namespace: string;
  schedule: string;
  concurrencyPolicy: 'Allow' | 'Forbid' | 'Replace';
  successfulJobsHistoryLimit?: number;
  failedJobsHistoryLimit?: number;
  suspend: boolean;
  queue?: string;
  minAvailable?: number;
  plugins?: string[];
  tasks: TaskFV[];
}

// CronJobFormDrawer is JobFormDrawer + a schedule + concurrencyPolicy
// + history limits + suspend toggle. Reuses the same task-array shape
// so users who've used the Job form recognize everything below the
// schedule. Goal: be the simplest possible form that produces a valid
// `batch.volcano.sh CronJob` (a Volcano Job template wrapped in cron
// scheduling metadata).
export function CronJobFormDrawer({
  open,
  clusterId,
  editing,
  onClose,
  onSaved,
}: CronJobFormDrawerProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const ns = useModel('namespace');
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);

  const isEdit = !!editing;
  const namespaceOptions = (ns.get(clusterId).list ?? []).map((n) => ({
    label: n,
    value: n,
  }));

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    form.resetFields();
    if (!editing) {
      form.setFieldsValue({
        namespace: ns.get(clusterId).selected || 'default',
        schedule: '0 * * * *',
        concurrencyPolicy: 'Allow',
        suspend: false,
        tasks: [
          {
            name: 'main',
            replicas: 1,
            image: '',
            restartPolicy: 'OnFailure',
          },
        ],
      });
      return;
    }
    setLoading(true);
    getWorkload(
      clusterId,
      '_cr',
      editing.name,
      editing.namespace,
      CRONJOB_CR,
    )
      .then((obj: any) => {
        if (cancelled) return;
        const spec = obj?.spec ?? {};
        const jSpec = spec.jobTemplate?.spec ?? {};
        form.setFieldsValue({
          name: editing.name,
          namespace: editing.namespace,
          schedule: spec.schedule ?? '0 * * * *',
          concurrencyPolicy: spec.concurrencyPolicy ?? 'Allow',
          successfulJobsHistoryLimit: spec.successfulJobsHistoryLimit,
          failedJobsHistoryLimit: spec.failedJobsHistoryLimit,
          suspend: spec.suspend ?? false,
          queue: jSpec.queue,
          minAvailable:
            typeof jSpec.minAvailable === 'number'
              ? jSpec.minAvailable
              : undefined,
          plugins: jSpec.plugins ? Object.keys(jSpec.plugins) : undefined,
          tasks: extractCronTasks(jSpec.tasks),
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, editing, form, ns, clusterId]);

  const splitWS = (s: string | undefined) => {
    if (!s || !s.trim()) return undefined;
    return s.trim().split(/\s+/);
  };

  const handleSubmit = async () => {
    let v: FormValues;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    const input: CronJobInput = {
      name: v.name,
      namespace: v.namespace,
      schedule: v.schedule,
      concurrencyPolicy: v.concurrencyPolicy,
      successfulJobsHistoryLimit: v.successfulJobsHistoryLimit,
      failedJobsHistoryLimit: v.failedJobsHistoryLimit,
      suspend: v.suspend,
      jobTemplate: {
        queue: v.queue,
        minAvailable: v.minAvailable,
        plugins: v.plugins,
        tasks: v.tasks.map((t) => {
          const requests: Record<string, string> = {};
          const limits: Record<string, string> = {};
          if (t.cpu) {
            requests['cpu'] = t.cpu;
            limits['cpu'] = t.cpu;
          }
          if (t.memory) {
            requests['memory'] = t.memory;
            limits['memory'] = t.memory;
          }
          if (t.vgpuNumber) limits['volcano.sh/vgpu-number'] = t.vgpuNumber;
          if (t.vgpuMemory) limits['volcano.sh/vgpu-memory'] = t.vgpuMemory;
          if (t.vgpuCores) limits['volcano.sh/vgpu-cores'] = t.vgpuCores;
          const hasResources =
            Object.keys(requests).length > 0 ||
            Object.keys(limits).length > 0;
          return {
            name: t.name,
            replicas: t.replicas,
            image: t.image,
            command: splitWS(t.command),
            args: splitWS(t.args),
            restartPolicy: t.restartPolicy,
            resources: hasResources
              ? {
                  requests:
                    Object.keys(requests).length > 0 ? requests : undefined,
                  limits:
                    Object.keys(limits).length > 0 ? limits : undefined,
                }
              : undefined,
          };
        }),
      },
    };
    setSubmitting(true);
    try {
      const res = await applyManifest(clusterId, buildCronJobManifest(input));
      const fail = res?.results?.find((r) => !r.success);
      if (fail) {
        message.error(fail.error ?? 'apply failed');
        return;
      }
      message.success(
        intl.formatMessage({
          id: isEdit
            ? 'pages.compute.cronJobForm.updated'
            : 'pages.compute.cronJobForm.success',
        }),
      );
      onSaved();
      onClose();
    } catch {
      // global handler
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={intl.formatMessage({
        id: isEdit
          ? 'pages.compute.cronJobForm.editTitle'
          : 'pages.compute.cronJobForm.title',
      })}
      size={760}
      maskClosable={false}
      destroyOnHidden
      footer={
        <Space style={{ float: 'right' }}>
          <Button onClick={onClose}>
            {intl.formatMessage({ id: 'pages.workloads.cancel' })}
          </Button>
          <Button type="primary" loading={submitting} onClick={handleSubmit}>
            {intl.formatMessage({
              id: isEdit
                ? 'pages.compute.cronJobForm.update'
                : 'pages.compute.cronJobForm.submit',
            })}
          </Button>
        </Space>
      }
    >
      <Spin spinning={loading}>
      <Form<FormValues> form={form} layout="vertical">
        <div style={{ marginBottom: 8, fontWeight: 500 }}>
          {intl.formatMessage({ id: 'pages.compute.jobForm.section.basic' })}
        </div>

        <Space.Compact block>
          <Form.Item
            name="name"
            label={intl.formatMessage({ id: 'pages.compute.jobForm.name' })}
            rules={[
              { required: true },
              { pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, message: 'DNS-1123' },
            ]}
            style={{ flex: 1 }}
          >
            <Input maxLength={63} placeholder="my-cronjob" disabled={isEdit} />
          </Form.Item>
          <Form.Item
            name="namespace"
            label={intl.formatMessage({
              id: 'pages.compute.jobForm.namespace',
            })}
            rules={[{ required: true }]}
            style={{ flex: 1, marginInlineStart: 12 }}
          >
            <Select
              showSearch
              placeholder="default"
              options={namespaceOptions}
              disabled={isEdit}
            />
          </Form.Item>
        </Space.Compact>

        <Space.Compact block>
          <Form.Item
            name="schedule"
            label={intl.formatMessage({
              id: 'pages.compute.cronJobForm.schedule',
            })}
            rules={[{ required: true }]}
            extra={intl.formatMessage({
              id: 'pages.compute.cronJobForm.schedule.extra',
            })}
            style={{ flex: 1 }}
          >
            <Input placeholder="0 * * * *" maxLength={64} />
          </Form.Item>
          <Form.Item
            name="concurrencyPolicy"
            label={intl.formatMessage({
              id: 'pages.compute.cronJobForm.concurrency',
            })}
            rules={[{ required: true }]}
            style={{ flex: 1, marginInlineStart: 12 }}
          >
            <Select
              options={[
                { label: 'Allow', value: 'Allow' },
                { label: 'Forbid', value: 'Forbid' },
                { label: 'Replace', value: 'Replace' },
              ]}
            />
          </Form.Item>
        </Space.Compact>

        <Space.Compact block>
          <Form.Item
            name="successfulJobsHistoryLimit"
            label={intl.formatMessage({
              id: 'pages.compute.cronJobForm.successHistory',
            })}
            style={{ flex: 1 }}
          >
            <InputNumber min={0} placeholder="3" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="failedJobsHistoryLimit"
            label={intl.formatMessage({
              id: 'pages.compute.cronJobForm.failedHistory',
            })}
            style={{ flex: 1, marginInlineStart: 12 }}
          >
            <InputNumber min={0} placeholder="1" style={{ width: '100%' }} />
          </Form.Item>
        </Space.Compact>

        <Form.Item
          name="queue"
          label={intl.formatMessage({ id: 'pages.compute.jobForm.queue' })}
          extra={intl.formatMessage({ id: 'pages.compute.jobForm.queue.extra' })}
        >
          <Input placeholder="default" maxLength={63} />
        </Form.Item>

        <Form.Item
          name="minAvailable"
          label={intl.formatMessage({
            id: 'pages.compute.jobForm.minAvailable',
          })}
          extra={intl.formatMessage({
            id: 'pages.compute.jobForm.minAvailable.extra',
          })}
        >
          <InputNumber min={1} placeholder="auto" style={{ width: 160 }} />
        </Form.Item>

        <Form.Item
          name="plugins"
          label={intl.formatMessage({ id: 'pages.compute.jobForm.plugins' })}
          extra={intl.formatMessage({
            id: 'pages.compute.jobForm.plugins.extra',
          })}
        >
          <Select
            mode="multiple"
            placeholder="env / svc / ssh / mpi"
            options={[
              { label: 'env', value: 'env' },
              { label: 'svc', value: 'svc' },
              { label: 'ssh', value: 'ssh' },
              { label: 'mpi', value: 'mpi' },
              { label: 'pytorch', value: 'pytorch' },
              { label: 'tensorflow', value: 'tensorflow' },
            ]}
          />
        </Form.Item>

        <div style={{ marginTop: 24, marginBottom: 8, fontWeight: 500 }}>
          {intl.formatMessage({ id: 'pages.compute.jobForm.section.tasks' })}
        </div>

        <Form.List name="tasks">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <Card
                  key={field.key}
                  size="small"
                  style={{ marginBottom: 12 }}
                  title={`task #${field.name + 1}`}
                  extra={
                    fields.length > 1 ? (
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<MinusCircleOutlined />}
                        onClick={() => remove(field.name)}
                      />
                    ) : null
                  }
                >
                  <Space.Compact block>
                    <Form.Item
                      name={[field.name, 'name']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.name',
                      })}
                      rules={[{ required: true }]}
                      style={{ flex: 1 }}
                    >
                      <Input maxLength={63} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'replicas']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.replicas',
                      })}
                      rules={[{ required: true }]}
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <InputNumber min={1} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'restartPolicy']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.restartPolicy',
                      })}
                      rules={[{ required: true }]}
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <Select
                        options={[
                          { label: 'OnFailure', value: 'OnFailure' },
                          { label: 'Never', value: 'Never' },
                          { label: 'Always', value: 'Always' },
                        ]}
                      />
                    </Form.Item>
                  </Space.Compact>

                  <Form.Item
                    name={[field.name, 'image']}
                    label={intl.formatMessage({
                      id: 'pages.compute.jobForm.task.image',
                    })}
                    rules={[{ required: true }]}
                  >
                    <Input
                      maxLength={512}
                      placeholder="nvcr.io/nvidia/pytorch:23.04-py3"
                    />
                  </Form.Item>

                  <Space.Compact block>
                    <Form.Item
                      name={[field.name, 'command']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.command',
                      })}
                      style={{ flex: 1 }}
                    >
                      <Input placeholder="python" />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'args']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.args',
                      })}
                      style={{ flex: 2, marginInlineStart: 12 }}
                    >
                      <Input placeholder="train.py --epochs 5" />
                    </Form.Item>
                  </Space.Compact>

                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--ant-color-text-tertiary)',
                      marginBottom: 8,
                    }}
                  >
                    {intl.formatMessage({
                      id: 'pages.compute.jobForm.task.resources',
                    })}
                  </div>
                  <Space.Compact block>
                    <Form.Item
                      name={[field.name, 'cpu']}
                      label="cpu"
                      style={{ flex: 1 }}
                    >
                      <Input placeholder="2" maxLength={32} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'memory']}
                      label="memory"
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <Input placeholder="4Gi" maxLength={32} />
                    </Form.Item>
                  </Space.Compact>
                  <Space.Compact block>
                    <Form.Item
                      name={[field.name, 'vgpuNumber']}
                      label="vgpu-number"
                      style={{ flex: 1 }}
                    >
                      <Input placeholder="1" maxLength={32} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'vgpuMemory']}
                      label="vgpu-memory"
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <Input placeholder="8000" maxLength={32} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'vgpuCores']}
                      label="vgpu-cores"
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <Input placeholder="50" maxLength={32} />
                    </Form.Item>
                  </Space.Compact>
                </Card>
              ))}
              <Button
                block
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() =>
                  add({
                    name: `task-${fields.length}`,
                    replicas: 1,
                    image: '',
                    restartPolicy: 'OnFailure',
                  })
                }
              >
                {intl.formatMessage({ id: 'pages.compute.jobForm.task.add' })}
              </Button>
            </>
          )}
        </Form.List>
      </Form>
      </Spin>
    </Drawer>
  );
}

// Mirror of JobForm's extractTasks — Volcano CronJob nests its job
// spec at .spec.jobTemplate.spec, but the tasks shape is identical.
function extractCronTasks(specTasks: any): TaskFV[] {
  if (!Array.isArray(specTasks) || specTasks.length === 0) {
    return [
      { name: 'main', replicas: 1, image: '', restartPolicy: 'OnFailure' },
    ];
  }
  return specTasks.map((t: any) => {
    const podSpec = t?.template?.spec ?? {};
    const c = (podSpec.containers ?? [])[0] ?? {};
    const r = c.resources ?? {};
    const lim = (r.limits ?? {}) as Record<string, string>;
    const req = (r.requests ?? {}) as Record<string, string>;
    return {
      name: t.name ?? 'task',
      replicas: typeof t.replicas === 'number' ? t.replicas : 1,
      image: c.image ?? '',
      command: Array.isArray(c.command) ? c.command.join(' ') : undefined,
      args: Array.isArray(c.args) ? c.args.join(' ') : undefined,
      cpu: lim['cpu'] ?? req['cpu'],
      memory: lim['memory'] ?? req['memory'],
      vgpuNumber: lim['volcano.sh/vgpu-number'],
      vgpuMemory: lim['volcano.sh/vgpu-memory'],
      vgpuCores: lim['volcano.sh/vgpu-cores'],
      restartPolicy:
        (podSpec.restartPolicy as TaskFV['restartPolicy']) ?? 'OnFailure',
    };
  });
}
