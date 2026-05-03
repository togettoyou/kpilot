import { InboxOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import {
  App,
  Button,
  Drawer,
  Form,
  Input,
  Radio,
  Select,
  Space,
  Tag,
  Upload,
} from 'antd';
import React, { useEffect, useState } from 'react';

import type {
  ChartType,
  Plugin,
  PluginCategory,
  PluginInput,
} from '@/services/kpilot/plugin';
import {
  createPlugin,
  updatePlugin,
  uploadPluginChart,
} from '@/services/kpilot/plugin';
import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';

interface PluginEditDrawerProps {
  open: boolean;
  // editing === null means "create"; otherwise edit (or view, when
  // readOnly) this plugin.
  editing: Plugin | null;
  // readOnly disables every input + hides the save button. Used for
  // built-in plugins, where the registry entry is immutable but users
  // still want to inspect chart_repo / default values / etc.
  readOnly?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const CATEGORIES: PluginCategory[] = [
  'gpu',
  'scheduling',
  'networking',
  'storage',
  'monitoring',
  'logging',
  'security',
  'serving',
  'custom',
];

interface UploadedBlob {
  id: number;
  filename: string;
  sha256: string;
}

export function PluginEditDrawer({
  open,
  editing,
  readOnly = false,
  onClose,
  onSaved,
}: PluginEditDrawerProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const [form] = Form.useForm<PluginInput>();
  const [chartType, setChartType] = useState<ChartType>('repo');
  const [values, setValues] = useState('');
  const [uploaded, setUploaded] = useState<UploadedBlob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Sync form whenever the drawer (re)opens. ResetFields alone wouldn't
  // populate the editing case; setFieldsValue covers both.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        display_name: editing.display_name,
        description: editing.description,
        category: editing.category,
        icon_url: editing.icon_url,
        chart_type: editing.chart_type,
        chart_repo: editing.chart_repo,
        chart_name: editing.chart_name,
        chart_blob_id: editing.chart_blob_id,
        default_version: editing.default_version,
        default_release_namespace: editing.default_release_namespace,
      });
      setChartType(editing.chart_type);
      setValues(editing.default_values ?? '');
      setUploaded(
        editing.chart_blob_id
          ? { id: editing.chart_blob_id, filename: '', sha256: '' }
          : null,
      );
    } else {
      form.resetFields();
      form.setFieldsValue({
        chart_type: 'repo',
        category: 'custom',
        default_release_namespace: 'kube-system',
      });
      setChartType('repo');
      setValues('');
      setUploaded(null);
    }
  }, [open, editing, form]);

  const handleSubmit = async () => {
    let body: PluginInput;
    try {
      body = await form.validateFields();
    } catch {
      return;
    }
    body.default_values = values;
    if (chartType === 'local') {
      if (!uploaded) {
        message.error(
          intl.formatMessage({ id: 'errors.PLUGIN_CHART_MISSING' }),
        );
        return;
      }
      body.chart_blob_id = uploaded.id;
      // Server still expects chart_name on local entries (used as the
      // human-facing label inside the CRD). Default to display_name.
      if (!body.chart_name) body.chart_name = body.display_name;
    } else {
      body.chart_blob_id = undefined;
    }
    setSubmitting(true);
    try {
      if (editing) {
        await updatePlugin(editing.id, body);
        message.success(
          intl.formatMessage({ id: 'pages.plugins.update.success' }),
        );
      } else {
        await createPlugin(body);
        message.success(
          intl.formatMessage({ id: 'pages.plugins.create.success' }),
        );
      }
      onSaved();
      onClose();
    } catch {
      // global error handler shows toast
    } finally {
      setSubmitting(false);
    }
  };

  const titleId = readOnly
    ? 'pages.plugins.modal.view'
    : editing
      ? 'pages.plugins.modal.edit'
      : 'pages.plugins.modal.create';

  return (
    <Drawer
      title={intl.formatMessage({ id: titleId })}
      open={open}
      onClose={onClose}
      size={620}
      maskClosable={false}
      footer={
        readOnly ? (
          <Space style={{ float: 'right' }}>
            <Button type="primary" onClick={onClose}>
              {intl.formatMessage({ id: 'pages.plugins.modal.close' })}
            </Button>
          </Space>
        ) : (
          <Space style={{ float: 'right' }}>
            <Button onClick={onClose}>
              {intl.formatMessage({ id: 'pages.workloads.cancel' })}
            </Button>
            <Button type="primary" loading={submitting} onClick={handleSubmit}>
              {intl.formatMessage({
                id: editing
                  ? 'pages.plugins.modal.submit.edit'
                  : 'pages.plugins.modal.submit.create',
              })}
            </Button>
          </Space>
        )
      }
    >
      {/* antd Form's `disabled` prop cascades to all child controls,
          so readOnly turns inputs/select/radio off in one shot.
          The Upload.Dragger and YamlEditor are checked explicitly
          below since they're not antd Form controls. */}
      <Form form={form} layout="vertical" disabled={readOnly}>
        <Form.Item
          name="name"
          label={intl.formatMessage({ id: 'pages.plugins.form.name' })}
          rules={[
            { required: true },
            // DNS-1123 label: 1–63 chars, lowercase alphanumerics or '-',
            // can't start or end with '-'. The CRD metadata.name and the
            // Helm release name both use this directly.
            {
              pattern: /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/,
              message: 'a-z, 0-9, "-"; 1–63 chars; no leading/trailing dash',
            },
          ]}
        >
          <Input
            placeholder={intl.formatMessage({
              id: 'pages.plugins.form.namePlaceholder',
            })}
            disabled={!!editing} // name is the CRD identity; locked after creation
            maxLength={63}
          />
        </Form.Item>
        <Form.Item
          name="display_name"
          label={intl.formatMessage({ id: 'pages.plugins.form.displayName' })}
          rules={[{ required: true }]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          name="description"
          label={intl.formatMessage({ id: 'pages.plugins.form.description' })}
        >
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
        </Form.Item>
        <Form.Item
          name="category"
          label={intl.formatMessage({ id: 'pages.plugins.form.category' })}
        >
          <Select
            options={CATEGORIES.map((c) => ({
              label: intl.formatMessage({ id: `pages.plugins.category.${c}` }),
              value: c,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="icon_url"
          label={intl.formatMessage({ id: 'pages.plugins.form.iconURL' })}
        >
          <Input placeholder="https://..." />
        </Form.Item>
        <Form.Item
          name="chart_type"
          label={intl.formatMessage({ id: 'pages.plugins.form.chartType' })}
          rules={[{ required: true }]}
        >
          <Radio.Group
            value={chartType}
            onChange={(e) => setChartType(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            options={[
              {
                label: intl.formatMessage({
                  id: 'pages.plugins.form.chartType.repo',
                }),
                value: 'repo',
              },
              {
                label: intl.formatMessage({
                  id: 'pages.plugins.form.chartType.local',
                }),
                value: 'local',
              },
            ]}
          />
        </Form.Item>
        {chartType === 'repo' ? (
          <>
            <Form.Item
              name="chart_repo"
              label={intl.formatMessage({
                id: 'pages.plugins.form.chartRepo',
              })}
              rules={[{ required: true }]}
            >
              <Input
                placeholder={intl.formatMessage({
                  id: 'pages.plugins.form.chartRepoPlaceholder',
                })}
              />
            </Form.Item>
            <Form.Item
              name="chart_name"
              label={intl.formatMessage({
                id: 'pages.plugins.form.chartName',
              })}
              rules={[{ required: true }]}
            >
              <Input
                placeholder={intl.formatMessage({
                  id: 'pages.plugins.form.chartNamePlaceholder',
                })}
              />
            </Form.Item>
          </>
        ) : (
          <Form.Item
            label={intl.formatMessage({ id: 'pages.plugins.form.upload' })}
            required={!readOnly}
          >
            {!readOnly && (
              <Upload.Dragger
                accept=".tgz"
                maxCount={1}
                showUploadList={false}
                beforeUpload={async (file) => {
                  setUploading(true);
                  try {
                    const res = await uploadPluginChart(file);
                    setUploaded({
                      id: res.id,
                      filename: res.filename,
                      sha256: res.sha256,
                    });
                    message.success(
                      intl.formatMessage(
                        { id: 'pages.plugins.form.uploadSuccess' },
                        { filename: res.filename },
                      ),
                    );
                  } catch {
                    // global toast
                  } finally {
                    setUploading(false);
                  }
                  // Always return false — we already uploaded above.
                  return false;
                }}
              >
                <p className="ant-upload-drag-icon">
                  <InboxOutlined />
                </p>
                <p style={{ fontSize: 13, color: 'var(--ant-color-text-secondary)' }}>
                  {intl.formatMessage({ id: 'pages.plugins.form.uploadHint' })}
                </p>
              </Upload.Dragger>
            )}
            {uploaded && (
              <div style={{ marginTop: 8 }}>
                <Tag color="green">
                  {uploaded.filename || `blob #${uploaded.id}`}
                </Tag>
              </div>
            )}
            {uploading && <div style={{ marginTop: 8 }}>...</div>}
          </Form.Item>
        )}
        <Form.Item
          name="default_version"
          label={intl.formatMessage({
            id: 'pages.plugins.form.defaultVersion',
          })}
        >
          <Input
            placeholder={intl.formatMessage({
              id: 'pages.plugins.form.defaultVersionPlaceholder',
            })}
          />
        </Form.Item>
        <Form.Item
          name="default_release_namespace"
          label={intl.formatMessage({
            id: 'pages.plugins.form.defaultReleaseNamespace',
          })}
        >
          <Input />
        </Form.Item>
        <Form.Item
          label={intl.formatMessage({
            id: 'pages.plugins.form.defaultValues',
          })}
        >
          <div style={{ border: '1px solid var(--ant-color-border)', borderRadius: 4 }}>
            <YamlEditor value={values} onChange={setValues} readOnly={readOnly} />
          </div>
        </Form.Item>
      </Form>
    </Drawer>
  );
}
