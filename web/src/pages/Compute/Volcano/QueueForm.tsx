import { useIntl } from '@umijs/max';
import {
  App,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Space,
  Spin,
  Switch,
} from 'antd';
import React, { useEffect, useState } from 'react';

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

// QueueFormDrawer creates or edits a Volcano Queue. Edit mode reuses
// the same form layout — only the name input is locked because K8s
// doesn't allow renaming. SSA-apply on submit, so any spec field the
// form doesn't expose stays under whoever else's field manager owns
// it (e.g. a manual `kubectl edit` carve-out).
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

  const isEdit = !!editing;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    form.resetFields();
    if (!editing) {
      form.setFieldsValue({ weight: 1, reclaimable: true });
      return;
    }
    setLoading(true);
    getWorkload(clusterId, '_cr', editing.name, '', QUEUE_CR)
      .then((obj: any) => {
        if (cancelled) return;
        const spec = obj?.spec ?? {};
        const cap = (spec.capability ?? {}) as Record<string, string>;
        form.setFieldsValue({
          name: editing.name,
          weight: spec.weight ?? 1,
          reclaimable:
            typeof spec.reclaimable === 'boolean' ? spec.reclaimable : true,
          parent: spec.parent ?? undefined,
          capability_cpu: cap['cpu'],
          capability_memory: cap['memory'],
          capability_vgpu_number: cap['volcano.sh/vgpu-number'],
          capability_vgpu_memory: cap['volcano.sh/vgpu-memory'],
          capability_vgpu_cores: cap['volcano.sh/vgpu-cores'],
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, editing, clusterId, form]);

  const handleSubmit = async () => {
    let v: FormValues;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    const capability: Record<string, string> = {};
    if (v.capability_cpu) capability['cpu'] = v.capability_cpu;
    if (v.capability_memory) capability['memory'] = v.capability_memory;
    if (v.capability_vgpu_number) {
      capability['volcano.sh/vgpu-number'] = v.capability_vgpu_number;
    }
    if (v.capability_vgpu_memory) {
      capability['volcano.sh/vgpu-memory'] = v.capability_vgpu_memory;
    }
    if (v.capability_vgpu_cores) {
      capability['volcano.sh/vgpu-cores'] = v.capability_vgpu_cores;
    }
    const input: QueueInput = {
      name: v.name,
      weight: v.weight,
      reclaimable: v.reclaimable,
      parent: v.parent,
      capability,
    };
    setSubmitting(true);
    try {
      const res = await applyManifest(clusterId, buildQueueManifest(input));
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
                ? 'pages.compute.queueForm.update'
                : 'pages.compute.queueForm.submit',
            })}
          </Button>
        </Space>
      }
    >
      <Spin spinning={loading}>
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
            label={intl.formatMessage({ id: 'pages.compute.queueForm.weight' })}
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
            label={intl.formatMessage({ id: 'pages.compute.queueForm.parent' })}
            extra={intl.formatMessage({
              id: 'pages.compute.queueForm.parent.extra',
            })}
          >
            <Input placeholder="root" />
          </Form.Item>

          <div style={{ marginTop: 24, marginBottom: 8, fontWeight: 500 }}>
            {intl.formatMessage({ id: 'pages.compute.queueForm.capability' })}
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
          <Form.Item name="capability_vgpu_number" label="volcano.sh/vgpu-number">
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
      </Spin>
    </Drawer>
  );
}
