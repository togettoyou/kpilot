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
import React, { useEffect, useState } from 'react';

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

interface FormValues {
  name: string;
  weight: number;
  reclaimable: boolean;
  parent?: string;
  capability_cpu?: string;
  capability_memory?: string;
  capability_vgpu_number?: string;
  capability_vgpu_memory?: string;
  capability_vgpu_cores?: string;
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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    form.resetFields();
    setView('form');
    setYamlText('');
    setYamlError(null);
    if (!editing) {
      form.setFieldsValue({ weight: 1, reclaimable: true });
      return;
    }
    setLoading(true);
    getWorkload(clusterId, '_cr', editing.name, '', QUEUE_CR)
      .then((obj: any) => {
        if (cancelled) return;
        form.setFieldsValue(formValuesFromManifest(obj, editing.name));
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
      manifest = buildQueueManifest(fvToInput(v));
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

            <div style={{ marginTop: 24, marginBottom: 8, fontWeight: 500 }}>
              {intl.formatMessage({
                id: 'pages.compute.queueForm.capability',
              })}
            </div>
            <div
              style={{
                marginBottom: 16,
                color: 'var(--ant-color-text-tertiary)',
                fontSize: 12,
              }}
            >
              {intl.formatMessage({
                id: 'pages.compute.queueForm.capability.extra',
              })}
            </div>

            <Form.Item
              name="capability_cpu"
              label="cpu"
              tooltip="K8s 资源数量字符串。例如 10、500m"
            >
              <Input placeholder="10" maxLength={32} />
            </Form.Item>
            <Form.Item
              name="capability_memory"
              label="memory"
              tooltip="K8s 资源数量字符串。例如 100Gi、512Mi"
            >
              <Input placeholder="100Gi" maxLength={32} />
            </Form.Item>
            <Form.Item
              name="capability_vgpu_number"
              label="volcano.sh/vgpu-number"
            >
              <Input placeholder="8" maxLength={32} />
            </Form.Item>
            <Form.Item
              name="capability_vgpu_memory"
              label="volcano.sh/vgpu-memory"
              tooltip="单位 MiB"
            >
              <Input placeholder="40000" maxLength={32} />
            </Form.Item>
            <Form.Item
              name="capability_vgpu_cores"
              label="volcano.sh/vgpu-cores"
              tooltip="百分比 0-100"
            >
              <Input placeholder="100" maxLength={32} />
            </Form.Item>
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

// fvToInput translates the form's flat field shape into the
// QueueInput contract buildQueueManifest expects.
function fvToInput(v: FormValues): QueueInput {
  // Trim every user-typed string before it lands in a K8s resource
  // map — K8s quantity parser rejects whitespace, and "  100Gi "
  // would surface as a not-very-helpful apply error.
  const t = (s?: string) => s?.trim() || undefined;
  const capability: Record<string, string> = {};
  const cpu = t(v.capability_cpu);
  const mem = t(v.capability_memory);
  const vn = t(v.capability_vgpu_number);
  const vm = t(v.capability_vgpu_memory);
  const vc = t(v.capability_vgpu_cores);
  if (cpu) capability['cpu'] = cpu;
  if (mem) capability['memory'] = mem;
  if (vn) capability['volcano.sh/vgpu-number'] = vn;
  if (vm) capability['volcano.sh/vgpu-memory'] = vm;
  if (vc) capability['volcano.sh/vgpu-cores'] = vc;
  return {
    name: v.name?.trim() ?? '',
    weight: v.weight ?? 1,
    reclaimable: v.reclaimable,
    parent: t(v.parent),
    capability,
  };
}

// formValuesFromManifest reverses the manifest → form mapping. Used
// both on initial load (edit mode) and on YAML → form switch.
function formValuesFromManifest(obj: any, fallbackName: string): FormValues {
  const spec = obj?.spec ?? {};
  const cap = (spec.capability ?? {}) as Record<string, string>;
  return {
    name: obj?.metadata?.name ?? fallbackName,
    weight: typeof spec.weight === 'number' ? spec.weight : 1,
    reclaimable:
      typeof spec.reclaimable === 'boolean' ? spec.reclaimable : true,
    parent: spec.parent ?? undefined,
    capability_cpu: cap['cpu'],
    capability_memory: cap['memory'],
    capability_vgpu_number: cap['volcano.sh/vgpu-number'],
    capability_vgpu_memory: cap['volcano.sh/vgpu-memory'],
    capability_vgpu_cores: cap['volcano.sh/vgpu-cores'],
  };
}
