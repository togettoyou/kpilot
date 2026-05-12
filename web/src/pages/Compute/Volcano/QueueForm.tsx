import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import {
  Alert,
  App,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Space,
  Spin,
  Switch,
  Tabs,
} from 'antd';
import yaml from 'js-yaml';
import React, { useEffect, useRef, useState } from 'react';

import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';
import {
  applyManifest,
  buildQueueManifest,
  type QueueInput,
} from '@/services/kpilot/volcano';
import { getWorkload } from '@/services/kpilot/workload';

interface QueueFormDrawerProps {
  open: boolean;
  clusterId: string;
  // When set, the drawer opens in edit mode: fetches the named Queue
  // from the cluster, populates the form with its current spec, and
  // freezes the name input. Submit re-applies the spec via SSA.
  editing?: { name: string } | null;
  onClose: () => void;
  onSaved: () => void;
}

interface ResourceRow {
  key: string;
  value: string;
}

// ResourceListWithFixed lets users edit cpu + memory inline (they're
// in nearly every Queue) plus a free-form Form.List for anything else
// — extended resources like nvidia.com/gpu, volcano.sh/vgpu-*,
// ephemeral-storage, hugepages-*, etc. Keys are not validated client-
// side; whatever the user types is sent through to the API server.
interface ResourceListFV {
  cpu?: string;
  memory?: string;
  extras?: ResourceRow[];
}

interface FormValues {
  name: string;
  weight: number;
  reclaimable: boolean;
  parent?: string;
  type?: string;
  capability?: ResourceListFV;
  deserved?: ResourceListFV;
  guarantee?: ResourceListFV;
}

const QUEUE_CR = {
  group: 'scheduling.volcano.sh',
  version: 'v1beta1',
  kind: 'Queue',
  scope: 'Cluster' as const,
};

// QueueFormDrawer creates or edits a Volcano Queue. Two views share
// one drawer + one source of truth:
//
//   - 表单 view: antd Form covering the common knobs (weight,
//     capability quotas, reclaimable, parent).
//   - YAML view: the same manifest as raw YAML, in the workload
//     page's CodeMirror editor.
//
// Switching tabs round-trips through the manifest object: form →
// buildQueueManifest → yaml.dump for the form→yaml direction; yaml.load
// → formValuesFromManifest for the reverse. A parse failure on the
// reverse direction shows an inline Alert and blocks the switch so the
// user keeps their YAML draft. Submit reads from whichever view is
// active so users get out exactly what they see.
export function QueueFormDrawer({
  open,
  clusterId,
  editing,
  onClose,
  onSaved,
}: QueueFormDrawerProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'form' | 'yaml'>('form');
  const [yamlText, setYamlText] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);

  const isEdit = !!editing;

  // editOriginalRef stashes spec fields the form doesn't surface so
  // submit can re-emit them. Beyond spec.priority (which we let the
  // builder accept but the form has no input for), the upstream
  // QueueSpec also has extendClusters / affinity / dequeueStrategy —
  // complex nested fields KPilot doesn't visualize; preserving here
  // means edits won't silently drop them.
  const editOriginalRef = useRef<{
    priority?: number;
    extendClusters?: unknown;
    affinity?: unknown;
    dequeueStrategy?: unknown;
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
      form.setFieldsValue({ weight: 1, reclaimable: true });
      return;
    }
    setLoading(true);
    getWorkload(clusterId, '_cr', editing.name, '', QUEUE_CR)
      .then((obj: any) => {
        if (cancelled) return;
        form.setFieldsValue(formValuesFromManifest(obj, editing.name));
        const spec = obj?.spec ?? {};
        editOriginalRef.current = {
          priority: typeof spec.priority === 'number' ? spec.priority : undefined,
          extendClusters: Array.isArray(spec.extendClusters)
            ? spec.extendClusters
            : undefined,
          affinity: spec.affinity ?? undefined,
          dequeueStrategy: spec.dequeueStrategy ?? undefined,
        };
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, editing, clusterId, form]);

  const handleSwitchView = (next: string) => {
    if (next === view) return;
    if (next === 'yaml') {
      // Form → YAML: build the manifest from current form values
      // (no validation — the user may not have filled required
      // fields yet, but they should still see / edit the partial
      // manifest as YAML).
      const fv = form.getFieldsValue();
      try {
        const manifest = buildQueueManifest(fvToInput(fv));
        setYamlText(yaml.dump(manifest));
        setYamlError(null);
        setView('yaml');
      } catch (e: any) {
        setYamlError(String(e?.message ?? e));
      }
    } else {
      // YAML → Form: parse, project back to form values.
      try {
        const parsed = yaml.load(yamlText) as any;
        if (!parsed || typeof parsed !== 'object') {
          setYamlError('YAML is empty or not an object');
          return;
        }
        const name = parsed?.metadata?.name ?? form.getFieldValue('name');
        form.setFieldsValue(formValuesFromManifest(parsed, name));
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
      const input = fvToInput(v);
      // Re-attach preserved fields the form doesn't expose so SSA
      // doesn't blank them out. YAML view takes the user's typed
      // text as-is and doesn't need this.
      if (editOriginalRef.current?.priority !== undefined) {
        input.priority = editOriginalRef.current.priority;
      }
      manifest = buildQueueManifest(input);
      // Splice in the complex preserved fields directly on the
      // manifest spec — builder doesn't model them, but they're
      // valid spec keys the API server accepts.
      const preserved = editOriginalRef.current ?? {};
      const m: any = manifest;
      if (preserved.extendClusters) m.spec.extendClusters = preserved.extendClusters;
      if (preserved.affinity) m.spec.affinity = preserved.affinity;
      if (preserved.dequeueStrategy) m.spec.dequeueStrategy = preserved.dequeueStrategy;
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
            ? 'pages.compute.queueForm.updated'
            : 'pages.compute.queueForm.success',
        }),
      );
      onSaved();
      onClose();
    } catch {
      // global error handler
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
          ? 'pages.compute.queueForm.editTitle'
          : 'pages.compute.queueForm.title',
      })}
      size={620}
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
                ? 'pages.compute.queueForm.update'
                : 'pages.compute.queueForm.submit',
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
        {view === 'form' ? (
          <Form<FormValues> form={form} layout="vertical">
            <Form.Item
              name="name"
              label={intl.formatMessage({
                id: 'pages.compute.queueForm.name',
              })}
              rules={[
                { required: true },
                {
                  pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
                  message: 'DNS-1123',
                },
              ]}
              extra={intl.formatMessage({
                id: 'pages.compute.queueForm.name.extra',
              })}
            >
              <Input maxLength={63} placeholder="my-queue" disabled={isEdit} />
            </Form.Item>

            <Form.Item
              name="weight"
              label={intl.formatMessage({
                id: 'pages.compute.queueForm.weight',
              })}
              rules={[{ required: true }]}
              extra={intl.formatMessage({
                id: 'pages.compute.queueForm.weight.extra',
              })}
            >
              <InputNumber min={1} max={65535} style={{ width: 160 }} />
            </Form.Item>

            <Form.Item
              name="reclaimable"
              label={intl.formatMessage({
                id: 'pages.compute.queueForm.reclaimable',
              })}
              valuePropName="checked"
              extra={intl.formatMessage({
                id: 'pages.compute.queueForm.reclaimable.extra',
              })}
            >
              <Switch />
            </Form.Item>

            <Form.Item
              name="parent"
              label={intl.formatMessage({
                id: 'pages.compute.queueForm.parent',
              })}
              extra={intl.formatMessage({
                id: 'pages.compute.queueForm.parent.extra',
              })}
            >
              <Input placeholder="root" />
            </Form.Item>

            <Form.Item
              name="type"
              label={intl.formatMessage({
                id: 'pages.compute.queueForm.type',
              })}
              extra={intl.formatMessage({
                id: 'pages.compute.queueForm.type.extra',
              })}
            >
              <Input placeholder="kube" maxLength={253} />
            </Form.Item>

            <ResourceListSection
              name="capability"
              title={intl.formatMessage({
                id: 'pages.compute.queueForm.capability',
              })}
              hint={intl.formatMessage({
                id: 'pages.compute.queueForm.capability.extra',
              })}
              addLabel={intl.formatMessage({
                id: 'pages.compute.queueForm.capability.add',
              })}
            />
            <ResourceListSection
              name="deserved"
              title={intl.formatMessage({
                id: 'pages.compute.queueForm.deserved',
              })}
              hint={intl.formatMessage({
                id: 'pages.compute.queueForm.deserved.extra',
              })}
              addLabel={intl.formatMessage({
                id: 'pages.compute.queueForm.deserved.add',
              })}
            />
            <ResourceListSection
              name="guarantee"
              title={intl.formatMessage({
                id: 'pages.compute.queueForm.guarantee',
              })}
              hint={intl.formatMessage({
                id: 'pages.compute.queueForm.guarantee.extra',
              })}
              addLabel={intl.formatMessage({
                id: 'pages.compute.queueForm.guarantee.add',
              })}
            />
          </Form>
        ) : (
          <div
            style={{
              border: '1px solid var(--ant-color-border)',
              borderRadius: 4,
            }}
          >
            <YamlEditor value={yamlText} onChange={setYamlText} />
          </div>
        )}
      </Spin>
    </Drawer>
  );
}

// ResourceListSection renders a per-section ResourceList editor: two
// fixed Form.Item inputs for cpu + memory (overwhelmingly common —
// almost every Queue sets these), plus a Form.List below for
// everything else (GPU resources, ephemeral-storage, hugepages-*,
// custom extended resources). Keys in `extras` are user-typed and
// passed through verbatim to the API server.
function ResourceListSection({
  name,
  title,
  hint,
  addLabel,
}: {
  name: string;
  title: string;
  hint: string;
  addLabel: string;
}) {
  const intl = useIntl();
  return (
    <>
      <div style={{ marginTop: 16, marginBottom: 4, fontWeight: 500 }}>
        {title}
      </div>
      <div
        style={{
          marginBottom: 8,
          color: 'var(--ant-color-text-tertiary)',
          fontSize: 12,
        }}
      >
        {hint}
      </div>
      <Space style={{ display: 'flex', marginBottom: 8 }} align="baseline">
        <Form.Item
          name={[name, 'cpu']}
          label="cpu"
          style={{ marginBottom: 0 }}
        >
          <Input placeholder="4" style={{ width: 160 }} maxLength={32} />
        </Form.Item>
        <Form.Item
          name={[name, 'memory']}
          label="memory"
          style={{ marginBottom: 0, marginInlineStart: 16 }}
        >
          <Input placeholder="8Gi" style={{ width: 160 }} maxLength={32} />
        </Form.Item>
      </Space>
      <div
        style={{
          marginTop: 8,
          marginBottom: 6,
          fontSize: 12,
          color: 'var(--ant-color-text-tertiary)',
        }}
      >
        {intl.formatMessage({
          id: 'pages.compute.queueForm.extras.label',
        })}
      </div>
      <Form.List name={[name, 'extras']}>
        {(fields, { add, remove }) => (
          <>
            {fields.map((field) => (
              <Space
                key={field.key}
                style={{ display: 'flex', marginBottom: 8 }}
                align="baseline"
              >
                <Form.Item
                  name={[field.name, 'key']}
                  rules={[{ required: true }]}
                  style={{ marginBottom: 0 }}
                >
                  <Input
                    placeholder="nvidia.com/gpu / volcano.sh/vgpu-number"
                    style={{ width: 280 }}
                  />
                </Form.Item>
                <Form.Item
                  name={[field.name, 'value']}
                  rules={[{ required: true }]}
                  style={{ marginBottom: 0 }}
                >
                  <Input placeholder="1 / 40000" style={{ width: 140 }} />
                </Form.Item>
                <MinusCircleOutlined onClick={() => remove(field.name)} />
              </Space>
            ))}
            <Button
              type="dashed"
              onClick={() => add({ key: '', value: '' })}
              icon={<PlusOutlined />}
              block
            >
              {addLabel}
            </Button>
          </>
        )}
      </Form.List>
    </>
  );
}

// resourceListFVToRecord flattens cpu / memory / extras into a single
// Record<string, string> for the manifest builder. cpu/memory are
// only included when set; user-typed extras get their key trimmed.
function resourceListFVToRecord(
  v: ResourceListFV | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const cpu = v?.cpu?.trim();
  const memory = v?.memory?.trim();
  if (cpu) out['cpu'] = cpu;
  if (memory) out['memory'] = memory;
  for (const row of v?.extras ?? []) {
    const k = row?.key?.trim();
    const val = row?.value?.trim();
    // Ignore extras that collide with cpu/memory (user would have
    // also filled those above) — fixed inputs win, no surprise from
    // ordering.
    if (k && val && k !== 'cpu' && k !== 'memory') out[k] = val;
  }
  return out;
}

// recordToResourceListFV is the reverse: pull cpu/memory out of the
// record (if present) and route the rest into extras rows.
function recordToResourceListFV(
  rec?: Record<string, unknown>,
): ResourceListFV {
  const out: ResourceListFV = { extras: [] };
  if (!rec) return out;
  for (const [k, v] of Object.entries(rec)) {
    const s = typeof v === 'string' ? v : String(v);
    if (k === 'cpu') out.cpu = s;
    else if (k === 'memory') out.memory = s;
    else (out.extras ??= []).push({ key: k, value: s });
  }
  return out;
}

// fvToInput translates the form's flat field shape into the
// QueueInput contract buildQueueManifest expects.
function fvToInput(v: FormValues): QueueInput {
  // Trim every user-typed string before it lands in a K8s resource
  // map — K8s quantity parser rejects whitespace, and "  100Gi "
  // would surface as a not-very-helpful apply error.
  const t = (s?: string) => s?.trim() || undefined;
  const capability = resourceListFVToRecord(v.capability);
  const deserved = resourceListFVToRecord(v.deserved);
  const guarantee = resourceListFVToRecord(v.guarantee);
  return {
    name: v.name?.trim() ?? '',
    weight: v.weight ?? 1,
    reclaimable: v.reclaimable,
    parent: t(v.parent),
    type: t(v.type),
    capability,
    deserved: Object.keys(deserved).length > 0 ? deserved : undefined,
    guarantee: Object.keys(guarantee).length > 0 ? guarantee : undefined,
  };
}

// formValuesFromManifest reverses the manifest → form mapping. Used
// both on initial load (edit mode) and on YAML → form switch.
function formValuesFromManifest(obj: any, fallbackName: string): FormValues {
  const spec = obj?.spec ?? {};
  return {
    name: obj?.metadata?.name ?? fallbackName,
    weight: typeof spec.weight === 'number' ? spec.weight : 1,
    reclaimable:
      typeof spec.reclaimable === 'boolean' ? spec.reclaimable : true,
    parent: spec.parent ?? undefined,
    type: spec.type ?? undefined,
    capability: recordToResourceListFV(spec.capability),
    deserved: recordToResourceListFV(spec.deserved),
    // Guarantee has a .resource wrapper per the CRD
    // (Guarantee struct → resource: ResourceList).
    guarantee: recordToResourceListFV(spec.guarantee?.resource),
  };
}
