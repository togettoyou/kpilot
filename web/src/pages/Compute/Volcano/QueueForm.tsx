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
  Select,
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
  // vGPU first-class fields (volcano.sh/vgpu-{number,memory,cores}).
  // At queue level these are totals (sum-of-all-pods), not per-slot —
  // e.g. capability.vgpu-memory=20000 means "this queue can hold up
  // to 20000 MiB of vGPU memory across all running pods". Native
  // inputs so users don't have to remember the long keys.
  vgpuNumber?: number;
  vgpuMemory?: number;
  vgpuCores?: number;
  extras?: ResourceRow[];
}

interface AffinityFV {
  nodeGroupAffinity?: { required?: string[]; preferred?: string[] };
  nodeGroupAntiAffinity?: { required?: string[]; preferred?: string[] };
}

interface FormValues {
  name: string;
  weight: number;
  // Volcano CRD: priority >= 0, defaults 0. Affects scheduling
  // (higher = first) and reclamation (higher = reclaimed last).
  priority?: number;
  reclaimable: boolean;
  parent?: string;
  type?: string;
  capability?: ResourceListFV;
  deserved?: ResourceListFV;
  guarantee?: ResourceListFV;
  // Queue-level node-group affinity consumed by the nodegroup plugin.
  // The form covers the common shape (lists of nodeGroup names); more
  // complex affinity should be edited via the YAML view.
  affinity?: AffinityFV;
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
  // submit can re-emit them. `priority` and `affinity` are now driven
  // by the form, so they're not preserved here. `extendClusters` and
  // `dequeueStrategy` remain form-invisible advanced knobs — round-
  // trip them through here so edits in the form view don't silently
  // drop values a user set via YAML / kubectl.
  const editOriginalRef = useRef<{
    extendClusters?: unknown;
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
          extendClusters: Array.isArray(spec.extendClusters)
            ? spec.extendClusters
            : undefined,
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
      manifest = buildQueueManifest(input);
      // Splice in the form-invisible preserved fields directly on the
      // manifest spec — builder doesn't model them, but they're valid
      // spec keys the API server accepts. Without this, editing a
      // queue in the form view would silently drop extendClusters /
      // dequeueStrategy a user set via YAML.
      const preserved = editOriginalRef.current ?? {};
      const m: any = manifest;
      if (preserved.extendClusters) m.spec.extendClusters = preserved.extendClusters;
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
              name="priority"
              label={intl.formatMessage({
                id: 'pages.compute.queueForm.priority',
              })}
              extra={intl.formatMessage({
                id: 'pages.compute.queueForm.priority.extra',
              })}
            >
              <InputNumber min={0} style={{ width: 160 }} placeholder="0" />
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
            <AffinitySection />
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

// AffinitySection renders Queue.spec.affinity as four
// Select-mode-tags inputs (required / preferred × affinity / anti-
// affinity), each holding a list of node-group names. The form
// only covers this common shape — more elaborate affinity
// (custom matchExpressions, weights, etc.) should be edited in the
// YAML view; the builder collapses empty lists so unused buckets
// don't leak into the stored manifest.
function AffinitySection() {
  const intl = useIntl();
  const tagInput = (
    name: (string | number)[],
    placeholder: string,
  ) => (
    <Form.Item name={name} style={{ marginBottom: 8 }}>
      <Select
        mode="tags"
        tokenSeparators={[',', ' ']}
        placeholder={placeholder}
        style={{ width: '100%' }}
      />
    </Form.Item>
  );
  return (
    <>
      <div style={{ marginTop: 16, marginBottom: 4, fontWeight: 500 }}>
        {intl.formatMessage({ id: 'pages.compute.queueForm.affinity' })}
      </div>
      <div
        style={{
          marginBottom: 8,
          color: 'var(--ant-color-text-tertiary)',
          fontSize: 12,
        }}
      >
        {intl.formatMessage({
          id: 'pages.compute.queueForm.affinity.extra',
        })}
      </div>
      <div style={{ marginBottom: 4, fontSize: 12 }}>
        {intl.formatMessage({
          id: 'pages.compute.queueForm.affinity.required',
        })}
      </div>
      {tagInput(
        ['affinity', 'nodeGroupAffinity', 'required'],
        intl.formatMessage({
          id: 'pages.compute.queueForm.affinity.placeholder',
        }),
      )}
      <div style={{ marginBottom: 4, fontSize: 12 }}>
        {intl.formatMessage({
          id: 'pages.compute.queueForm.affinity.preferred',
        })}
      </div>
      {tagInput(
        ['affinity', 'nodeGroupAffinity', 'preferred'],
        intl.formatMessage({
          id: 'pages.compute.queueForm.affinity.placeholder',
        }),
      )}
      <div style={{ marginBottom: 4, fontSize: 12 }}>
        {intl.formatMessage({
          id: 'pages.compute.queueForm.antiAffinity.required',
        })}
      </div>
      {tagInput(
        ['affinity', 'nodeGroupAntiAffinity', 'required'],
        intl.formatMessage({
          id: 'pages.compute.queueForm.affinity.placeholder',
        }),
      )}
      <div style={{ marginBottom: 4, fontSize: 12 }}>
        {intl.formatMessage({
          id: 'pages.compute.queueForm.antiAffinity.preferred',
        })}
      </div>
      {tagInput(
        ['affinity', 'nodeGroupAntiAffinity', 'preferred'],
        intl.formatMessage({
          id: 'pages.compute.queueForm.affinity.placeholder',
        }),
      )}
    </>
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
      {/* GPU 三件套 — 同 JobForm 的 task 行，但这里是队列总配额而不是
          per-slot。整组留空 = 不限制 GPU。 */}
      <Space style={{ display: 'flex', marginBottom: 8 }} align="baseline">
        <Form.Item
          name={[name, 'vgpuNumber']}
          label={intl.formatMessage({
            id: 'pages.compute.queueForm.gpu.number',
          })}
          tooltip={intl.formatMessage({
            id: 'pages.compute.queueForm.gpu.number.tip',
          })}
          style={{ marginBottom: 0 }}
        >
          <InputNumber
            min={0}
            precision={0}
            placeholder="10"
            style={{ width: 120 }}
          />
        </Form.Item>
        <Form.Item
          name={[name, 'vgpuMemory']}
          label={intl.formatMessage({
            id: 'pages.compute.queueForm.gpu.memory',
          })}
          tooltip={intl.formatMessage({
            id: 'pages.compute.queueForm.gpu.memory.tip',
          })}
          style={{ marginBottom: 0, marginInlineStart: 12 }}
        >
          <InputNumber
            min={0}
            precision={0}
            placeholder="20000"
            addonAfter="MiB"
            style={{ width: 160 }}
          />
        </Form.Item>
        <Form.Item
          name={[name, 'vgpuCores']}
          label={intl.formatMessage({
            id: 'pages.compute.queueForm.gpu.cores',
          })}
          tooltip={intl.formatMessage({
            id: 'pages.compute.queueForm.gpu.cores.tip',
          })}
          style={{ marginBottom: 0, marginInlineStart: 12 }}
        >
          <InputNumber
            min={0}
            precision={0}
            placeholder="100"
            addonAfter="%"
            style={{ width: 140 }}
          />
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
                    placeholder="nvidia.com/gpu / ephemeral-storage / ..."
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
  // vGPU native fields → same record. Each independently optional;
  // a zero is treated as "user didn't intend to cap" and dropped.
  if (typeof v?.vgpuNumber === 'number' && v.vgpuNumber > 0) {
    out['volcano.sh/vgpu-number'] = String(v.vgpuNumber);
  }
  if (typeof v?.vgpuMemory === 'number' && v.vgpuMemory > 0) {
    out['volcano.sh/vgpu-memory'] = String(v.vgpuMemory);
  }
  if (typeof v?.vgpuCores === 'number' && v.vgpuCores > 0) {
    out['volcano.sh/vgpu-cores'] = String(v.vgpuCores);
  }
  const HANDLED = new Set([
    'cpu',
    'memory',
    'volcano.sh/vgpu-number',
    'volcano.sh/vgpu-memory',
    'volcano.sh/vgpu-cores',
  ]);
  for (const row of v?.extras ?? []) {
    const k = row?.key?.trim();
    const val = row?.value?.trim();
    // Native fields win over a duplicate-key extras row.
    if (k && val && !HANDLED.has(k)) out[k] = val;
  }
  return out;
}

// recordToResourceListFV is the reverse: pull native fields out of
// the record (if present) and route the rest into extras rows.
function recordToResourceListFV(
  rec?: Record<string, unknown>,
): ResourceListFV {
  const out: ResourceListFV = { extras: [] };
  if (!rec) return out;
  const num = (s: string): number | undefined => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  for (const [k, v] of Object.entries(rec)) {
    const s = typeof v === 'string' ? v : String(v);
    if (k === 'cpu') out.cpu = s;
    else if (k === 'memory') out.memory = s;
    else if (k === 'volcano.sh/vgpu-number') out.vgpuNumber = num(s);
    else if (k === 'volcano.sh/vgpu-memory') out.vgpuMemory = num(s);
    else if (k === 'volcano.sh/vgpu-cores') out.vgpuCores = num(s);
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
    priority: typeof v.priority === 'number' ? v.priority : undefined,
    reclaimable: v.reclaimable,
    parent: t(v.parent),
    type: t(v.type),
    capability,
    deserved: Object.keys(deserved).length > 0 ? deserved : undefined,
    guarantee: Object.keys(guarantee).length > 0 ? guarantee : undefined,
    affinity: affinityFVToInput(v.affinity),
  };
}

// affinityFVToInput passes the form's affinity shape through to the
// builder, dropping the whole object when every list is empty so we
// don't emit `spec.affinity: {}` (which would otherwise cause SSA
// to claim ownership of an empty field).
function affinityFVToInput(
  a?: AffinityFV,
): QueueInput['affinity'] | undefined {
  if (!a) return undefined;
  const trimList = (xs?: string[]) =>
    (xs ?? []).map((s) => s.trim()).filter(Boolean);
  const aff = {
    required: trimList(a.nodeGroupAffinity?.required),
    preferred: trimList(a.nodeGroupAffinity?.preferred),
  };
  const anti = {
    required: trimList(a.nodeGroupAntiAffinity?.required),
    preferred: trimList(a.nodeGroupAntiAffinity?.preferred),
  };
  const hasAny =
    aff.required.length +
      aff.preferred.length +
      anti.required.length +
      anti.preferred.length >
    0;
  if (!hasAny) return undefined;
  return { nodeGroupAffinity: aff, nodeGroupAntiAffinity: anti };
}

// formValuesFromManifest reverses the manifest → form mapping. Used
// both on initial load (edit mode) and on YAML → form switch.
function formValuesFromManifest(obj: any, fallbackName: string): FormValues {
  const spec = obj?.spec ?? {};
  return {
    name: obj?.metadata?.name ?? fallbackName,
    weight: typeof spec.weight === 'number' ? spec.weight : 1,
    priority: typeof spec.priority === 'number' ? spec.priority : undefined,
    reclaimable:
      typeof spec.reclaimable === 'boolean' ? spec.reclaimable : true,
    parent: spec.parent ?? undefined,
    type: spec.type ?? undefined,
    capability: recordToResourceListFV(spec.capability),
    deserved: recordToResourceListFV(spec.deserved),
    // Guarantee has a .resource wrapper per the CRD
    // (Guarantee struct → resource: ResourceList).
    guarantee: recordToResourceListFV(spec.guarantee?.resource),
    affinity: affinityFromManifest(spec.affinity),
  };
}

// affinityFromManifest collapses the CRD's verbose
// XxxDuringSchedulingIgnoredDuringExecution keys back into the
// form's short `required` / `preferred` shape. Non-array values are
// ignored so a manifest with unexpected shapes doesn't crash the
// form (the YAML view stays usable).
function affinityFromManifest(a: any): AffinityFV | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const pick = (
    obj: any,
  ): { required?: string[]; preferred?: string[] } | undefined => {
    if (!obj || typeof obj !== 'object') return undefined;
    const req = Array.isArray(obj.requiredDuringSchedulingIgnoredDuringExecution)
      ? (obj.requiredDuringSchedulingIgnoredDuringExecution as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        )
      : [];
    const pref = Array.isArray(
      obj.preferredDuringSchedulingIgnoredDuringExecution,
    )
      ? (obj.preferredDuringSchedulingIgnoredDuringExecution as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        )
      : [];
    if (req.length === 0 && pref.length === 0) return undefined;
    const out: { required?: string[]; preferred?: string[] } = {};
    if (req.length > 0) out.required = req;
    if (pref.length > 0) out.preferred = pref;
    return out;
  };
  const aff = pick(a.nodeGroupAffinity);
  const anti = pick(a.nodeGroupAntiAffinity);
  if (!aff && !anti) return undefined;
  const out: AffinityFV = {};
  if (aff) out.nodeGroupAffinity = aff;
  if (anti) out.nodeGroupAntiAffinity = anti;
  return out;
}
