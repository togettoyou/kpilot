import { CloudUploadOutlined, EyeOutlined } from '@ant-design/icons';
import { history, useIntl, useRequest } from '@umijs/max';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  theme,
} from 'antd';
import React, { useEffect, useMemo, useState } from 'react';

import { listClusters } from '@/services/kpilot/cluster';
import type {
  DeployApplyResult,
  DeployGPUType,
  DeployPayload,
  Model,
} from '@/services/kpilot/model';
import { deployModel } from '@/services/kpilot/model';

const { Text, Paragraph } = Typography;

interface Props {
  open: boolean;
  model: Model | null;
  onClose: () => void;
}

// Local form shape — UI types differ from wire types (extra_args
// is a multi-line string in the form, split to array on submit;
// instance has a string default 'default' that we erase to "" so
// the server treats it as singleton). Keeping the form shape
// separate from DeployPayload avoids littering submit-time
// transforms across the JSX.
interface FormValues {
  cluster_id: string;
  namespace: string;
  create_namespace: boolean;
  instance: string;
  replicas: number;
  gpu_count: number;
  gpu_type: DeployGPUType;
  hf_token: string;
  extra_args_text: string;
  pvc_enabled: boolean;
  pvc_size_gib: number;
  pvc_storage_class_name: string;
}

// Default size heuristic — sized per model so the user doesn't
// have to guess at how much HF will need. These numbers are
// "weights × ~2 for cache + tokenizer + safetensor shards"
// which is the rule of thumb Hugging Face documents.
const pvcSizeForModel = (m: Model): number => {
  const n = m.name;
  if (n.includes('0.6b')) return 5;
  if (n.includes('8b') || n.includes('9b')) return 30;
  if (n.includes('14b')) return 50;
  if (n.includes('30b') || n.includes('32b')) return 100;
  if (n.includes('70b')) return 200;
  if (n.includes('scout')) return 250; // Llama 4 Scout MoE ~109B total
  if (n.includes('phi-4')) return 40;
  if (n.includes('gemma-4-31b')) return 80;
  if (n.includes('glm-5')) return 1600; // 744B MoE
  if (n.includes('kimi-k2')) return 2000; // 1T MoE
  if (n.includes('r1')) return 1400; // DeepSeek R1 685B
  return 100; // sane fallback
};

const DeployDrawer: React.FC<Props> = ({ open, model, onClose }) => {
  const intl = useIntl();
  const { message } = App.useApp();
  const { token } = theme.useToken();

  const [form] = Form.useForm<FormValues>();
  // Hold the YAML preview returned from the server's dry_run path.
  // Separate state from the form so the preview survives across
  // form-value re-renders.
  const [yamlPreview, setYamlPreview] = useState<string>('');
  const [activeTab, setActiveTab] = useState('config');
  const [results, setResults] = useState<DeployApplyResult[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  // Defaults derived from the source model — only computed when
  // model changes. Recommended GPU count comes from the catalog
  // row; PVC size is heuristic above.
  const defaults = useMemo<Partial<FormValues> | null>(() => {
    if (!model) return null;
    let gpuCount = 1;
    try {
      const g = JSON.parse(model.recommended_gpu) as { count?: number };
      if (g.count) gpuCount = g.count;
    } catch {
      /* fall through */
    }
    return {
      namespace: 'kpilot-inference',
      create_namespace: true,
      instance: '',
      replicas: 1,
      gpu_count: gpuCount,
      gpu_type: 'nvidia',
      hf_token: '',
      extra_args_text: '',
      pvc_enabled: true,
      pvc_size_gib: pvcSizeForModel(model),
      pvc_storage_class_name: '',
    };
  }, [model]);

  // Reset form + clear preview / results every time the drawer
  // opens with a (possibly new) model. Without the explicit reset
  // the previous deployment's results stay visible behind a fresh
  // drawer open.
  useEffect(() => {
    if (open && defaults) {
      form.resetFields();
      form.setFieldsValue(defaults);
      setYamlPreview('');
      setResults(null);
      setActiveTab('config');
    }
  }, [open, defaults, form]);

  // Cluster list for the target-cluster Select. Loaded once per
  // drawer mount; the list rarely changes mid-session.
  const { data: clusters, loading: clustersLoading } = useRequest(
    listClusters,
    { formatResult: (res) => res },
  );

  const buildPayload = (values: FormValues): DeployPayload => {
    const extra_args = values.extra_args_text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      cluster_id: values.cluster_id,
      namespace: values.namespace,
      create_namespace: values.create_namespace,
      instance: values.instance.trim(),
      replicas: values.replicas,
      gpu_count: values.gpu_count,
      gpu_type: values.gpu_type,
      hf_token: values.hf_token,
      extra_args,
      pvc: {
        enabled: values.pvc_enabled,
        size_gib: values.pvc_size_gib,
        storage_class_name: values.pvc_storage_class_name || undefined,
      },
    };
  };

  const handlePreview = async () => {
    if (!model) return;
    try {
      const values = await form.validateFields();
      setPreviewing(true);
      const resp = await deployModel(model.id, buildPayload(values), true);
      setYamlPreview(resp.yaml_preview);
      setActiveTab('preview');
    } catch {
      // validateFields throws on invalid — antd has already
      // rendered the per-field error markers. Other errors fall
      // through to the global toast handler.
    } finally {
      setPreviewing(false);
    }
  };

  const handleDeploy = async () => {
    if (!model) return;
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const resp = await deployModel(model.id, buildPayload(values));
      setYamlPreview(resp.yaml_preview);
      setResults(resp.apply_results ?? []);
      const failed = (resp.apply_results ?? []).some((r) => !r.success);
      if (failed) {
        message.warning(
          intl.formatMessage({ id: 'pages.models.deploy.partial' }),
        );
      } else {
        message.success(
          intl.formatMessage(
            { id: 'pages.models.deploy.success' },
            { name: resp.deployment_name, ns: resp.namespace },
          ),
        );
      }
    } catch {
      /* per-field errors already on screen, network errors via global toast */
    } finally {
      setSubmitting(false);
    }
  };

  // Results table — shown only after a real apply succeeds at
  // the HTTP level (per-doc results inside may still be a mix).
  const resultColumns = [
    {
      title: intl.formatMessage({ id: 'pages.models.deploy.result.kind' }),
      dataIndex: 'kind',
      width: 140,
    },
    {
      title: intl.formatMessage({ id: 'pages.models.deploy.result.name' }),
      dataIndex: 'name',
      ellipsis: true,
    },
    {
      title: intl.formatMessage({ id: 'pages.models.deploy.result.status' }),
      dataIndex: 'success',
      width: 80,
      render: (ok: boolean) =>
        ok ? (
          <Tag color="success">
            {intl.formatMessage({ id: 'pages.models.deploy.result.ok' })}
          </Tag>
        ) : (
          <Tag color="error">
            {intl.formatMessage({ id: 'pages.models.deploy.result.failed' })}
          </Tag>
        ),
    },
    {
      title: intl.formatMessage({ id: 'pages.models.deploy.result.error' }),
      dataIndex: 'error',
      ellipsis: true,
      render: (e?: string) =>
        e ? <Text type="danger">{e}</Text> : <Text type="secondary">—</Text>,
    },
  ];

  const gotoWorkloads = () => {
    const clusterId = form.getFieldValue('cluster_id');
    if (clusterId) {
      history.push(`/clusters/${clusterId}/workloads/deployments`);
    }
    onClose();
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="large"
      maskClosable={false}
      destroyOnHidden
      title={
        model
          ? intl.formatMessage(
              { id: 'pages.models.deploy.title' },
              { name: model.display_name },
            )
          : ''
      }
      extra={
        <Space>
          <Button
            icon={<EyeOutlined />}
            onClick={handlePreview}
            loading={previewing}
          >
            {intl.formatMessage({ id: 'pages.models.deploy.action.preview' })}
          </Button>
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            onClick={handleDeploy}
            loading={submitting}
          >
            {intl.formatMessage({ id: 'pages.models.deploy.action.deploy' })}
          </Button>
        </Space>
      }
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'config',
            label: intl.formatMessage({
              id: 'pages.models.deploy.tab.config',
            }),
            children: (
              <Form<FormValues>
                form={form}
                layout="vertical"
                initialValues={defaults ?? undefined}
                autoComplete="off"
              >
                <Form.Item
                  name="cluster_id"
                  label={intl.formatMessage({
                    id: 'pages.models.deploy.cluster',
                  })}
                  rules={[{ required: true }]}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    loading={clustersLoading}
                    placeholder={intl.formatMessage({
                      id: 'pages.models.deploy.cluster.placeholder',
                    })}
                    options={(clusters ?? []).map((c) => ({
                      label: `${c.name} (${c.status})`,
                      value: c.id,
                    }))}
                  />
                </Form.Item>

                <Form.Item
                  name="namespace"
                  label={intl.formatMessage({
                    id: 'pages.models.deploy.namespace',
                  })}
                  tooltip={intl.formatMessage({
                    id: 'pages.models.deploy.namespace.help',
                  })}
                  rules={[
                    { required: true },
                    {
                      pattern: /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/,
                      message: 'DNS-1123 label',
                    },
                    { max: 63 },
                  ]}
                >
                  <Input maxLength={63} autoComplete="off" />
                </Form.Item>

                <Form.Item name="create_namespace" valuePropName="checked">
                  <Checkbox>
                    {intl.formatMessage({
                      id: 'pages.models.deploy.createNamespace',
                    })}
                  </Checkbox>
                </Form.Item>

                <Form.Item
                  name="instance"
                  label={intl.formatMessage({
                    id: 'pages.models.deploy.instance',
                  })}
                  tooltip={intl.formatMessage({
                    id: 'pages.models.deploy.instance.help',
                  })}
                  rules={[
                    {
                      // Empty OR DNS-1123. Can't put `required: false`
                      // + pattern at the same time, so use a validator
                      // function.
                      validator: async (_, value: string) => {
                        if (!value) return;
                        if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) {
                          throw new Error('DNS-1123 label');
                        }
                        if (value.length > 30) throw new Error('max 30');
                      },
                    },
                  ]}
                >
                  <Input
                    maxLength={30}
                    placeholder="prod / long-context / ..."
                    autoComplete="off"
                  />
                </Form.Item>

                <Space size="large">
                  <Form.Item
                    name="replicas"
                    label={intl.formatMessage({
                      id: 'pages.models.deploy.replicas',
                    })}
                    rules={[{ required: true }]}
                  >
                    <InputNumber min={1} max={32} />
                  </Form.Item>

                  <Form.Item
                    name="gpu_count"
                    label={intl.formatMessage({
                      id: 'pages.models.deploy.gpuCount',
                    })}
                    rules={[{ required: true }]}
                  >
                    <InputNumber min={0} max={16} />
                  </Form.Item>
                </Space>

                <Form.Item
                  name="gpu_type"
                  label={intl.formatMessage({
                    id: 'pages.models.deploy.gpuType',
                  })}
                  tooltip={intl.formatMessage({
                    id: 'pages.models.deploy.gpuType.help',
                  })}
                >
                  <Radio.Group>
                    <Radio value="nvidia">
                      {intl.formatMessage({
                        id: 'pages.models.deploy.gpuType.nvidia',
                      })}
                    </Radio>
                    <Radio value="volcano">
                      {intl.formatMessage({
                        id: 'pages.models.deploy.gpuType.volcano',
                      })}
                    </Radio>
                  </Radio.Group>
                </Form.Item>

                <Form.Item
                  name="extra_args_text"
                  label={intl.formatMessage({
                    id: 'pages.models.deploy.extraArgs',
                  })}
                  tooltip={intl.formatMessage({
                    id: 'pages.models.deploy.extraArgs.help',
                  })}
                >
                  <Input.TextArea
                    rows={3}
                    maxLength={8192}
                    placeholder={'--max-model-len\n131072'}
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                  />
                </Form.Item>

                <Typography.Title level={5} style={{ marginTop: 16 }}>
                  {intl.formatMessage({
                    id: 'pages.models.deploy.pvc.section',
                  })}
                </Typography.Title>

                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={intl.formatMessage({
                    id: 'pages.models.deploy.pvc.help',
                  })}
                />

                <Form.Item name="pvc_enabled" valuePropName="checked">
                  <Checkbox>
                    {intl.formatMessage({
                      id: 'pages.models.deploy.pvc.enabled',
                    })}
                  </Checkbox>
                </Form.Item>

                <Space size="large">
                  <Form.Item
                    name="pvc_size_gib"
                    label={intl.formatMessage({
                      id: 'pages.models.deploy.pvc.size',
                    })}
                  >
                    <InputNumber min={1} max={4096} />
                  </Form.Item>

                  <Form.Item
                    name="pvc_storage_class_name"
                    label={intl.formatMessage({
                      id: 'pages.models.deploy.pvc.storageClass',
                    })}
                    style={{ minWidth: 240 }}
                  >
                    <Input
                      placeholder={intl.formatMessage({
                        id: 'pages.models.deploy.pvc.storageClass.placeholder',
                      })}
                      autoComplete="off"
                    />
                  </Form.Item>
                </Space>

                {/* HF Token at the bottom — browsers pair a password
                    field's autofill with the FIRST text input that
                    appears before it in the form. Putting this last
                    keeps the Cluster Select / Namespace / Instance
                    inputs all "above" the password, so Chrome stops
                    offering to fill saved usernames into them. The
                    autoComplete="new-password" is the only value
                    Chrome respects for "don't autofill". */}
                <Form.Item
                  name="hf_token"
                  label={intl.formatMessage({
                    id: 'pages.models.deploy.hfToken',
                  })}
                  tooltip={intl.formatMessage({
                    id: 'pages.models.deploy.hfToken.help',
                  })}
                  rules={[{ max: 200 }]}
                >
                  <Input.Password
                    maxLength={200}
                    placeholder="hf_..."
                    autoComplete="new-password"
                  />
                </Form.Item>

                {results && (
                  <>
                    <Typography.Title level={5} style={{ marginTop: 24 }}>
                      {intl.formatMessage({
                        id: 'pages.models.deploy.result.status',
                      })}
                    </Typography.Title>
                    <Table
                      size="small"
                      rowKey={(r) => `${r.kind}-${r.name}`}
                      columns={resultColumns}
                      dataSource={results}
                      pagination={false}
                    />
                    {results.every((r) => r.success) && (
                      <Paragraph style={{ marginTop: 12 }}>
                        <Button type="link" onClick={gotoWorkloads}>
                          {intl.formatMessage({
                            id: 'pages.models.deploy.gotoWorkloads',
                          })}
                        </Button>
                      </Paragraph>
                    )}
                  </>
                )}
              </Form>
            ),
          },
          {
            key: 'preview',
            label: intl.formatMessage({
              id: 'pages.models.deploy.tab.preview',
            }),
            children: yamlPreview ? (
              <pre
                style={{
                  background: token.colorFillTertiary,
                  color: token.colorText,
                  padding: 12,
                  borderRadius: token.borderRadius,
                  fontSize: 12,
                  maxHeight: 'calc(100vh - 220px)',
                  overflow: 'auto',
                }}
              >
                {yamlPreview}
              </pre>
            ) : (
              <Text type="secondary">
                {intl.formatMessage({
                  id: 'pages.models.deploy.action.preview',
                })}
                ←
              </Text>
            ),
          },
        ]}
      />
    </Drawer>
  );
};

export default DeployDrawer;
