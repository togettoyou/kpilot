import { useIntl } from '@umijs/max';
import {
  Alert,
  App,
  Button,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Spin,
  Tabs,
} from 'antd';
import yaml from 'js-yaml';
import React, { useEffect, useState } from 'react';

import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';
import {
  applyManifest,
  buildNodeShardManifest,
  type NodeShardInput,
} from '@/services/kpilot/volcano';
import { getWorkload } from '@/services/kpilot/workload';

// NodeShard (`shard.volcano.sh/v1alpha1`) — cluster-scoped node
// grouping; the only spec field is `nodesDesired` (string list).
// Trivial typed form (DNS-1123 name + Select-mode-tags for nodes),
// with the same form/YAML toggle the other Volcano drawers use.

interface NodeShardFormProps {
  open: boolean;
  clusterId: string;
  editing?: { name: string } | null;
  onClose: () => void;
  onSaved: () => void;
}

interface FormValues {
  name: string;
  nodesDesired?: string[];
}

const NODE_SHARD_CR = {
  group: 'shard.volcano.sh',
  version: 'v1alpha1',
  kind: 'NodeShard',
  scope: 'Cluster' as const,
};

export function NodeShardFormDrawer({
  open,
  clusterId,
  editing,
  onClose,
  onSaved,
}: NodeShardFormProps) {
  const intl = useIntl();
  const { message } = App.useApp();
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
      form.setFieldsValue({ nodesDesired: [] });
      return;
    }
    let cancelled = false;
    setLoading(true);
    getWorkload(clusterId, '_cr', editing.name, '', NODE_SHARD_CR)
      .then((obj: any) => {
        if (cancelled) return;
        form.setFieldsValue({
          name: obj?.metadata?.name ?? editing.name,
          nodesDesired: Array.isArray(obj?.spec?.nodesDesired)
            ? (obj.spec.nodesDesired as unknown[]).filter(
                (x): x is string => typeof x === 'string',
              )
            : [],
        });
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
        setYamlText(yaml.dump(buildNodeShardManifest(fvToInput(fv))));
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
        form.setFieldsValue({
          name: parsed?.metadata?.name ?? form.getFieldValue('name'),
          nodesDesired: Array.isArray(parsed?.spec?.nodesDesired)
            ? parsed.spec.nodesDesired
            : [],
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
      manifest = buildNodeShardManifest(fvToInput(v));
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
            ? 'pages.compute.nodeShard.updated'
            : 'pages.compute.nodeShard.created',
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
          ? 'pages.compute.nodeShard.edit.title'
          : 'pages.compute.nodeShard.create.title',
      })}
      size={560}
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
                id: 'pages.compute.nodeShard.name',
              })}
              rules={[
                { required: true },
                { pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, message: 'DNS-1123' },
              ]}
              extra={intl.formatMessage({
                id: 'pages.compute.nodeShard.name.extra',
              })}
            >
              <Input maxLength={253} placeholder="my-shard" disabled={isEdit} />
            </Form.Item>
            <Form.Item
              name="nodesDesired"
              label={intl.formatMessage({
                id: 'pages.compute.nodeShard.nodesDesired',
              })}
              extra={intl.formatMessage({
                id: 'pages.compute.nodeShard.nodesDesired.extra',
              })}
              rules={[{ required: true, message: '至少一个节点' }]}
            >
              <Select
                mode="tags"
                tokenSeparators={[',', ' ']}
                placeholder={intl.formatMessage({
                  id: 'pages.compute.nodeShard.nodesDesired.placeholder',
                })}
                style={{ width: '100%' }}
              />
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

function fvToInput(v: FormValues): NodeShardInput {
  return {
    name: (v.name ?? '').trim(),
    nodesDesired: (v.nodesDesired ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  };
}
