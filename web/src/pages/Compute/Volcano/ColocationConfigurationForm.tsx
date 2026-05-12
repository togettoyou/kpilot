import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useIntl, useModel } from '@umijs/max';
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
  Tabs,
} from 'antd';
import yaml from 'js-yaml';
import React, { useEffect, useState } from 'react';

import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';
import {
  applyManifest,
  buildColocationConfigurationManifest,
  type ColocationConfigurationInput,
} from '@/services/kpilot/volcano';
import { getWorkload } from '@/services/kpilot/workload';

// ColocationConfiguration (`config.volcano.sh/v1alpha1`) —
// namespaced. memoryQos cgroup ratios (0–100) for the matchLabels-
// selected pods. The CRD also supports matchExpressions; the form
// only covers matchLabels, the YAML view handles the rest.

interface ColocationFormProps {
  open: boolean;
  clusterId: string;
  editing?: { name: string; namespace: string } | null;
  onClose: () => void;
  onSaved: () => void;
}

interface LabelRow {
  key: string;
  value: string;
}

interface FormValues {
  name: string;
  namespace: string;
  highRatio?: number;
  lowRatio?: number;
  minRatio?: number;
  matchLabels?: LabelRow[];
}

const CR = {
  group: 'config.volcano.sh',
  version: 'v1alpha1',
  kind: 'ColocationConfiguration',
  scope: 'Namespaced' as const,
};

export function ColocationConfigurationFormDrawer({
  open,
  clusterId,
  editing,
  onClose,
  onSaved,
}: ColocationFormProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const namespaceModel = useModel('namespace');
  const currentNs = clusterId
    ? namespaceModel.get(clusterId).selected || 'default'
    : 'default';
  const [form] = Form.useForm<FormValues>();
  const [view, setView] = useState<'form' | 'yaml'>('form');
  const [yamlText, setYamlText] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const isEdit = !!editing;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setView('form');
    setYamlText('');
    setYamlError(null);
    if (!editing) {
      form.setFieldsValue({
        namespace: currentNs,
        highRatio: 100,
        lowRatio: 0,
        minRatio: 0,
        matchLabels: [],
      });
      return;
    }
    let cancelled = false;
    setLoading(true);
    getWorkload(clusterId, '_cr', editing.name, editing.namespace, CR)
      .then((obj: any) => {
        if (cancelled) return;
        const spec = obj?.spec ?? {};
        const mq = spec.memoryQos ?? {};
        const labels = spec?.selector?.matchLabels ?? {};
        form.setFieldsValue({
          name: obj?.metadata?.name ?? editing.name,
          namespace: obj?.metadata?.namespace ?? editing.namespace,
          highRatio: typeof mq.highRatio === 'number' ? mq.highRatio : 100,
          lowRatio: typeof mq.lowRatio === 'number' ? mq.lowRatio : 0,
          minRatio: typeof mq.minRatio === 'number' ? mq.minRatio : 0,
          matchLabels: Object.entries(labels).map(([k, v]) => ({
            key: k,
            value: typeof v === 'string' ? v : String(v),
          })),
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, editing, clusterId, form, currentNs]);

  const handleSwitchView = (next: string) => {
    if (next === view) return;
    if (next === 'yaml') {
      const fv = form.getFieldsValue();
      try {
        setYamlText(
          yaml.dump(buildColocationConfigurationManifest(fvToInput(fv))),
        );
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
        const spec = parsed.spec ?? {};
        const mq = spec.memoryQos ?? {};
        const labels = spec?.selector?.matchLabels ?? {};
        form.setFieldsValue({
          name: parsed?.metadata?.name ?? form.getFieldValue('name'),
          namespace:
            parsed?.metadata?.namespace ?? form.getFieldValue('namespace'),
          highRatio: typeof mq.highRatio === 'number' ? mq.highRatio : 100,
          lowRatio: typeof mq.lowRatio === 'number' ? mq.lowRatio : 0,
          minRatio: typeof mq.minRatio === 'number' ? mq.minRatio : 0,
          matchLabels: Object.entries(labels).map(([k, v]) => ({
            key: k,
            value: typeof v === 'string' ? v : String(v),
          })),
        });
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
      manifest = buildColocationConfigurationManifest(fvToInput(v));
    } else {
      try {
        manifest = yaml.load(yamlText);
      } catch (e: any) {
        message.error(`YAML parse failed: ${e?.message ?? e}`);
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
            ? 'pages.compute.colocation.updated'
            : 'pages.compute.colocation.created',
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
          ? 'pages.compute.colocation.edit.title'
          : 'pages.compute.colocation.create.title',
      })}
      size={580}
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
                ? 'pages.compute.yamlDrawer.save'
                : 'pages.compute.yamlDrawer.submit',
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
          message={yamlError}
        />
      )}
      <Spin spinning={loading}>
        {view === 'form' ? (
          <Form<FormValues> form={form} layout="vertical">
            <Form.Item
              name="name"
              label={intl.formatMessage({
                id: 'pages.compute.colocation.name',
              })}
              rules={[
                { required: true },
                {
                  pattern: /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/,
                  message: 'DNS-1123',
                },
              ]}
            >
              <Input maxLength={253} placeholder="my-qos" disabled={isEdit} />
            </Form.Item>
            <Form.Item
              name="namespace"
              label={intl.formatMessage({
                id: 'pages.compute.colocation.namespace',
              })}
              rules={[{ required: true }]}
            >
              <Input maxLength={63} disabled={isEdit} />
            </Form.Item>
            <Space style={{ display: 'flex' }} align="baseline">
              <Form.Item
                name="highRatio"
                label="highRatio"
                extra={intl.formatMessage({
                  id: 'pages.compute.colocation.highRatio.extra',
                })}
                style={{ marginBottom: 16 }}
              >
                <InputNumber min={0} max={100} style={{ width: 120 }} />
              </Form.Item>
              <Form.Item
                name="lowRatio"
                label="lowRatio"
                extra={intl.formatMessage({
                  id: 'pages.compute.colocation.lowRatio.extra',
                })}
                style={{ marginBottom: 16, marginInlineStart: 16 }}
              >
                <InputNumber min={0} max={100} style={{ width: 120 }} />
              </Form.Item>
              <Form.Item
                name="minRatio"
                label="minRatio"
                extra={intl.formatMessage({
                  id: 'pages.compute.colocation.minRatio.extra',
                })}
                style={{ marginBottom: 16, marginInlineStart: 16 }}
              >
                <InputNumber min={0} max={100} style={{ width: 120 }} />
              </Form.Item>
            </Space>
            <div style={{ marginTop: 8, marginBottom: 4, fontWeight: 500 }}>
              {intl.formatMessage({
                id: 'pages.compute.colocation.matchLabels',
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
                id: 'pages.compute.colocation.matchLabels.extra',
              })}
            </div>
            <Form.List name="matchLabels">
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
                        <Input placeholder="app" style={{ width: 200 }} />
                      </Form.Item>
                      <Form.Item
                        name={[field.name, 'value']}
                        rules={[{ required: true }]}
                        style={{ marginBottom: 0 }}
                      >
                        <Input placeholder="web" style={{ width: 200 }} />
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
                      id: 'pages.compute.colocation.matchLabels.add',
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

function fvToInput(v: FormValues): ColocationConfigurationInput {
  const matchLabels: Record<string, string> = {};
  for (const row of v.matchLabels ?? []) {
    const k = row.key?.trim();
    const val = row.value?.trim();
    if (k && val) matchLabels[k] = val;
  }
  return {
    name: (v.name ?? '').trim(),
    namespace: (v.namespace ?? '').trim() || 'default',
    highRatio: typeof v.highRatio === 'number' ? v.highRatio : undefined,
    lowRatio: typeof v.lowRatio === 'number' ? v.lowRatio : undefined,
    minRatio: typeof v.minRatio === 'number' ? v.minRatio : undefined,
    matchLabels: Object.keys(matchLabels).length > 0 ? matchLabels : undefined,
  };
}
