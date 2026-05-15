import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useIntl, useModel } from '@umijs/max';
import {
  Alert,
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
  Tabs,
} from 'antd';
import yaml from 'js-yaml';
import React, { useEffect, useRef, useState } from 'react';

import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';
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

interface TaskResourceRow {
  key: string;
  value: string;
}

interface TaskFV {
  name: string;
  replicas: number;
  image: string;
  // Container imagePullPolicy. Same semantics as JobForm — empty
  // means "let kubelet derive from tag"; explicit values are passed
  // through verbatim to spec.tasks[].template.spec.containers[0].
  imagePullPolicy?: '' | 'Always' | 'IfNotPresent' | 'Never';
  command?: string;
  args?: string;
  cpu?: string;
  memory?: string;
  // vGPU first-class fields — mirror JobForm. See the matching block
  // in JobForm.tsx TaskFV for the rationale; CronJob just wraps Jobs
  // so the same field set applies.
  vgpuNumber?: number;
  vgpuMemory?: number;
  vgpuCores?: number;
  // Free-form extras row matches JobForm; emitted to limits only.
  resourceExtras?: TaskResourceRow[];
  restartPolicy: 'OnFailure' | 'Never' | 'Always';
  // Per-task TaskSpec siblings, same shape as JobForm.
  topologyPolicy?:
    | 'none'
    | 'best-effort'
    | 'restricted'
    | 'single-numa-node';
  taskMaxRetry?: number;
  taskMinAvailable?: number;
}

interface FormValues {
  name: string;
  namespace: string;
  schedule: string;
  // IANA TZ name (Asia/Shanghai etc.); empty = controller-manager TZ.
  timeZone?: string;
  // Seconds; missed-trigger grace window.
  startingDeadlineSeconds?: number;
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
  const [view, setView] = useState<'form' | 'yaml'>('form');
  const [yamlText, setYamlText] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);

  const isEdit = !!editing;
  const namespaceOptions = (ns.get(clusterId).list ?? []).map((n) => ({
    label: n,
    value: n,
  }));
  // Same preservation strategy as JobForm — see comment there.
  // CronJob nests the Job spec at .spec.jobTemplate.spec, so plugins,
  // task.policies, and the multi-container / pod-level template.spec
  // preservation all live one level deeper.
  const editOriginalRef = useRef<{
    plugins?: Record<string, unknown>;
    taskPolicies?: Record<string, unknown>;
    taskExtras?: Record<
      string,
      {
        templateSpec?: any;
        dependsOn?: unknown;
        partitionPolicy?: unknown;
      }
    >;
    volumes?: unknown;
    jobPolicies?: unknown;
    schedulerName?: string;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    form.resetFields();
    setView('form');
    setYamlText('');
    setYamlError(null);
    editOriginalRef.current = null;
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
        form.setFieldsValue(
          formValuesFromManifest(obj, editing.name, editing.namespace),
        );
        const jSpec = obj?.spec?.jobTemplate?.spec ?? {};
        const taskPolicies: Record<string, unknown> = {};
        const taskExtras: Record<
          string,
          { templateSpec?: any; dependsOn?: unknown; partitionPolicy?: unknown }
        > = {};
        for (const t of (jSpec.tasks ?? []) as any[]) {
          if (!t?.name) continue;
          if (t.policies) taskPolicies[t.name] = t.policies;
          const entry: {
            templateSpec?: any;
            dependsOn?: unknown;
            partitionPolicy?: unknown;
          } = {};
          if (t.template?.spec) entry.templateSpec = t.template.spec;
          if (t.dependsOn) entry.dependsOn = t.dependsOn;
          if (t.partitionPolicy) entry.partitionPolicy = t.partitionPolicy;
          if (Object.keys(entry).length > 0) taskExtras[t.name] = entry;
        }
        editOriginalRef.current = {
          plugins:
            jSpec.plugins && typeof jSpec.plugins === 'object'
              ? jSpec.plugins
              : undefined,
          taskPolicies:
            Object.keys(taskPolicies).length > 0 ? taskPolicies : undefined,
          taskExtras:
            Object.keys(taskExtras).length > 0 ? taskExtras : undefined,
          volumes:
            Array.isArray(jSpec.volumes) && jSpec.volumes.length > 0
              ? jSpec.volumes
              : undefined,
          jobPolicies:
            Array.isArray(jSpec.policies) && jSpec.policies.length > 0
              ? jSpec.policies
              : undefined,
          schedulerName:
            typeof jSpec.schedulerName === 'string' &&
            jSpec.schedulerName !== 'volcano'
              ? jSpec.schedulerName
              : undefined,
        };
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, editing, form, ns, clusterId]);

  // applyPreserved re-emits plugin args + task.policies that the form
  // can't reconstruct. CronJob's job spec lives at
  // .spec.jobTemplate.spec, so we patch one level deeper than JobForm.
  const applyPreserved = (manifest: any) => {
    const orig = editOriginalRef.current;
    if (!orig) return manifest;
    const jSpec = manifest?.spec?.jobTemplate?.spec;
    if (!jSpec) return manifest;
    if (orig.plugins && jSpec.plugins) {
      const merged: Record<string, unknown> = {};
      for (const name of Object.keys(jSpec.plugins)) {
        merged[name] = orig.plugins[name] ?? jSpec.plugins[name];
      }
      jSpec.plugins = merged;
    }
    if (Array.isArray(jSpec.tasks)) {
      jSpec.tasks = jSpec.tasks.map((t: any) => {
        const policies = orig.taskPolicies?.[t.name];
        const extras = orig.taskExtras?.[t.name];
        let next = t;
        if (policies !== undefined) next = { ...next, policies };
        if (extras) {
          if (extras.templateSpec) {
            const built = next.template?.spec ?? {};
            const original = extras.templateSpec;
            const mergedContainers = [
              built.containers?.[0] ?? original.containers?.[0],
              ...((original.containers ?? []).slice(1) as any[]),
            ];
            next = {
              ...next,
              template: {
                ...(next.template ?? {}),
                spec: {
                  ...original,
                  schedulerName: built.schedulerName ?? original.schedulerName,
                  restartPolicy: built.restartPolicy ?? original.restartPolicy,
                  containers: mergedContainers,
                },
              },
            };
          }
          if (extras.dependsOn !== undefined) {
            next = { ...next, dependsOn: extras.dependsOn };
          }
          if (extras.partitionPolicy !== undefined) {
            next = { ...next, partitionPolicy: extras.partitionPolicy };
          }
        }
        return next;
      });
    }
    if (orig.volumes) jSpec.volumes = orig.volumes;
    if (orig.jobPolicies) jSpec.policies = orig.jobPolicies;
    if (orig.schedulerName) jSpec.schedulerName = orig.schedulerName;
    return manifest;
  };

  const handleSwitchView = (next: string) => {
    if (next === view) return;
    if (next === 'yaml') {
      const fv = form.getFieldsValue();
      try {
        const manifest = applyPreserved(buildCronJobManifest(fvToInput(fv)));
        setYamlText(yaml.dump(manifest));
        setYamlError(null);
        setView('yaml');
      } catch (e: any) {
        setYamlError(String(e?.message ?? e));
      }
    } else {
      try {
        const parsed = yaml.load(yamlText) as any;
        if (!parsed || typeof parsed !== 'object') {
          setYamlError('YAML is empty or not an object');
          return;
        }
        const meta = parsed?.metadata ?? {};
        form.setFieldsValue(
          formValuesFromManifest(
            parsed,
            meta.name ?? form.getFieldValue('name'),
            meta.namespace ?? form.getFieldValue('namespace') ?? 'default',
          ),
        );
        setYamlError(null);
        setView('form');
      } catch (e: any) {
        setYamlError(String(e?.message ?? e));
      }
    }
  };

  const handleSubmit = async () => {
    if (view === 'yaml') {
      let manifest: unknown;
      try {
        manifest = yaml.load(yamlText);
      } catch (e: any) {
        message.error(`YAML parse failed: ${e?.message ?? e}`);
        return;
      }
      if (!manifest || typeof manifest !== 'object') {
        message.error('YAML is empty or not an object');
        return;
      }
      await applyAndFinish(manifest);
      return;
    }
    let v: FormValues;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    await applyAndFinish(applyPreserved(buildCronJobManifest(fvToInput(v))));
  };

  // applyAndFinish ships an already-built manifest. Used by both the
  // form-view submit path (manifest = buildCronJobManifest(...)) and
  // the YAML-view path (manifest = yaml.load(yamlText)).
  async function applyAndFinish(manifest: unknown) {
    setSubmitting(true);
    try {
      const res = await applyManifest(clusterId, manifest);
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
  }

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
      <Tabs
        activeKey={view}
        onChange={handleSwitchView}
        size="small"
        style={{ marginBottom: 12 }}
        items={[
          {
            key: 'form',
            label: intl.formatMessage({ id: 'pages.compute.form.tab.form' }),
          },
          {
            key: 'yaml',
            label: intl.formatMessage({ id: 'pages.compute.form.tab.yaml' }),
          },
        ]}
      />
      {yamlError && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setYamlError(null)}
          style={{ marginBottom: 12 }}
          message={intl.formatMessage({ id: 'pages.compute.form.yamlError' })}
          description={yamlError}
        />
      )}
      <Spin spinning={loading}>
        {view === 'yaml' ? (
          <div
            style={{
              border: '1px solid var(--ant-color-border)',
              borderRadius: 4,
            }}
          >
            <YamlEditor value={yamlText} onChange={setYamlText} />
          </div>
        ) : (
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
            name="timeZone"
            label={intl.formatMessage({
              id: 'pages.compute.cronJobForm.timeZone',
            })}
            extra={intl.formatMessage({
              id: 'pages.compute.cronJobForm.timeZone.extra',
            })}
            style={{ flex: 1 }}
          >
            <Input placeholder="Asia/Shanghai" maxLength={64} />
          </Form.Item>
          <Form.Item
            name="startingDeadlineSeconds"
            label={intl.formatMessage({
              id: 'pages.compute.cronJobForm.startingDeadline',
            })}
            extra={intl.formatMessage({
              id: 'pages.compute.cronJobForm.startingDeadline.extra',
            })}
            style={{ flex: 1, marginInlineStart: 12 }}
          >
            <InputNumber
              min={0}
              placeholder="无 / no deadline"
              style={{ width: '100%' }}
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

                  <Space.Compact block>
                    <Form.Item
                      name={[field.name, 'taskMinAvailable']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.minAvailable',
                      })}
                      tooltip={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.minAvailable.tip',
                      })}
                      style={{ flex: 1 }}
                    >
                      <InputNumber
                        min={0}
                        placeholder="= replicas"
                        style={{ width: '100%' }}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'taskMaxRetry']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.maxRetry',
                      })}
                      tooltip={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.maxRetry.tip',
                      })}
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <InputNumber
                        min={0}
                        placeholder="3"
                        style={{ width: '100%' }}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'topologyPolicy']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.topologyPolicy',
                      })}
                      tooltip={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.topologyPolicy.tip',
                      })}
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <Select
                        allowClear
                        placeholder={intl.formatMessage({
                          id: 'pages.compute.jobForm.task.topologyPolicy.placeholder',
                        })}
                        options={[
                          { label: 'none', value: 'none' },
                          { label: 'best-effort', value: 'best-effort' },
                          { label: 'restricted', value: 'restricted' },
                          {
                            label: 'single-numa-node',
                            value: 'single-numa-node',
                          },
                        ]}
                      />
                    </Form.Item>
                  </Space.Compact>

                  <Space.Compact block>
                    <Form.Item
                      name={[field.name, 'image']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.image',
                      })}
                      rules={[{ required: true }]}
                      style={{ flex: 3 }}
                    >
                      <Input
                        maxLength={512}
                        placeholder="nvcr.io/nvidia/pytorch:23.04-py3"
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'imagePullPolicy']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.imagePullPolicy',
                      })}
                      tooltip={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.imagePullPolicy.tip',
                      })}
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <Select
                        allowClear
                        placeholder={intl.formatMessage({
                          id: 'pages.compute.jobForm.task.imagePullPolicy.placeholder',
                        })}
                        options={[
                          { label: 'IfNotPresent', value: 'IfNotPresent' },
                          { label: 'Always', value: 'Always' },
                          { label: 'Never', value: 'Never' },
                        ]}
                      />
                    </Form.Item>
                  </Space.Compact>

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
                  {/* GPU 三件套 — 同 JobForm，留空整组就不申请 GPU。 */}
                  <Space.Compact block style={{ marginTop: 4 }}>
                    <Form.Item
                      name={[field.name, 'vgpuNumber']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.gpu.number',
                      })}
                      tooltip={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.gpu.number.tip',
                      })}
                      style={{ flex: 1 }}
                    >
                      <InputNumber
                        min={0}
                        precision={0}
                        placeholder="1"
                        style={{ width: '100%' }}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'vgpuMemory']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.gpu.memory',
                      })}
                      tooltip={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.gpu.memory.tip',
                      })}
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <InputNumber
                        min={0}
                        precision={0}
                        placeholder="3000"
                        addonAfter="MiB"
                        style={{ width: '100%' }}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'vgpuCores']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.gpu.cores',
                      })}
                      tooltip={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.gpu.cores.tip',
                      })}
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <InputNumber
                        min={0}
                        max={100}
                        precision={0}
                        placeholder="50"
                        addonAfter="%"
                        style={{ width: '100%' }}
                      />
                    </Form.Item>
                  </Space.Compact>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--ant-color-text-tertiary)',
                      margin: '4px 0 6px',
                    }}
                  >
                    {intl.formatMessage({
                      id: 'pages.compute.jobForm.task.resources.extras',
                    })}
                  </div>
                  <Form.List name={[field.name, 'resourceExtras']}>
                    {(rfields, { add: addR, remove: rmR }) => (
                      <>
                        {rfields.map((rf) => (
                          <Space
                            key={rf.key}
                            style={{ display: 'flex', marginBottom: 8 }}
                            align="baseline"
                          >
                            <Form.Item
                              name={[rf.name, 'key']}
                              rules={[{ required: true }]}
                              style={{ marginBottom: 0 }}
                            >
                              <Input
                                placeholder="nvidia.com/gpu / ephemeral-storage / ..."
                                style={{ width: 280 }}
                              />
                            </Form.Item>
                            <Form.Item
                              name={[rf.name, 'value']}
                              rules={[{ required: true }]}
                              style={{ marginBottom: 0 }}
                            >
                              <Input
                                placeholder="1 / 8000"
                                style={{ width: 140 }}
                              />
                            </Form.Item>
                            <MinusCircleOutlined onClick={() => rmR(rf.name)} />
                          </Space>
                        ))}
                        <Button
                          type="dashed"
                          size="small"
                          onClick={() => addR({ key: '', value: '' })}
                          icon={<PlusOutlined />}
                        >
                          {intl.formatMessage({
                            id: 'pages.compute.jobForm.task.resources.extras.add',
                          })}
                        </Button>
                      </>
                    )}
                  </Form.List>
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
        )}
      </Spin>
    </Drawer>
  );
}

// splitWS — single string → arg array. Empty → undefined.
function splitWS(s: string | undefined): string[] | undefined {
  if (!s || !s.trim()) return undefined;
  return s.trim().split(/\s+/);
}

// fvToInput translates flat form values to the CronJobInput shape that
// buildCronJobManifest expects. Mirror of JobForm's fvToInput, plus
// the cron-specific schedule + history-limit + suspend fields. Trims
// every user-typed string for the same reason JobForm does.
function fvToInput(v: FormValues): CronJobInput {
  const tr = (s?: string) => s?.trim() || undefined;
  return {
    name: tr(v.name) ?? '',
    namespace: tr(v.namespace) ?? 'default',
    schedule: tr(v.schedule) ?? '0 * * * *',
    timeZone: tr(v.timeZone),
    startingDeadlineSeconds:
      typeof v.startingDeadlineSeconds === 'number'
        ? v.startingDeadlineSeconds
        : undefined,
    concurrencyPolicy: v.concurrencyPolicy ?? 'Allow',
    successfulJobsHistoryLimit: v.successfulJobsHistoryLimit,
    failedJobsHistoryLimit: v.failedJobsHistoryLimit,
    suspend: v.suspend,
    jobTemplate: {
      queue: tr(v.queue),
      minAvailable: v.minAvailable,
      plugins: v.plugins,
      tasks: (v.tasks ?? []).map((t) => {
        const cpu = tr(t.cpu);
        const memory = tr(t.memory);
        const requests: Record<string, string> = {};
        const limits: Record<string, string> = {};
        if (cpu) {
          requests['cpu'] = cpu;
          limits['cpu'] = cpu;
        }
        if (memory) {
          requests['memory'] = memory;
          limits['memory'] = memory;
        }
        // vGPU native fields → limits (see JobForm for the rationale).
        if (typeof t.vgpuNumber === 'number' && t.vgpuNumber > 0) {
          limits['volcano.sh/vgpu-number'] = String(t.vgpuNumber);
        }
        if (typeof t.vgpuMemory === 'number' && t.vgpuMemory > 0) {
          limits['volcano.sh/vgpu-memory'] = String(t.vgpuMemory);
        }
        if (typeof t.vgpuCores === 'number' && t.vgpuCores > 0) {
          limits['volcano.sh/vgpu-cores'] = String(t.vgpuCores);
        }
        const HANDLED = new Set([
          'cpu',
          'memory',
          'volcano.sh/vgpu-number',
          'volcano.sh/vgpu-memory',
          'volcano.sh/vgpu-cores',
        ]);
        for (const row of t.resourceExtras ?? []) {
          const k = row?.key?.trim();
          const val = row?.value?.trim();
          if (k && val && !HANDLED.has(k)) limits[k] = val;
        }
        const hasResources =
          Object.keys(requests).length > 0 || Object.keys(limits).length > 0;
        return {
          name: tr(t.name) ?? 'task',
          replicas: t.replicas,
          image: tr(t.image) ?? '',
          // Same Auto → undefined collapse as JobForm.
          imagePullPolicy: t.imagePullPolicy || undefined,
          command: splitWS(t.command),
          args: splitWS(t.args),
          restartPolicy: t.restartPolicy,
          resources: hasResources
            ? {
                requests:
                  Object.keys(requests).length > 0 ? requests : undefined,
                limits: Object.keys(limits).length > 0 ? limits : undefined,
              }
            : undefined,
          minAvailable:
            typeof t.taskMinAvailable === 'number'
              ? t.taskMinAvailable
              : undefined,
          maxRetry:
            typeof t.taskMaxRetry === 'number' ? t.taskMaxRetry : undefined,
          topologyPolicy: t.topologyPolicy,
        };
      }),
    },
  };
}

// formValuesFromManifest reverses fvToInput / buildCronJobManifest for
// edit-mode load and YAML → form switch. Reads .spec.jobTemplate.spec
// for the inner Job's fields (Volcano CronJob wraps a Job spec there).
function formValuesFromManifest(
  obj: any,
  fallbackName: string,
  fallbackNamespace: string,
): FormValues {
  const spec = obj?.spec ?? {};
  const jSpec = spec.jobTemplate?.spec ?? {};
  return {
    name: obj?.metadata?.name ?? fallbackName,
    namespace: obj?.metadata?.namespace ?? fallbackNamespace,
    schedule: spec.schedule ?? '0 * * * *',
    timeZone: spec.timeZone ?? undefined,
    startingDeadlineSeconds:
      typeof spec.startingDeadlineSeconds === 'number'
        ? spec.startingDeadlineSeconds
        : undefined,
    concurrencyPolicy: spec.concurrencyPolicy ?? 'Allow',
    successfulJobsHistoryLimit: spec.successfulJobsHistoryLimit,
    failedJobsHistoryLimit: spec.failedJobsHistoryLimit,
    suspend: spec.suspend ?? false,
    queue: jSpec.queue,
    minAvailable:
      typeof jSpec.minAvailable === 'number' ? jSpec.minAvailable : undefined,
    plugins: jSpec.plugins ? Object.keys(jSpec.plugins) : undefined,
    tasks: extractCronTasks(jSpec.tasks),
  };
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
    // Same cpu/memory + vgpu-* + everything-else split as JobForm.
    // Union of limits + requests so single-sided keys survive edit.
    const NATIVE = new Set([
      'cpu',
      'memory',
      'volcano.sh/vgpu-number',
      'volcano.sh/vgpu-memory',
      'volcano.sh/vgpu-cores',
    ]);
    const extras: TaskResourceRow[] = [];
    const seen = new Set<string>(NATIVE);
    for (const [k, v] of Object.entries(lim)) {
      if (seen.has(k)) continue;
      extras.push({ key: k, value: typeof v === 'string' ? v : String(v) });
      seen.add(k);
    }
    for (const [k, v] of Object.entries(req)) {
      if (seen.has(k)) continue;
      extras.push({ key: k, value: typeof v === 'string' ? v : String(v) });
      seen.add(k);
    }
    const num = (s?: string): number | undefined => {
      if (!s) return undefined;
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : undefined;
    };
    return {
      name: t.name ?? 'task',
      replicas: typeof t.replicas === 'number' ? t.replicas : 1,
      image: c.image ?? '',
      imagePullPolicy:
        c.imagePullPolicy === 'Always' ||
        c.imagePullPolicy === 'IfNotPresent' ||
        c.imagePullPolicy === 'Never'
          ? c.imagePullPolicy
          : undefined,
      command: Array.isArray(c.command) ? c.command.join(' ') : undefined,
      args: Array.isArray(c.args) ? c.args.join(' ') : undefined,
      cpu: lim['cpu'] ?? req['cpu'],
      memory: lim['memory'] ?? req['memory'],
      vgpuNumber: num(lim['volcano.sh/vgpu-number'] ?? req['volcano.sh/vgpu-number']),
      vgpuMemory: num(lim['volcano.sh/vgpu-memory'] ?? req['volcano.sh/vgpu-memory']),
      vgpuCores: num(lim['volcano.sh/vgpu-cores'] ?? req['volcano.sh/vgpu-cores']),
      resourceExtras: extras,
      restartPolicy:
        (podSpec.restartPolicy as TaskFV['restartPolicy']) ?? 'OnFailure',
      taskMinAvailable:
        typeof t.minAvailable === 'number' ? t.minAvailable : undefined,
      taskMaxRetry:
        typeof t.maxRetry === 'number' ? t.maxRetry : undefined,
      topologyPolicy: t.topologyPolicy as TaskFV['topologyPolicy'],
    };
  });
}
