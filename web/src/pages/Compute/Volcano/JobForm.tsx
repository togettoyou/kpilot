import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useIntl, useModel } from '@umijs/max';
import {
  App,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
} from 'antd';
import React, { useEffect, useState } from 'react';

import {
  applyManifest,
  buildJobManifest,
  type JobInput,
} from '@/services/kpilot/volcano';

interface JobFormDrawerProps {
  open: boolean;
  clusterId: string;
  onClose: () => void;
  onSaved: () => void;
}

interface TaskFV {
  name: string;
  replicas: number;
  image: string;
  command?: string;       // single string, split on whitespace
  args?: string;          // ditto
  cpu?: string;
  memory?: string;
  vgpuNumber?: string;
  vgpuMemory?: string;
  vgpuCores?: string;
  restartPolicy: 'OnFailure' | 'Never' | 'Always';
}

interface FormValues {
  name: string;
  namespace: string;
  queue?: string;
  priorityClassName?: string;
  minAvailable?: number;
  plugins?: string[];
  tasks: TaskFV[];
}

// JobFormDrawer constructs a Volcano Job (`batch.volcano.sh/v1alpha1`).
// One drawer covers the realistic v1 use-case set:
//   • basic identity (name + namespace + queue + priority)
//   • gang sizing (minAvailable; defaults to sum of task replicas)
//   • Volcano plugins (env / svc / ssh / mpi — checkbox list)
//   • one or more tasks: replicas + image + command + resources
//
// We don't expose every Volcano knob (tolerations, affinity, podgroup
// overrides, lifecycle policies, ...) — those rare cases stay on the
// Apply YAML drawer. Goal here is the 90% submit-a-batch path.
export function JobFormDrawer({
  open,
  clusterId,
  onClose,
  onSaved,
}: JobFormDrawerProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const ns = useModel('namespace');
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);

  const namespaceOptions = (ns.get(clusterId).list ?? []).map((n) => ({
    label: n,
    value: n,
  }));

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({
      namespace: ns.get(clusterId).selected || 'default',
      tasks: [
        {
          name: 'main',
          replicas: 1,
          image: '',
          restartPolicy: 'OnFailure',
        },
      ],
    });
  }, [open, form, ns, clusterId]);

  const splitWS = (s: string | undefined) => {
    if (!s || !s.trim()) return undefined;
    // Split on runs of whitespace; users can write either
    // `python train.py --epochs 5` or paste a JSON array literal.
    // For arrays-with-spaces values they should drop into the
    // YAML editor instead — this is the simple-case form.
    return s.trim().split(/\s+/);
  };

  const handleSubmit = async () => {
    let v: FormValues;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    const input: JobInput = {
      name: v.name,
      namespace: v.namespace,
      queue: v.queue,
      priorityClassName: v.priorityClassName,
      minAvailable: v.minAvailable,
      plugins: v.plugins,
      tasks: v.tasks.map((t) => {
        const requests: Record<string, string> = {};
        const limits: Record<string, string> = {};
        if (t.cpu) {
          requests['cpu'] = t.cpu;
          limits['cpu'] = t.cpu;
        }
        if (t.memory) {
          requests['memory'] = t.memory;
          limits['memory'] = t.memory;
        }
        if (t.vgpuNumber) {
          limits['volcano.sh/vgpu-number'] = t.vgpuNumber;
        }
        if (t.vgpuMemory) {
          limits['volcano.sh/vgpu-memory'] = t.vgpuMemory;
        }
        if (t.vgpuCores) {
          limits['volcano.sh/vgpu-cores'] = t.vgpuCores;
        }
        const hasResources =
          Object.keys(requests).length > 0 || Object.keys(limits).length > 0;
        return {
          name: t.name,
          replicas: t.replicas,
          image: t.image,
          command: splitWS(t.command),
          args: splitWS(t.args),
          restartPolicy: t.restartPolicy,
          resources: hasResources
            ? {
                requests:
                  Object.keys(requests).length > 0 ? requests : undefined,
                limits: Object.keys(limits).length > 0 ? limits : undefined,
              }
            : undefined,
        };
      }),
    };
    setSubmitting(true);
    try {
      const res = await applyManifest(clusterId, buildJobManifest(input));
      const fail = res?.results?.find((r) => !r.success);
      if (fail) {
        message.error(fail.error ?? 'apply failed');
        return;
      }
      message.success(
        intl.formatMessage({ id: 'pages.compute.jobForm.success' }),
      );
      onSaved();
      onClose();
    } catch {
      // global handler
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={intl.formatMessage({ id: 'pages.compute.jobForm.title' })}
      size={760}
      maskClosable={false}
      destroyOnHidden
      footer={
        <Space style={{ float: 'right' }}>
          <Button onClick={onClose}>
            {intl.formatMessage({ id: 'pages.workloads.cancel' })}
          </Button>
          <Button type="primary" loading={submitting} onClick={handleSubmit}>
            {intl.formatMessage({ id: 'pages.compute.jobForm.submit' })}
          </Button>
        </Space>
      }
    >
      <Form<FormValues> form={form} layout="vertical">
        <div style={{ marginBottom: 8, fontWeight: 500 }}>
          {intl.formatMessage({ id: 'pages.compute.jobForm.section.basic' })}
        </div>

        <Space.Compact block style={{ marginBottom: 0 }}>
          <Form.Item
            name="name"
            label={intl.formatMessage({ id: 'pages.compute.jobForm.name' })}
            rules={[
              { required: true },
              {
                pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
                message: 'DNS-1123',
              },
            ]}
            style={{ flex: 1 }}
          >
            <Input maxLength={63} placeholder="my-job" />
          </Form.Item>
          <Form.Item
            name="namespace"
            label={intl.formatMessage({
              id: 'pages.compute.jobForm.namespace',
            })}
            rules={[{ required: true }]}
            style={{ flex: 1, marginInlineStart: 12 }}
          >
            <Select
              showSearch
              placeholder="default"
              options={namespaceOptions}
            />
          </Form.Item>
        </Space.Compact>

        <Space.Compact block>
          <Form.Item
            name="queue"
            label={intl.formatMessage({ id: 'pages.compute.jobForm.queue' })}
            extra={intl.formatMessage({
              id: 'pages.compute.jobForm.queue.extra',
            })}
            style={{ flex: 1 }}
          >
            <Input placeholder="default" maxLength={63} />
          </Form.Item>
          <Form.Item
            name="priorityClassName"
            label={intl.formatMessage({
              id: 'pages.compute.jobForm.priority',
            })}
            style={{ flex: 1, marginInlineStart: 12 }}
          >
            <Input maxLength={253} placeholder="" />
          </Form.Item>
        </Space.Compact>

        <Form.Item
          name="minAvailable"
          label={intl.formatMessage({
            id: 'pages.compute.jobForm.minAvailable',
          })}
          extra={intl.formatMessage({
            id: 'pages.compute.jobForm.minAvailable.extra',
          })}
        >
          <InputNumber min={1} placeholder="auto" style={{ width: 160 }} />
        </Form.Item>

        <Form.Item
          name="plugins"
          label={intl.formatMessage({
            id: 'pages.compute.jobForm.plugins',
          })}
          extra={intl.formatMessage({
            id: 'pages.compute.jobForm.plugins.extra',
          })}
        >
          <Select
            mode="multiple"
            placeholder="env / svc / ssh / mpi"
            options={[
              { label: 'env', value: 'env' },
              { label: 'svc', value: 'svc' },
              { label: 'ssh', value: 'ssh' },
              { label: 'mpi', value: 'mpi' },
              { label: 'pytorch', value: 'pytorch' },
              { label: 'tensorflow', value: 'tensorflow' },
            ]}
          />
        </Form.Item>

        <div
          style={{
            marginTop: 24,
            marginBottom: 8,
            fontWeight: 500,
          }}
        >
          {intl.formatMessage({ id: 'pages.compute.jobForm.section.tasks' })}
        </div>

        <Form.List name="tasks">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <Card
                  key={field.key}
                  size="small"
                  style={{ marginBottom: 12 }}
                  title={`task #${field.name + 1}`}
                  extra={
                    fields.length > 1 ? (
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<MinusCircleOutlined />}
                        onClick={() => remove(field.name)}
                      />
                    ) : null
                  }
                >
                  <Space.Compact block>
                    <Form.Item
                      name={[field.name, 'name']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.name',
                      })}
                      rules={[{ required: true }]}
                      style={{ flex: 1 }}
                    >
                      <Input maxLength={63} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'replicas']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.replicas',
                      })}
                      rules={[{ required: true }]}
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <InputNumber min={1} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'restartPolicy']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.restartPolicy',
                      })}
                      rules={[{ required: true }]}
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <Select
                        options={[
                          { label: 'OnFailure', value: 'OnFailure' },
                          { label: 'Never', value: 'Never' },
                          { label: 'Always', value: 'Always' },
                        ]}
                      />
                    </Form.Item>
                  </Space.Compact>

                  <Form.Item
                    name={[field.name, 'image']}
                    label={intl.formatMessage({
                      id: 'pages.compute.jobForm.task.image',
                    })}
                    rules={[{ required: true }]}
                  >
                    <Input
                      maxLength={512}
                      placeholder="nvcr.io/nvidia/pytorch:23.04-py3"
                    />
                  </Form.Item>

                  <Space.Compact block>
                    <Form.Item
                      name={[field.name, 'command']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.command',
                      })}
                      style={{ flex: 1 }}
                    >
                      <Input placeholder="python" />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'args']}
                      label={intl.formatMessage({
                        id: 'pages.compute.jobForm.task.args',
                      })}
                      style={{ flex: 2, marginInlineStart: 12 }}
                    >
                      <Input placeholder="train.py --epochs 5" />
                    </Form.Item>
                  </Space.Compact>

                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--ant-color-text-tertiary)',
                      marginBottom: 8,
                    }}
                  >
                    {intl.formatMessage({
                      id: 'pages.compute.jobForm.task.resources',
                    })}
                  </div>
                  <Space.Compact block>
                    <Form.Item
                      name={[field.name, 'cpu']}
                      label="cpu"
                      style={{ flex: 1 }}
                    >
                      <Input placeholder="2" maxLength={32} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'memory']}
                      label="memory"
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <Input placeholder="4Gi" maxLength={32} />
                    </Form.Item>
                  </Space.Compact>
                  <Space.Compact block>
                    <Form.Item
                      name={[field.name, 'vgpuNumber']}
                      label="vgpu-number"
                      style={{ flex: 1 }}
                    >
                      <Input placeholder="1" maxLength={32} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'vgpuMemory']}
                      label="vgpu-memory"
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <Input placeholder="8000" maxLength={32} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'vgpuCores']}
                      label="vgpu-cores"
                      style={{ flex: 1, marginInlineStart: 12 }}
                    >
                      <Input placeholder="50" maxLength={32} />
                    </Form.Item>
                  </Space.Compact>
                </Card>
              ))}
              <Button
                block
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() =>
                  add({
                    name: `task-${fields.length}`,
                    replicas: 1,
                    image: '',
                    restartPolicy: 'OnFailure',
                  })
                }
              >
                {intl.formatMessage({
                  id: 'pages.compute.jobForm.task.add',
                })}
              </Button>
            </>
          )}
        </Form.List>
      </Form>
    </Drawer>
  );
}
