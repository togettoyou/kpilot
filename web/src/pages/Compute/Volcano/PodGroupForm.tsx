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
  Tabs,
} from 'antd';
import yaml from 'js-yaml';
import React, { useEffect, useRef, useState } from 'react';

import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';
import {
  applyManifest,
  buildPodGroupManifest,
  type PodGroupInput,
} from '@/services/kpilot/volcano';
import { getWorkload } from '@/services/kpilot/workload';

interface PodGroupFormDrawerProps {
  open: boolean;
  clusterId: string;
  // Edit mode: fetch the named PodGroup, populate, freeze name + ns.
  editing?: { name: string; namespace: string } | null;
  // Default namespace for create mode (top-bar NamespacePicker value).
  defaultNamespace?: string;
  onClose: () => void;
  onSaved: () => void;
}

// FormValues is the flat shape we push into antd Form. Most fields
// map 1:1 to PodGroupInput; the map types (minTaskMember,
// minResources, networkTopology) are split into per-key rows so antd
// Form.List can edit them, then re-collapsed in fvToInput.
interface FormValues {
  name: string;
  namespace: string;
  queue?: string;
  priorityClassName?: string;
  minMember?: number;
  // task name → min count rows
  minTaskMember?: { name: string; count: number }[];
  // K8s resource key → quantity rows. Free-form so users can add
  // any extended resource (volcano.sh/vgpu-*, nvidia.com/gpu, ...).
  minResources?: { key: string; value: string }[];
  // NetworkTopology — all optional; empty mode means "no block".
  ntMode?: 'hard' | 'soft' | '';
  ntHighestTierAllowed?: number;
  ntHighestTierName?: string;
}

const PODGROUP_CR = {
  group: 'scheduling.volcano.sh',
  version: 'v1beta1',
  kind: 'PodGroup',
  scope: 'Namespaced' as const,
};

// PodGroupFormDrawer creates or edits a Volcano PodGroup. Same dual-
// view (form / YAML) pattern QueueForm / JobForm use; the form
// covers the common fields (gang minMember, queue, priorityClassName,
// minResources, networkTopology), advanced subGroupPolicy [] users
// can drop to the YAML tab for.
export function PodGroupFormDrawer({
  open,
  clusterId,
  editing,
  defaultNamespace,
  onClose,
  onSaved,
}: PodGroupFormDrawerProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'form' | 'yaml'>('form');
  const [yamlText, setYamlText] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);

  const isEdit = !!editing;

  // editOriginalRef stashes spec fields the form doesn't surface
  // (subGroupPolicy[], etc.) so submit re-emits them rather than
  // having SSA blank them out. Cleared on every drawer open.
  const editOriginalRef = useRef<{ subGroupPolicy?: unknown } | null>(null);

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
        namespace: defaultNamespace || 'default',
        minMember: 1,
      });
      return;
    }
    setLoading(true);
    getWorkload(
      clusterId,
      '_cr',
      editing.name,
      editing.namespace,
      PODGROUP_CR,
    )
      .then((obj: any) => {
        if (cancelled) return;
        form.setFieldsValue(
          formValuesFromManifest(obj, editing.name, editing.namespace),
        );
        const sgp = obj?.spec?.subGroupPolicy;
        if (Array.isArray(sgp) && sgp.length > 0) {
          editOriginalRef.current = { subGroupPolicy: sgp };
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, editing, clusterId, defaultNamespace, form]);

  const handleSwitchView = (next: string) => {
    if (next === view) return;
    if (next === 'yaml') {
      const fv = form.getFieldsValue();
      try {
        const manifest = buildPodGroupManifest(fvToInput(fv));
        // Re-attach preserved fields on the form→yaml side so users
        // see the full spec in YAML even before submitting.
        if (editOriginalRef.current?.subGroupPolicy) {
          (manifest as any).spec.subGroupPolicy =
            editOriginalRef.current.subGroupPolicy;
        }
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
        const name = parsed?.metadata?.name ?? form.getFieldValue('name');
        const ns =
          parsed?.metadata?.namespace ?? form.getFieldValue('namespace');
        form.setFieldsValue(formValuesFromManifest(parsed, name, ns));
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
      manifest = buildPodGroupManifest(fvToInput(v));
      // Splice in subGroupPolicy[] the form doesn't render so the
      // edit path doesn't quietly drop it.
      if (editOriginalRef.current?.subGroupPolicy) {
        (manifest as any).spec.subGroupPolicy =
          editOriginalRef.current.subGroupPolicy;
      }
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
            ? 'pages.compute.podGroupForm.updated'
            : 'pages.compute.podGroupForm.success',
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
          ? 'pages.compute.podGroupForm.editTitle'
          : 'pages.compute.podGroupForm.title',
      })}
      size={680}
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
                ? 'pages.compute.podGroupForm.update'
                : 'pages.compute.podGroupForm.submit',
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
                id: 'pages.compute.podGroupForm.name',
              })}
              rules={[
                { required: true },
                {
                  pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
                  message: 'DNS-1123',
                },
              ]}
            >
              <Input maxLength={253} placeholder="my-podgroup" disabled={isEdit} />
            </Form.Item>
            <Form.Item
              name="namespace"
              label={intl.formatMessage({
                id: 'pages.compute.podGroupForm.namespace',
              })}
              rules={[{ required: true }]}
            >
              <Input maxLength={253} disabled={isEdit} />
            </Form.Item>
            <Form.Item
              name="queue"
              label={intl.formatMessage({
                id: 'pages.compute.podGroupForm.queue',
              })}
              extra={intl.formatMessage({
                id: 'pages.compute.podGroupForm.queue.extra',
              })}
            >
              <Input placeholder="default" maxLength={253} />
            </Form.Item>
            <Form.Item
              name="priorityClassName"
              label={intl.formatMessage({
                id: 'pages.compute.podGroupForm.priority',
              })}
            >
              <Input placeholder="" maxLength={253} />
            </Form.Item>
            <Form.Item
              name="minMember"
              label={intl.formatMessage({
                id: 'pages.compute.podGroupForm.minMember',
              })}
              extra={intl.formatMessage({
                id: 'pages.compute.podGroupForm.minMember.extra',
              })}
            >
              <InputNumber min={0} style={{ width: 160 }} />
            </Form.Item>

            <SectionHeading
              title={intl.formatMessage({
                id: 'pages.compute.podGroupForm.minTaskMember',
              })}
              hint={intl.formatMessage({
                id: 'pages.compute.podGroupForm.minTaskMember.extra',
              })}
            />
            <Form.List name="minTaskMember">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((field) => (
                    <Space
                      key={field.key}
                      style={{ display: 'flex', marginBottom: 8 }}
                      align="baseline"
                    >
                      <Form.Item
                        name={[field.name, 'name']}
                        rules={[{ required: true }]}
                        style={{ marginBottom: 0 }}
                      >
                        <Input placeholder="task name" style={{ width: 220 }} />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'count']}
                        rules={[{ required: true }]}
                        style={{ marginBottom: 0 }}
                      >
                        <InputNumber min={0} placeholder="min" />
                      </Form.Item>
                      <MinusCircleOutlined onClick={() => remove(field.name)} />
                    </Space>
                  ))}
                  <Button
                    type="dashed"
                    onClick={() => add({ name: '', count: 1 })}
                    icon={<PlusOutlined />}
                    block
                  >
                    {intl.formatMessage({
                      id: 'pages.compute.podGroupForm.minTaskMember.add',
                    })}
                  </Button>
                </>
              )}
            </Form.List>

            <SectionHeading
              title={intl.formatMessage({
                id: 'pages.compute.podGroupForm.minResources',
              })}
              hint={intl.formatMessage({
                id: 'pages.compute.podGroupForm.minResources.extra',
              })}
            />
            <Form.List name="minResources">
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
                          placeholder="cpu / memory / volcano.sh/vgpu-number"
                          style={{ width: 260 }}
                        />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'value']}
                        rules={[{ required: true }]}
                        style={{ marginBottom: 0 }}
                      >
                        <Input
                          placeholder="4 / 8Gi"
                          style={{ width: 120 }}
                        />
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
                    {intl.formatMessage({
                      id: 'pages.compute.podGroupForm.minResources.add',
                    })}
                  </Button>
                </>
              )}
            </Form.List>

            <SectionHeading
              title={intl.formatMessage({
                id: 'pages.compute.podGroupForm.networkTopology',
              })}
              hint={intl.formatMessage({
                id: 'pages.compute.podGroupForm.networkTopology.extra',
              })}
            />
            <Form.Item
              name="ntMode"
              label={intl.formatMessage({
                id: 'pages.compute.podGroupForm.ntMode',
              })}
              extra={intl.formatMessage({
                id: 'pages.compute.podGroupForm.ntMode.extra',
              })}
            >
              <Select
                allowClear
                placeholder={intl.formatMessage({
                  id: 'pages.compute.podGroupForm.ntMode.placeholder',
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
                id: 'pages.compute.podGroupForm.ntTierAllowed',
              })}
              extra={intl.formatMessage({
                id: 'pages.compute.podGroupForm.ntTierAllowed.extra',
              })}
            >
              <InputNumber min={0} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item
              name="ntHighestTierName"
              label={intl.formatMessage({
                id: 'pages.compute.podGroupForm.ntTierName',
              })}
              extra={intl.formatMessage({
                id: 'pages.compute.podGroupForm.ntTierName.extra',
              })}
            >
              <Input maxLength={253} />
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

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <>
      <div style={{ marginTop: 16, marginBottom: 4, fontWeight: 500 }}>
        {title}
      </div>
      {hint && (
        <div
          style={{
            marginBottom: 8,
            color: 'var(--ant-color-text-tertiary)',
            fontSize: 12,
          }}
        >
          {hint}
        </div>
      )}
    </>
  );
}

function fvToInput(v: FormValues): PodGroupInput {
  const t = (s?: string) => s?.trim() || undefined;
  const minTaskMember: Record<string, number> = {};
  for (const row of v.minTaskMember ?? []) {
    if (row?.name && typeof row.count === 'number') {
      minTaskMember[row.name.trim()] = row.count;
    }
  }
  const minResources: Record<string, string> = {};
  for (const row of v.minResources ?? []) {
    const key = row?.key?.trim();
    const value = row?.value?.trim();
    if (key && value) minResources[key] = value;
  }
  return {
    name: v.name?.trim() ?? '',
    namespace: v.namespace?.trim() ?? 'default',
    queue: t(v.queue),
    priorityClassName: t(v.priorityClassName),
    minMember: typeof v.minMember === 'number' ? v.minMember : undefined,
    minTaskMember:
      Object.keys(minTaskMember).length > 0 ? minTaskMember : undefined,
    minResources:
      Object.keys(minResources).length > 0 ? minResources : undefined,
    networkTopologyMode:
      v.ntMode === 'hard' || v.ntMode === 'soft' ? v.ntMode : undefined,
    networkTopologyHighestTierAllowed:
      typeof v.ntHighestTierAllowed === 'number'
        ? v.ntHighestTierAllowed
        : undefined,
    networkTopologyHighestTierName: t(v.ntHighestTierName),
  };
}

function formValuesFromManifest(
  obj: any,
  fallbackName: string,
  fallbackNs: string,
): FormValues {
  const spec = obj?.spec ?? {};
  const mtm = spec.minTaskMember ?? {};
  const mr = spec.minResources ?? {};
  const nt = spec.networkTopology ?? {};
  return {
    name: obj?.metadata?.name ?? fallbackName,
    namespace: obj?.metadata?.namespace ?? fallbackNs,
    queue: spec.queue ?? undefined,
    priorityClassName: spec.priorityClassName ?? undefined,
    minMember: typeof spec.minMember === 'number' ? spec.minMember : undefined,
    minTaskMember: Object.entries(mtm).map(([name, count]) => ({
      name,
      count: typeof count === 'number' ? count : Number(count),
    })),
    minResources: Object.entries(mr).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : String(value),
    })),
    ntMode:
      nt.mode === 'hard' || nt.mode === 'soft' ? nt.mode : undefined,
    ntHighestTierAllowed:
      typeof nt.highestTierAllowed === 'number'
        ? nt.highestTierAllowed
        : undefined,
    ntHighestTierName: nt.highestTierName ?? undefined,
  };
}
