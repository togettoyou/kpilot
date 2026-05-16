import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
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
  Typography,
} from 'antd';
import yaml from 'js-yaml';
import React, { useEffect, useRef, useState } from 'react';

import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';
import {
  applyManifest,
  buildHyperNodeManifest,
  type HyperNodeInput,
  type HyperNodeMemberType,
  type HyperNodeSelectorType,
} from '@/services/kpilot/volcano';
import { getWorkload } from '@/services/kpilot/workload';

const { Text } = Typography;

interface HyperNodeFormDrawerProps {
  open: boolean;
  clusterId: string;
  editing?: { name: string } | null;
  onClose: () => void;
  onSaved: () => void;
}

// FormValues mirrors HyperNodeInput, but unflattens matchLabels for
// antd Form.List editing (key/value rows). selectorType is a radio
// that gates which sub-field is visible per member.
interface FormValues {
  name: string;
  tier: number;
  tierName?: string;
  members: MemberFormRow[];
}

interface MemberFormRow {
  type: HyperNodeMemberType;
  selectorType: HyperNodeSelectorType;
  exactName?: string;
  regexPattern?: string;
  // matchLabels split into per-key rows so user can add freely.
  labels?: { k: string; v: string }[];
}

const HYPERNODE_CR = {
  group: 'topology.volcano.sh',
  version: 'v1alpha1',
  kind: 'HyperNode',
  scope: 'Cluster' as const,
};

// HyperNodeFormDrawer creates or edits a Volcano HyperNode. Same
// form/YAML dual-view pattern. The trickier piece is the selector
// union (exactMatch / regexMatch / labelMatch) — only one can be set
// per member, enforced by the CRD with a CEL rule. We model it as a
// radio per member row and conditionally render the inputs.
export function HyperNodeFormDrawer({
  open,
  clusterId,
  editing,
  onClose,
  onSaved,
}: HyperNodeFormDrawerProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'form' | 'yaml'>('form');
  const [yamlText, setYamlText] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);

  const isEdit = !!editing;
  // Preserve metadata bits the form doesn't surface (labels,
  // annotations, finalizers, ownerReferences) so an edit-mode save
  // doesn't strip them. Cleared on every drawer (re)open.
  const editMetaRef = useRef<{
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    finalizers?: string[];
    ownerReferences?: unknown[];
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    form.resetFields();
    setView('form');
    setYamlText('');
    setYamlError(null);
    editMetaRef.current = null;
    if (!editing) {
      form.setFieldsValue({ tier: 1, members: [] });
      return;
    }
    setLoading(true);
    getWorkload(clusterId, '_cr', editing.name, '', HYPERNODE_CR)
      .then((obj: any) => {
        if (cancelled) return;
        form.setFieldsValue(formValuesFromManifest(obj, editing.name));
        const meta = obj?.metadata ?? {};
        editMetaRef.current = {
          labels: meta.labels,
          annotations: meta.annotations,
          finalizers: meta.finalizers,
          ownerReferences: meta.ownerReferences,
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
      const fv = form.getFieldsValue();
      try {
        const manifest = buildHyperNodeManifest(fvToInput(fv));
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
      manifest = buildHyperNodeManifest(fvToInput(v));
      // Edit mode: merge back the metadata fields the form doesn't
      // model so we don't accidentally wipe labels / annotations /
      // finalizers on save.
      if (isEdit && editMetaRef.current) {
        const m = manifest as Record<string, any>;
        const meta = (m.metadata = { ...(m.metadata ?? {}) });
        const extras = editMetaRef.current;
        if (extras.labels) {
          meta.labels = { ...extras.labels, ...(meta.labels ?? {}) };
        }
        if (extras.annotations) {
          meta.annotations = { ...extras.annotations, ...(meta.annotations ?? {}) };
        }
        if (extras.finalizers) meta.finalizers = extras.finalizers;
        if (extras.ownerReferences) meta.ownerReferences = extras.ownerReferences;
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
            ? 'pages.compute.hyperNodeForm.updated'
            : 'pages.compute.hyperNodeForm.success',
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
          ? 'pages.compute.hyperNodeForm.editTitle'
          : 'pages.compute.hyperNodeForm.title',
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
                ? 'pages.compute.hyperNodeForm.update'
                : 'pages.compute.hyperNodeForm.submit',
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
                id: 'pages.compute.hyperNodeForm.name',
              })}
              rules={[
                { required: true },
                {
                  pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
                  message: 'DNS-1123',
                },
              ]}
            >
              <Input
                maxLength={253}
                placeholder="rack-1 / spine-az1"
                disabled={isEdit}
              />
            </Form.Item>
            <Form.Item
              name="tier"
              label={intl.formatMessage({
                id: 'pages.compute.hyperNodeForm.tier',
              })}
              rules={[{ required: true }]}
              extra={intl.formatMessage({
                id: 'pages.compute.hyperNodeForm.tier.extra',
              })}
            >
              <InputNumber min={0} style={{ width: 160 }} />
            </Form.Item>
            <Form.Item
              name="tierName"
              label={intl.formatMessage({
                id: 'pages.compute.hyperNodeForm.tierName',
              })}
              extra={intl.formatMessage({
                id: 'pages.compute.hyperNodeForm.tierName.extra',
              })}
            >
              <Input maxLength={253} placeholder="rack / spine / pod-of-racks" />
            </Form.Item>

            <div style={{ marginTop: 16, marginBottom: 4, fontWeight: 500 }}>
              {intl.formatMessage({
                id: 'pages.compute.hyperNodeForm.members',
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
                id: 'pages.compute.hyperNodeForm.members.extra',
              })}
            </div>

            <Form.List name="members">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((field, idx) => (
                    <MemberCard
                      key={field.key}
                      form={form}
                      index={idx}
                      fieldName={field.name}
                      onRemove={() => remove(field.name)}
                    />
                  ))}
                  <Button
                    type="dashed"
                    onClick={() =>
                      add({
                        type: 'Node',
                        selectorType: 'exactMatch',
                        labels: [],
                      })
                    }
                    icon={<PlusOutlined />}
                    block
                  >
                    {intl.formatMessage({
                      id: 'pages.compute.hyperNodeForm.members.add',
                    })}
                  </Button>
                </>
              )}
            </Form.List>
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

function MemberCard({
  form,
  index,
  fieldName,
  onRemove,
}: {
  form: ReturnType<typeof Form.useForm<FormValues>>[0];
  index: number;
  fieldName: number;
  onRemove: () => void;
}) {
  const intl = useIntl();
  // Watch selectorType so we can conditionally render the right
  // sub-input. The CRD admission webhook rejects manifests with
  // multiple selector branches set, so the form must keep exactly
  // one branch populated per member.
  const selectorType =
    Form.useWatch(['members', fieldName, 'selectorType'], form) ??
    'exactMatch';
  const memberType =
    Form.useWatch(['members', fieldName, 'type'], form) ?? 'Node';

  return (
    <Card
      size="small"
      style={{ marginBottom: 8 }}
      title={
        <Space>
          <Text strong>
            {intl.formatMessage(
              { id: 'pages.compute.hyperNodeForm.member.title' },
              { n: index + 1 },
            )}
          </Text>
        </Space>
      }
      extra={
        <Button
          type="text"
          size="small"
          danger
          icon={<MinusCircleOutlined />}
          onClick={onRemove}
        />
      }
    >
      <Space style={{ width: '100%' }} size={16} align="start" wrap>
        <Form.Item
          name={[fieldName, 'type']}
          label={intl.formatMessage({
            id: 'pages.compute.hyperNodeForm.member.type',
          })}
          rules={[{ required: true }]}
          style={{ marginBottom: 8 }}
        >
          <Select
            style={{ width: 140 }}
            options={[
              { value: 'Node', label: 'Node' },
              { value: 'HyperNode', label: 'HyperNode' },
            ]}
          />
        </Form.Item>
        <Form.Item
          name={[fieldName, 'selectorType']}
          label={intl.formatMessage({
            id: 'pages.compute.hyperNodeForm.member.selectorType',
          })}
          rules={[{ required: true }]}
          style={{ marginBottom: 8 }}
        >
          <Select
            style={{ width: 200 }}
            options={[
              {
                value: 'exactMatch',
                label: intl.formatMessage({
                  id: 'pages.compute.hyperNode.selector.exactMatch',
                }),
              },
              {
                value: 'regexMatch',
                label: intl.formatMessage({
                  id: 'pages.compute.hyperNode.selector.regexMatch',
                }),
              },
              {
                value: 'labelMatch',
                label: intl.formatMessage({
                  id: 'pages.compute.hyperNode.selector.labelMatch',
                }),
                disabled: memberType === 'HyperNode',
              },
            ]}
          />
        </Form.Item>
      </Space>

      {selectorType === 'exactMatch' && (
        <Form.Item
          name={[fieldName, 'exactName']}
          label={intl.formatMessage({
            id: 'pages.compute.hyperNodeForm.member.exactName',
          })}
          rules={[{ required: true }]}
          extra={intl.formatMessage({
            id: 'pages.compute.hyperNodeForm.member.exactName.extra',
          })}
        >
          <Input maxLength={253} placeholder="node-1 / hypernode-rack-1" />
        </Form.Item>
      )}

      {selectorType === 'regexMatch' && (
        <Form.Item
          name={[fieldName, 'regexPattern']}
          label={intl.formatMessage({
            id: 'pages.compute.hyperNodeForm.member.regex',
          })}
          rules={[{ required: true }]}
          extra={intl.formatMessage({
            id: 'pages.compute.hyperNodeForm.member.regex.extra',
          })}
        >
          <Input placeholder="^node-[0-9]+$" />
        </Form.Item>
      )}

      {selectorType === 'labelMatch' && (
        <>
          <div
            style={{
              marginBottom: 8,
              color: 'var(--ant-color-text-tertiary)',
              fontSize: 12,
            }}
          >
            {intl.formatMessage({
              id: 'pages.compute.hyperNodeForm.member.labels.extra',
            })}
          </div>
          <Form.List name={[fieldName, 'labels']}>
            {(labelFields, { add, remove }) => (
              <>
                {labelFields.map((lf) => (
                  <Space
                    key={lf.key}
                    style={{ display: 'flex', marginBottom: 6 }}
                    align="baseline"
                  >
                    <Form.Item
                      name={[lf.name, 'k']}
                      rules={[{ required: true }]}
                      style={{ marginBottom: 0 }}
                    >
                      <Input placeholder="topology-rack" style={{ width: 220 }} />
                    </Form.Item>
                    <Form.Item
                      name={[lf.name, 'v']}
                      rules={[{ required: true }]}
                      style={{ marginBottom: 0 }}
                    >
                      <Input placeholder="rack-1" style={{ width: 160 }} />
                    </Form.Item>
                    <MinusCircleOutlined onClick={() => remove(lf.name)} />
                  </Space>
                ))}
                <Button
                  type="dashed"
                  size="small"
                  onClick={() => add({ k: '', v: '' })}
                  icon={<PlusOutlined />}
                >
                  {intl.formatMessage({
                    id: 'pages.compute.hyperNodeForm.member.labels.add',
                  })}
                </Button>
              </>
            )}
          </Form.List>
        </>
      )}
    </Card>
  );
}

function fvToInput(v: FormValues): HyperNodeInput {
  const members = (v.members ?? []).map((m) => {
    const matchLabels: Record<string, string> = {};
    if (m.selectorType === 'labelMatch') {
      for (const row of m.labels ?? []) {
        const k = row?.k?.trim();
        const val = row?.v?.trim();
        if (k && val) matchLabels[k] = val;
      }
    }
    return {
      type: m.type,
      selectorType: m.selectorType,
      exactName:
        m.selectorType === 'exactMatch' ? m.exactName?.trim() : undefined,
      regexPattern:
        m.selectorType === 'regexMatch' ? m.regexPattern?.trim() : undefined,
      matchLabels:
        m.selectorType === 'labelMatch' && Object.keys(matchLabels).length > 0
          ? matchLabels
          : undefined,
    };
  });
  return {
    name: v.name?.trim() ?? '',
    tier: typeof v.tier === 'number' ? v.tier : 0,
    tierName: v.tierName?.trim() || undefined,
    members,
  };
}

function formValuesFromManifest(obj: any, fallbackName: string): FormValues {
  const spec = obj?.spec ?? {};
  const members: MemberFormRow[] = (spec.members ?? []).map((m: any) => {
    const sel = m?.selector ?? {};
    let selectorType: HyperNodeSelectorType = 'exactMatch';
    let exactName: string | undefined;
    let regexPattern: string | undefined;
    let labels: { k: string; v: string }[] | undefined;
    if (sel.exactMatch?.name) {
      selectorType = 'exactMatch';
      exactName = sel.exactMatch.name;
    } else if (sel.regexMatch?.pattern) {
      selectorType = 'regexMatch';
      regexPattern = sel.regexMatch.pattern;
    } else if (sel.labelMatch?.matchLabels) {
      selectorType = 'labelMatch';
      labels = Object.entries(sel.labelMatch.matchLabels as Record<
        string,
        unknown
      >).map(([k, v]) => ({
        k,
        v: typeof v === 'string' ? v : String(v),
      }));
    }
    return {
      type: m?.type === 'HyperNode' ? 'HyperNode' : 'Node',
      selectorType,
      exactName,
      regexPattern,
      labels: labels ?? [],
    };
  });
  return {
    name: obj?.metadata?.name ?? fallbackName,
    tier: typeof spec.tier === 'number' ? spec.tier : 0,
    tierName: spec.tierName ?? undefined,
    members,
  };
}
