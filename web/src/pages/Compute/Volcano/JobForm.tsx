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
  buildJobManifest,
  type JobInput,
} from '@/services/kpilot/volcano';
import { getWorkload } from '@/services/kpilot/workload';

interface JobFormDrawerProps {
  open: boolean;
  clusterId: string;
  // Edit mode: fetch the named Job, populate, freeze name + namespace.
  editing?: { name: string; namespace: string } | null;
  onClose: () => void;
  onSaved: () => void;
}

const JOB_CR = {
  group: 'batch.volcano.sh',
  version: 'v1alpha1',
  kind: 'Job',
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
  // Container imagePullPolicy. Empty string = "auto" (let kubelet
  // derive from tag); explicit values are Always / IfNotPresent /
  // Never. Stored as the literal string Volcano expects so YAML
  // round-trip is byte-exact.
  imagePullPolicy?: '' | 'Always' | 'IfNotPresent' | 'Never';
  command?: string;       // single string, split on whitespace
  args?: string;          // ditto
  // Fixed cpu / memory inputs — used in almost every batch job.
  // cpu/memory are emitted into BOTH requests and limits (same
  // value) since gang-scheduled batch usually wants reservations.
  cpu?: string;
  memory?: string;
  // Free-form extra resources (extended resources / GPUs / ephemeral-
  // storage / hugepages-*). Emitted into limits only — extended
  // resources require requests == limits per K8s convention, and
  // K8s mirrors limit → request automatically when only limit is set.
  resourceExtras?: TaskResourceRow[];
  restartPolicy: 'OnFailure' | 'Never' | 'Always';
  // Per-task knobs that exist as TaskSpec siblings in upstream.
  // Separate from job-level fields with the same name (e.g. the
  // job-level minAvailable spans all tasks; this one is just for
  // this task's pods).
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
  queue?: string;
  priorityClassName?: string;
  minAvailable?: number;
  // Advanced gating: how many pods must Succeed for the Job to be
  // marked Complete (Volcano default is task replicas).
  minSuccess?: number;
  // Max retries before the Job is marked Failed (default 3).
  maxRetry?: number;
  // Auto-delete window after the Job reaches a terminal state.
  ttlSecondsAfterFinished?: number;
  // Go duration string ("1h30m"); hint consumed by sla plugin.
  runningEstimate?: string;
  plugins?: string[];
  tasks: TaskFV[];
  // NetworkTopology (works with HyperNode CRD) — same shape as
  // PodGroupForm.
  ntMode?: 'hard' | 'soft' | '';
  ntHighestTierAllowed?: number;
  ntHighestTierName?: string;
}

// JobFormDrawer constructs a Volcano Job (`batch.volcano.sh/v1alpha1`).
// One drawer covers the realistic v1 use-case set:
//   • basic identity (name + namespace + queue + priority)
//   • gang sizing (minAvailable; defaults to sum of task replicas)
//   • Volcano plugins (env / svc / ssh / mpi — checkbox list)
//   • one or more tasks: replicas + image + command + resources
//
// We don't expose every Volcano knob (tolerations, affinity, podgroup
// overrides, lifecycle policies, ...) — those rare cases stay on the
// Apply YAML drawer. Goal here is the 90% submit-a-batch path.
export function JobFormDrawer({
  open,
  clusterId,
  editing,
  onClose,
  onSaved,
}: JobFormDrawerProps) {
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
  // editOriginalRef preserves the bits of an edited Job's spec that
  // the form doesn't surface so submit can re-emit them instead of
  // silently dropping them. Beyond plugin args + per-task policies,
  // upstream JobSpec also has volumes (PV/PVC mounts), job-level
  // policies (lifecycle reactions), and a custom schedulerName the
  // user might have set (we hardcode "volcano" in our builder so
  // anything else would be lost on edit).
  //
  // taskExtras (keyed by task name) preserves *per-task* fields the
  // form doesn't render: the full original template.spec (so
  // multi-container tasks, pod-level affinity / tolerations /
  // nodeSelector / initContainers / volumes mounts all survive
  // round-trip), plus TaskSpec siblings dependsOn / partitionPolicy
  // that the form has no inputs for. On submit applyPreserved
  // overlays our freshly-built containers[0] + restartPolicy +
  // schedulerName onto the preserved template.spec.
  //
  // Cleared on every drawer (re)open and on create-mode entry.
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

  // Snapshot of the FormValues at edit-load time so we can diff on
  // submit and tell the user *which* immutable fields they touched.
  // Volcano's validating webhook ("validatejob.volcano.sh") rejects
  // any Job update that changes anything other than minAvailable,
  // tasks[*].replicas, or priorityClassName — silently saving and
  // hitting that webhook produces an unhelpful error string. We
  // pre-check here so the user gets actionable inline feedback.
  const editOriginalFVRef = useRef<FormValues | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    form.resetFields();
    setView('form');
    setYamlText('');
    setYamlError(null);
    editOriginalRef.current = null;
    editOriginalFVRef.current = null;
    if (!editing) {
      form.setFieldsValue({
        namespace: ns.get(clusterId).selected || 'default',
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
    getWorkload(clusterId, '_cr', editing.name, editing.namespace, JOB_CR)
      .then((obj: any) => {
        if (cancelled) return;
        const fv = formValuesFromManifest(obj, editing.name, editing.namespace);
        form.setFieldsValue(fv);
        // Snapshot the pristine FormValues so the immutable-fields
        // diff at submit time can compare against what the server
        // actually has, not against the user's draft.
        editOriginalFVRef.current = JSON.parse(JSON.stringify(fv));
        // Stash the spec bits the form doesn't surface so submit can
        // re-emit them: plugin args (`spec.plugins[name] = [...]`) and
        // each task's `policies` array. Without this, edit-save silently
        // drops e.g. ssh plugin args or RestartTask-on-PodFailed policies.
        const spec = obj?.spec ?? {};
        const taskPolicies: Record<string, unknown> = {};
        const taskExtras: Record<
          string,
          { templateSpec?: any; dependsOn?: unknown; partitionPolicy?: unknown }
        > = {};
        for (const t of (spec.tasks ?? []) as any[]) {
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
            spec.plugins && typeof spec.plugins === 'object'
              ? spec.plugins
              : undefined,
          taskPolicies:
            Object.keys(taskPolicies).length > 0 ? taskPolicies : undefined,
          taskExtras:
            Object.keys(taskExtras).length > 0 ? taskExtras : undefined,
          volumes:
            Array.isArray(spec.volumes) && spec.volumes.length > 0
              ? spec.volumes
              : undefined,
          jobPolicies:
            Array.isArray(spec.policies) && spec.policies.length > 0
              ? spec.policies
              : undefined,
          // Only preserve if user has customized away from "volcano"
          // — the builder always emits "volcano" so an exact match
          // doesn't need round-trip protection.
          schedulerName:
            typeof spec.schedulerName === 'string' &&
            spec.schedulerName !== 'volcano'
              ? spec.schedulerName
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

  // applyPreserved patches a freshly-built manifest with fields the
  // form path can't reconstruct (plugin args + task.policies). Called
  // only in edit mode + form-view submit; YAML-view submit takes the
  // user's typed text as-is.
  const applyPreserved = (manifest: any) => {
    const orig = editOriginalRef.current;
    if (!orig) return manifest;
    if (orig.plugins && manifest?.spec?.plugins) {
      const merged: Record<string, unknown> = {};
      for (const name of Object.keys(manifest.spec.plugins)) {
        merged[name] = orig.plugins[name] ?? manifest.spec.plugins[name];
      }
      manifest.spec.plugins = merged;
    }
    if (Array.isArray(manifest?.spec?.tasks)) {
      manifest.spec.tasks = manifest.spec.tasks.map((t: any) => {
        const policies = orig.taskPolicies?.[t.name];
        const extras = orig.taskExtras?.[t.name];
        let next = t;
        if (policies !== undefined) next = { ...next, policies };
        if (extras) {
          // Overlay our freshly-built container[0] + restartPolicy +
          // schedulerName onto the original template.spec so multi-
          // container tasks and pod-level fields (affinity / toler-
          // ations / initContainers / volume mounts / nodeSelector /
          // securityContext / dnsPolicy / ...) survive round-trip
          // even though the form only renders the first container.
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
          // Sibling TaskSpec fields the form has no inputs for.
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
    if (orig.volumes) manifest.spec.volumes = orig.volumes;
    if (orig.jobPolicies) manifest.spec.policies = orig.jobPolicies;
    if (orig.schedulerName) manifest.spec.schedulerName = orig.schedulerName;
    return manifest;
  };

  const handleSwitchView = (next: string) => {
    if (next === view) return;
    if (next === 'yaml') {
      const fv = form.getFieldsValue();
      try {
        const manifest = applyPreserved(buildJobManifest(fvToInput(fv)));
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
            meta.namespace ??
              form.getFieldValue('namespace') ??
              'default',
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
    let manifest: unknown;
    if (view === 'form') {
      let v: FormValues;
      try {
        v = await form.validateFields();
      } catch {
        return;
      }
      // Edit-mode pre-flight: Volcano's validatejob webhook rejects
      // any update touching fields outside minAvailable / task
      // replicas / priorityClassName. Catch that here so the user
      // sees a clear "you changed image/policy/…" message instead
      // of the webhook's terse rejection after a round-trip.
      if (isEdit && editOriginalFVRef.current) {
        const violations = diffImmutable(editOriginalFVRef.current, v);
        if (violations.length > 0) {
          message.error(
            intl.formatMessage(
              { id: 'pages.compute.jobForm.immutable.violation' },
              { fields: violations.join(', ') },
            ),
          );
          return;
        }
      }
      manifest = applyPreserved(buildJobManifest(fvToInput(v)));
    } else {
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
    }
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
            ? 'pages.compute.jobForm.updated'
            : 'pages.compute.jobForm.success',
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
          ? 'pages.compute.jobForm.editTitle'
          : 'pages.compute.jobForm.title',
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
                ? 'pages.compute.jobForm.update'
                : 'pages.compute.jobForm.submit',
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
      {/* Volcano Jobs are mostly immutable post-create — calling
          this out up front spares the user from clicking Update,
          waiting for the round-trip, and getting the webhook's
          generic "fields other than minAvailable / replicas /
          PriorityClassName may not change" rejection. */}
      {isEdit && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={intl.formatMessage({
            id: 'pages.compute.jobForm.immutable.banner.title',
          })}
          description={intl.formatMessage({
            id: 'pages.compute.jobForm.immutable.banner.desc',
          })}
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

        <Space.Compact block style={{ marginBottom: 0 }}>
          <Form.Item
            name="name"
            label={intl.formatMessage({ id: 'pages.compute.jobForm.name' })}
            rules={[
              { required: true },
              {
                pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
                message: 'DNS-1123',
              },
            ]}
            style={{ flex: 1 }}
          >
            <Input maxLength={63} placeholder="my-job" disabled={isEdit} />
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
            name="queue"
            label={intl.formatMessage({ id: 'pages.compute.jobForm.queue' })}
            extra={intl.formatMessage({
              id: 'pages.compute.jobForm.queue.extra',
            })}
            style={{ flex: 1 }}
          >
            <Input placeholder="default" maxLength={63} />
          </Form.Item>
          <Form.Item
            name="priorityClassName"
            label={intl.formatMessage({
              id: 'pages.compute.jobForm.priority',
            })}
            style={{ flex: 1, marginInlineStart: 12 }}
          >
            <Input maxLength={253} placeholder="" />
          </Form.Item>
        </Space.Compact>

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
          name="minSuccess"
          label={intl.formatMessage({
            id: 'pages.compute.jobForm.minSuccess',
          })}
          extra={intl.formatMessage({
            id: 'pages.compute.jobForm.minSuccess.extra',
          })}
        >
          <InputNumber min={1} placeholder="auto" style={{ width: 160 }} />
        </Form.Item>

        <Form.Item
          name="maxRetry"
          label={intl.formatMessage({
            id: 'pages.compute.jobForm.maxRetry',
          })}
          extra={intl.formatMessage({
            id: 'pages.compute.jobForm.maxRetry.extra',
          })}
        >
          <InputNumber min={0} placeholder="3" style={{ width: 160 }} />
        </Form.Item>

        <Form.Item
          name="ttlSecondsAfterFinished"
          label={intl.formatMessage({
            id: 'pages.compute.jobForm.ttl',
          })}
          extra={intl.formatMessage({
            id: 'pages.compute.jobForm.ttl.extra',
          })}
        >
          <InputNumber
            min={0}
            placeholder="无 / never"
            style={{ width: 200 }}
          />
        </Form.Item>

        <Form.Item
          name="runningEstimate"
          label={intl.formatMessage({
            id: 'pages.compute.jobForm.runningEstimate',
          })}
          extra={intl.formatMessage({
            id: 'pages.compute.jobForm.runningEstimate.extra',
          })}
        >
          <Input placeholder="1h30m" style={{ width: 200 }} maxLength={64} />
        </Form.Item>

        <Form.Item
          name="plugins"
          label={intl.formatMessage({
            id: 'pages.compute.jobForm.plugins',
          })}
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

        <div
          style={{ marginTop: 16, marginBottom: 4, fontWeight: 500 }}
        >
          {intl.formatMessage({
            id: 'pages.compute.jobForm.networkTopology',
          })}
        </div>
        <div
          style={{
            marginBottom: 8,
            color: 'var(--ant-color-text-tertiary)',
            fontSize: 12,
          }}
        >
          {intl.formatMessage({
            id: 'pages.compute.jobForm.networkTopology.extra',
          })}
        </div>
        <Form.Item
          name="ntMode"
          label={intl.formatMessage({
            id: 'pages.compute.jobForm.ntMode',
          })}
        >
          <Select
            allowClear
            placeholder={intl.formatMessage({
              id: 'pages.compute.jobForm.ntMode.placeholder',
            })}
            style={{ width: 200 }}
            options={[
              { value: 'hard', label: 'hard' },
              { value: 'soft', label: 'soft' },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="ntHighestTierAllowed"
          label={intl.formatMessage({
            id: 'pages.compute.jobForm.ntTierAllowed',
          })}
        >
          <InputNumber min={0} style={{ width: 160 }} />
        </Form.Item>
        <Form.Item
          name="ntHighestTierName"
          label={intl.formatMessage({
            id: 'pages.compute.jobForm.ntTierName',
          })}
        >
          <Input maxLength={253} />
        </Form.Item>

        <div
          style={{
            marginTop: 24,
            marginBottom: 8,
            fontWeight: 500,
          }}
        >
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
                                placeholder="nvidia.com/gpu / volcano.sh/vgpu-number"
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
                {intl.formatMessage({
                  id: 'pages.compute.jobForm.task.add',
                })}
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

// diffImmutable — returns a human-readable list of FormValues
// fields that changed between `orig` and `curr`, ignoring the
// three Volcano allows on update (job-level minAvailable, each
// task's replicas, priorityClassName). Used by the edit-mode
// pre-flight in handleSubmit so the user is told *which* field
// is immutable instead of relying on the webhook's terse error.
//
// The comparison is structural (JSON-equality on each non-allowed
// top-level key + per-task non-allowed key) — sufficient because
// formValuesFromManifest emits a deterministic shape.
function diffImmutable(orig: FormValues, curr: FormValues): string[] {
  const out: string[] = [];
  const eq = (a: unknown, b: unknown) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const jobKeys: (keyof FormValues)[] = [
    'name',
    'namespace',
    'queue',
    'minSuccess',
    'maxRetry',
    'ttlSecondsAfterFinished',
    'runningEstimate',
    'plugins',
    'ntMode',
    'ntHighestTierAllowed',
  ];
  for (const k of jobKeys) {
    if (!eq(orig[k], curr[k])) out.push(String(k));
  }
  // Tasks: name + replicas-aside fields per task must match. Match
  // tasks by name; if the list itself was added/removed/reordered,
  // that counts as a structure change.
  const oTasks = orig.tasks ?? [];
  const cTasks = curr.tasks ?? [];
  if (oTasks.length !== cTasks.length) {
    out.push('tasks (count)');
  } else {
    for (let i = 0; i < oTasks.length; i++) {
      const o = oTasks[i] as unknown as Record<string, unknown>;
      const c = cTasks[i] as unknown as Record<string, unknown>;
      // Allowed mutable per-task field is replicas only — diff
      // everything else.
      const keys = new Set([...Object.keys(o), ...Object.keys(c)]);
      keys.delete('replicas');
      for (const k of keys) {
        if (!eq(o[k], c[k])) {
          out.push(`tasks[${i}].${k}`);
        }
      }
    }
  }
  return out;
}

// splitWS — single string → arg array. Empty → undefined.
function splitWS(s: string | undefined): string[] | undefined {
  if (!s || !s.trim()) return undefined;
  return s.trim().split(/\s+/);
}

// fvToInput — translates the form's flat shape into the JobInput
// contract that buildJobManifest expects. Trims every user-typed
// string so trailing whitespace doesn't trip K8s resource-quantity
// parsing or image lookups.
function fvToInput(v: FormValues): JobInput {
  const tr = (s?: string) => s?.trim() || undefined;
  return {
    name: tr(v.name) ?? '',
    namespace: tr(v.namespace) ?? 'default',
    queue: tr(v.queue),
    priorityClassName: tr(v.priorityClassName),
    minAvailable: v.minAvailable,
    minSuccess: typeof v.minSuccess === 'number' ? v.minSuccess : undefined,
    maxRetry: typeof v.maxRetry === 'number' ? v.maxRetry : undefined,
    ttlSecondsAfterFinished:
      typeof v.ttlSecondsAfterFinished === 'number'
        ? v.ttlSecondsAfterFinished
        : undefined,
    runningEstimate: tr(v.runningEstimate),
    networkTopologyMode:
      v.ntMode === 'hard' || v.ntMode === 'soft' ? v.ntMode : undefined,
    networkTopologyHighestTierAllowed:
      typeof v.ntHighestTierAllowed === 'number'
        ? v.ntHighestTierAllowed
        : undefined,
    networkTopologyHighestTierName: tr(v.ntHighestTierName),
    plugins: v.plugins,
    tasks: (v.tasks ?? []).map((t) => {
      const cpu = tr(t.cpu);
      const memory = tr(t.memory);
      const requests: Record<string, string> = {};
      const limits: Record<string, string> = {};
      // cpu / memory go into both halves so gang-scheduled batch
      // jobs get the reservation they implicitly expect.
      if (cpu) {
        requests['cpu'] = cpu;
        limits['cpu'] = cpu;
      }
      if (memory) {
        requests['memory'] = memory;
        limits['memory'] = memory;
      }
      // Free-form extras (GPU / extended resources / ephemeral-storage
      // / hugepages-* / ...) land only in limits — K8s mirrors limit
      // → request automatically for extended resources, and that's
      // the convention upstream Volcano docs follow too.
      for (const row of t.resourceExtras ?? []) {
        const k = row?.key?.trim();
        const val = row?.value?.trim();
        if (k && val && k !== 'cpu' && k !== 'memory') limits[k] = val;
      }
      const hasResources =
        Object.keys(requests).length > 0 || Object.keys(limits).length > 0;
      return {
        name: tr(t.name) ?? 'task',
        replicas: t.replicas,
        image: tr(t.image) ?? '',
        // Empty string === user hasn't picked a value === "Auto"; drop
        // it so the builder doesn't emit imagePullPolicy:"" (invalid).
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
  };
}

// formValuesFromManifest — reverse of fvToInput / buildJobManifest.
// Used both on edit-mode load and on YAML → form switch.
function formValuesFromManifest(
  obj: any,
  fallbackName: string,
  fallbackNamespace: string,
): FormValues {
  const spec = obj?.spec ?? {};
  const nt = spec.networkTopology ?? {};
  return {
    name: obj?.metadata?.name ?? fallbackName,
    namespace: obj?.metadata?.namespace ?? fallbackNamespace,
    queue: spec.queue,
    priorityClassName: spec.priorityClassName,
    minAvailable:
      typeof spec.minAvailable === 'number' ? spec.minAvailable : undefined,
    minSuccess:
      typeof spec.minSuccess === 'number' ? spec.minSuccess : undefined,
    maxRetry: typeof spec.maxRetry === 'number' ? spec.maxRetry : undefined,
    ttlSecondsAfterFinished:
      typeof spec.ttlSecondsAfterFinished === 'number'
        ? spec.ttlSecondsAfterFinished
        : undefined,
    runningEstimate: spec.runningEstimate ?? undefined,
    ntMode:
      nt.mode === 'hard' || nt.mode === 'soft' ? nt.mode : undefined,
    ntHighestTierAllowed:
      typeof nt.highestTierAllowed === 'number'
        ? nt.highestTierAllowed
        : undefined,
    ntHighestTierName: nt.highestTierName ?? undefined,
    plugins: spec.plugins ? Object.keys(spec.plugins) : undefined,
    tasks: extractTasks(spec.tasks),
  };
}

// extractTasks rebuilds the form's flat TaskFV[] from a Volcano Job's
// spec.tasks. Volcano nests one container per task in
// task.template.spec.containers[0]; we surface the container's image,
// command, args, and resource limits + the task-level replicas /
// restartPolicy. Multi-container tasks aren't supported by the form —
// they fall back to YAML editing.
function extractTasks(specTasks: any): TaskFV[] {
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
    // Pull cpu/memory out and route everything else (vgpu-* /
    // nvidia.com/gpu / ephemeral-storage / hugepages-* / ...) into
    // the free-form extras list. Prefer the union of limits + requests
    // so we don't lose keys that only exist on one side.
    const extras: TaskResourceRow[] = [];
    const seen = new Set<string>(['cpu', 'memory']);
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
