import { useIntl } from '@umijs/max';
import { Alert, App, Button, Drawer, Space, Spin } from 'antd';
import yaml from 'js-yaml';
import React, { useEffect, useState } from 'react';

import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';
import { applyManifest } from '@/services/kpilot/volcano';
import { getWorkload, type CRRef } from '@/services/kpilot/workload';

// YamlCreateDrawer — a thin YAML-only create/edit drawer for Volcano
// resources whose shape is too rich for a typed form (JobFlow DAG,
// JobTemplate JobSpec). New resources get `defaultYaml` as a starter
// template; editing mode fetches the live object first.
//
// Submission goes through the same /apply SSA path as the typed
// drawers — exact same /workloads/_cr+spec mechanics. We deliberately
// don't wrap a Form view around this: the kinds covered here have
// nested arrays / probe definitions / dependency graphs that a
// generic form-editor can't surface without becoming a clone of YAML.

interface YamlCreateDrawerProps {
  open: boolean;
  clusterId: string;
  // Header label rendered in the drawer title (kind name + ns).
  title: string;
  editTitle: string;
  // CR identifier used to fetch + describe in edit mode.
  cr: CRRef;
  // Starter manifest text shown when opening for create. Should be a
  // valid YAML that maps to the same kind as `cr`.
  defaultYaml: string;
  // When set, the drawer opens in edit mode and fetches the named
  // resource before populating the editor. namespace is "" for
  // cluster-scoped kinds.
  editing?: { name: string; namespace: string } | null;
  onClose: () => void;
  onSaved: () => void;
}

export function YamlCreateDrawer({
  open,
  clusterId,
  title,
  editTitle,
  cr,
  defaultYaml,
  editing,
  onClose,
  onSaved,
}: YamlCreateDrawerProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const isEdit = !!editing;

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (!editing) {
      setText(defaultYaml);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getWorkload(
      clusterId,
      '_cr',
      editing.name,
      editing.namespace,
      cr,
    )
      .then((obj: any) => {
        if (cancelled) return;
        // Drop server-managed fields so the YAML round-trips cleanly
        // without polluting the editor with managedFields,
        // resourceVersion, generation etc that SSA fills back in.
        if (obj?.metadata) {
          delete obj.metadata.managedFields;
          delete obj.metadata.resourceVersion;
          delete obj.metadata.generation;
          delete obj.metadata.uid;
          delete obj.metadata.creationTimestamp;
          delete obj.metadata.selfLink;
        }
        delete obj?.status;
        setText(yaml.dump(obj));
      })
      .catch((e: any) => {
        const msg = e?.response?.data?.message ?? e?.message ?? String(e);
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, editing, clusterId, cr, defaultYaml]);

  const handleSubmit = async () => {
    let manifest: unknown;
    try {
      manifest = yaml.load(text);
    } catch (e: any) {
      message.error(`YAML parse failed: ${e?.message ?? e}`);
      return;
    }
    if (!manifest || typeof manifest !== 'object') {
      message.error('YAML is empty or not an object');
      return;
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
        intl.formatMessage({ id: 'pages.compute.yamlDrawer.success' }),
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
      title={isEdit ? editTitle : title}
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
                ? 'pages.compute.yamlDrawer.save'
                : 'pages.compute.yamlDrawer.submit',
            })}
          </Button>
        </Space>
      }
    >
      {error && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 12 }}
          message={error}
        />
      )}
      <Spin spinning={loading}>
        <div
          style={{
            border: '1px solid var(--ant-color-border)',
            borderRadius: 4,
          }}
        >
          <YamlEditor value={text} onChange={setText} />
        </div>
      </Spin>
    </Drawer>
  );
}
