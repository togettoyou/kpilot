import { ReloadOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import { App, Button, Drawer, Form, Input, Space } from 'antd';
import React, { useEffect, useState } from 'react';

import type { ClusterPluginItem } from '@/services/kpilot/plugin';
import { enablePlugin, getPlugin } from '@/services/kpilot/plugin';
import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';

interface EnableDrawerProps {
  open: boolean;
  clusterId: string;
  // The card we're configuring; null while closed.
  target: ClusterPluginItem | null;
  // readOnly turns this into a "current applied config" inspector —
  // same shape (version / namespace / values) but inputs disabled and
  // only a Close button. Used by the cluster page's 查看 button so
  // users see the override that's actually live, not the registry
  // default they'd see in PluginEditDrawer.
  readOnly?: boolean;
  onClose: () => void;
  onEnabled: () => void;
}

export function EnableDrawer({
  open,
  clusterId,
  target,
  readOnly = false,
  onClose,
  onEnabled,
}: EnableDrawerProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ version: string }>();
  const [values, setValues] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Latest registry default_values for the target plugin. Fetched on
  // open via GetPlugin because the enclosing list endpoint omits this
  // blob to keep the polling payload small. Also re-used by handleReset
  // so the user always resets to the current registry default, not the
  // value that shipped when their per-cluster override was first saved.
  const [registryDefault, setRegistryDefault] = useState('');

  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    // Pre-fill version + show whatever values_override the user already
    // has saved. Default_values comes back via the async fetch below.
    form.setFieldsValue({ version: target.version_override || '' });
    setValues(target.values_override || '');
    setRegistryDefault('');
    getPlugin(target.plugin.id)
      .then((p) => {
        if (cancelled || !p) return;
        const def = p.default_values || '';
        setRegistryDefault(def);
        // If the user has no override yet, seed the editor with the
        // registry default. With an override, leave their text alone.
        if (!target.values_override) setValues(def);
      })
      .catch((err) => {
        // Without this catch, a failed lookup leaves registryDefault
        // as '' and the Reset button would silently wipe the editor
        // — easy way to write blank values_override over a working
        // install. Log and let the user know we couldn't load defaults.
        if (cancelled) return;
        console.warn('[plugins] getPlugin defaults failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [open, target, form]);

  // Reset wipes the per-cluster overrides and re-pre-fills the form
  // from the registry's current defaults — escape hatch for users
  // who got "stuck" on the values they set when the builtin shipped
  // a different default (e.g. our k8s-stack → single migration).
  const handleReset = () => {
    if (!target) return;
    // Guard against resetting to an empty string when the
    // getPlugin defaults fetch failed — clearing values would
    // overwrite a working install with blank values_override.
    if (!registryDefault) {
      message.warning(
        intl.formatMessage({ id: 'pages.plugins.enable.reset.unavailable' }),
      );
      return;
    }
    setValues(registryDefault);
    form.setFieldsValue({ version: '' });
  };

  const handleSubmit = async () => {
    if (!target) return;
    const fv = await form.validateFields();
    setSubmitting(true);
    try {
      await enablePlugin(clusterId, target.plugin.name, {
        values_override: values,
        version_override: fv.version,
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
              {
                id: readOnly
                  ? 'pages.clusterPlugins.enableDrawer.viewTitle'
                  : 'pages.clusterPlugins.enableDrawer.title',
              },
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
        readOnly ? (
          <Space style={{ float: 'right' }}>
            <Button type="primary" onClick={onClose}>
              {intl.formatMessage({ id: 'pages.plugins.modal.close' })}
            </Button>
          </Space>
        ) : (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Button icon={<ReloadOutlined />} onClick={handleReset}>
              {intl.formatMessage({
                id: 'pages.clusterPlugins.enableDrawer.reset',
              })}
            </Button>
            <Space>
              <Button onClick={onClose}>
                {intl.formatMessage({ id: 'pages.workloads.cancel' })}
              </Button>
              <Button type="primary" loading={submitting} onClick={handleSubmit}>
                {intl.formatMessage({
                  id: 'pages.clusterPlugins.enableDrawer.submit',
                })}
              </Button>
            </Space>
          </div>
        )
      }
    >
      {target && (
        <Form form={form} layout="vertical" disabled={readOnly}>
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
              maxLength={64}
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
              <YamlEditor value={values} onChange={setValues} readOnly={readOnly} />
            </div>
          </Form.Item>
        </Form>
      )}
    </Drawer>
  );
}
