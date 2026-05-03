import { useIntl } from '@umijs/max';
import { App, Button, Drawer, Form, Input, Space } from 'antd';
import React, { useEffect, useState } from 'react';

import type { ClusterPluginItem } from '@/services/kpilot/plugin';
import { enablePlugin } from '@/services/kpilot/plugin';
import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';

interface EnableDrawerProps {
  open: boolean;
  clusterId: string;
  // The card we're configuring; null while closed.
  target: ClusterPluginItem | null;
  onClose: () => void;
  onEnabled: () => void;
}

export function EnableDrawer({
  open,
  clusterId,
  target,
  onClose,
  onEnabled,
}: EnableDrawerProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ version: string; namespace: string }>();
  const [values, setValues] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Pre-fill values from the existing per-cluster override (if the user
  // is re-enabling something they previously customized) or from the
  // registry's default. Same for namespace + version.
  useEffect(() => {
    if (!open || !target) return;
    setValues(target.values_override || target.plugin.default_values || '');
    form.setFieldsValue({
      version: target.version_override || '',
      namespace: target.release_namespace_override || '',
    });
  }, [open, target, form]);

  const handleSubmit = async () => {
    if (!target) return;
    const fv = await form.validateFields();
    setSubmitting(true);
    try {
      await enablePlugin(clusterId, target.plugin.name, {
        values_override: values,
        version_override: fv.version,
        release_namespace_override: fv.namespace,
      });
      message.success(
        intl.formatMessage({ id: 'pages.clusterPlugins.enable.success' }),
      );
      onEnabled();
      onClose();
    } catch {
      // global toast
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      title={
        target
          ? intl.formatMessage(
              { id: 'pages.clusterPlugins.enableDrawer.title' },
              { name: target.plugin.display_name },
            )
          : ''
      }
      open={open}
      onClose={onClose}
      size={620}
      maskClosable={false}
      // Re-mount on each open so scroll resets and the values editor
      // doesn't carry over leftover state from the previous target.
      destroyOnHidden
      footer={
        <Space style={{ float: 'right' }}>
          <Button onClick={onClose}>
            {intl.formatMessage({ id: 'pages.workloads.cancel' })}
          </Button>
          <Button type="primary" loading={submitting} onClick={handleSubmit}>
            {intl.formatMessage({
              id: 'pages.clusterPlugins.enableDrawer.submit',
            })}
          </Button>
        </Space>
      }
    >
      {target && (
        <Form form={form} layout="vertical">
          <Form.Item
            name="version"
            label={intl.formatMessage({
              id: 'pages.clusterPlugins.enableDrawer.version',
            })}
          >
            <Input
              placeholder={intl.formatMessage(
                { id: 'pages.clusterPlugins.enableDrawer.versionPlaceholder' },
                { default: target.plugin.default_version || '—' },
              )}
            />
          </Form.Item>
          <Form.Item
            name="namespace"
            label={intl.formatMessage({
              id: 'pages.clusterPlugins.enableDrawer.namespace',
            })}
          >
            <Input
              placeholder={intl.formatMessage(
                {
                  id: 'pages.clusterPlugins.enableDrawer.namespacePlaceholder',
                },
                {
                  default: target.plugin.default_release_namespace || '—',
                },
              )}
            />
          </Form.Item>
          <Form.Item
            label={intl.formatMessage({
              id: 'pages.clusterPlugins.enableDrawer.values',
            })}
          >
            <div
              style={{
                border: '1px solid var(--ant-color-border)',
                borderRadius: 4,
              }}
            >
              <YamlEditor value={values} onChange={setValues} />
            </div>
          </Form.Item>
        </Form>
      )}
    </Drawer>
  );
}
