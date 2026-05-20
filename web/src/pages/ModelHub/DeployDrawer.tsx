import { CloudUploadOutlined } from '@ant-design/icons';
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
} from 'antd';
import React, { useEffect, useMemo, useState } from 'react';
import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';
import { listClusters } from '@/services/kpilot/cluster';
import type {
  DeployApplyResult,
  DeployGPUType,
  DeployPayload,
  Model,
} from '@/services/kpilot/model';
import { deployModel } from '@/services/kpilot/model';

const { Text } = Typography;

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
  // K8s quantity strings — left empty by default so vLLM gets
  // whatever the default scheduler hands it. Filled in only when
  // the user needs to pin CPU / memory budgets.
  cpu_request: string;
  cpu_limit: string;
  memory_request: string;
  memory_limit: string;
  // Volcano vGPU sub-resources — rendered only when gpu_type=volcano.
  // Keeping them in the FormValues unconditionally so React's form
  // state stays consistent across runtime toggles.
  vgpu_memory_mib?: number;
  vgpu_cores?: number;
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
      cpu_request: '',
      cpu_limit: '',
      memory_request: '',
      memory_limit: '',
      vgpu_memory_mib: undefined,
      vgpu_cores: undefined,
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
    // vGPU sub-resources only ship when the user picked volcano;
    // for nvidia the fields are hidden but might still hold
    // residual values from a runtime toggle, so we explicitly
    // drop them here rather than rely on UI hiding alone.
    const useVolcano = values.gpu_type === 'volcano';
    return {
      cluster_id: values.cluster_id,
      namespace: values.namespace,
      create_namespace: values.create_namespace,
      instance: values.instance.trim(),
      replicas: values.replicas,
      gpu_count: values.gpu_count,
      gpu_type: values.gpu_type,
      cpu_request: values.cpu_request.trim() || undefined,
      cpu_limit: values.cpu_limit.trim() || undefined,
      memory_request: values.memory_request.trim() || undefined,
      memory_limit: values.memory_limit.trim() || undefined,
      vgpu_memory_mib:
        useVolcano && values.vgpu_memory_mib && values.vgpu_memory_mib > 0
          ? values.vgpu_memory_mib
          : undefined,
      vgpu_cores:
        useVolcano && values.vgpu_cores && values.vgpu_cores > 0
          ? values.vgpu_cores
          : undefined,
      hf_token: values.hf_token,
      extra_args,
      pvc: {
        enabled: values.pvc_enabled,
        size_gib: values.pvc_size_gib,
        storage_class_name: values.pvc_storage_class_name || undefined,
      },
    };
  };

  // Shared dry-run that powers both the explicit "预览" button and
  // the auto-fetch when the user clicks the YAML preview tab. The
  // tab callback ignores validation failures silently (the form
  // shows the markers anyway); the button surfaces them as toast.
  const fetchPreview = async (silent = false): Promise<boolean> => {
    if (!model) return false;
    let values: FormValues;
    try {
      values = await form.validateFields();
    } catch {
      // antd already painted per-field error markers; nothing
      // more to do silently. The explicit button path lets the
      // user see them by virtue of having clicked.
      return false;
    }
    setPreviewing(true);
    try {
      const resp = await deployModel(model.id, buildPayload(values), true);
      setYamlPreview(resp.yaml_preview);
      return true;
    } catch (e) {
      if (!silent) throw e;
      return false;
    } finally {
      setPreviewing(false);
    }
  };

  // Switching tabs into "preview" should populate it without a
  // second click — only fetch if we don't already have a preview
  // for the current form state. We treat the cached YAML as
  // stale only when the tab is freshly opened (yamlPreview empty),
  // so a user can flip tabs back and forth without re-running
  // dry_run every time.
  const handleTabChange = (key: string) => {
    setActiveTab(key);
    if (key === 'preview' && !yamlPreview && model) {
      void fetchPreview(true);
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
      // Always flip to the results tab on submit completion —
      // previously the table sat at the bottom of the config form
      // and required scrolling, which made failures invisible at
      // a glance. Now success or partial-failure both surface
      // immediately on a dedicated tab.
      setActiveTab('result');
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
        <Button
          type="primary"
          icon={<CloudUploadOutlined />}
          onClick={handleDeploy}
          loading={submitting}
        >
          {intl.formatMessage({ id: 'pages.models.deploy.action.deploy' })}
        </Button>
      }
    >
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
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
                onValuesChange={() => {
                  // Any form edit invalidates the cached YAML —
                  // next click into the preview tab refetches.
                  if (yamlPreview) setYamlPreview('');
                }}
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

                {/* Volcano vGPU sub-resources — visible only when the
                    user picked the volcano runtime. Without these the
                    Pod gets whole-slot defaults; setting them lets one
                    physical card carry multiple Pods (per-slot memory
                    + SM percentage). Mirrors the JobForm pattern in
                    /compute. shouldUpdate scoped to gpu_type so we
                    re-render only on that change. */}
                <Form.Item
                  noStyle
                  shouldUpdate={(prev, cur) => prev.gpu_type !== cur.gpu_type}
                >
                  {({ getFieldValue }) =>
                    getFieldValue('gpu_type') === 'volcano' ? (
                      <Space.Compact block style={{ marginBottom: 16 }}>
                        <Form.Item
                          name="vgpu_memory_mib"
                          label={intl.formatMessage({
                            id: 'pages.models.deploy.vgpu.memory',
                          })}
                          tooltip={intl.formatMessage({
                            id: 'pages.models.deploy.vgpu.memory.help',
                          })}
                          style={{ flex: 1 }}
                        >
                          <InputNumber
                            min={0}
                            max={1048576}
                            precision={0}
                            placeholder="3000"
                            addonAfter="MiB"
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                        <Form.Item
                          name="vgpu_cores"
                          label={intl.formatMessage({
                            id: 'pages.models.deploy.vgpu.cores',
                          })}
                          tooltip={intl.formatMessage({
                            id: 'pages.models.deploy.vgpu.cores.help',
                          })}
                          style={{ flex: 1, marginInlineStart: 12 }}
                        >
                          <InputNumber
                            min={0}
                            max={100}
                            precision={0}
                            placeholder="50"
                            addonAfter="%"
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                      </Space.Compact>
                    ) : null
                  }
                </Form.Item>

                {/* CPU + memory request/limit — K8s quantity strings.
                    Empty fields omit the resource entirely, letting
                    the scheduler default. Request can be smaller than
                    limit for burst headroom. */}
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  {intl.formatMessage({
                    id: 'pages.models.deploy.resources',
                  })}
                </Typography.Text>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 12,
                    marginTop: 4,
                    marginBottom: 16,
                  }}
                >
                  <Form.Item
                    name="cpu_request"
                    label={intl.formatMessage({
                      id: 'pages.models.deploy.resources.cpu.request',
                    })}
                    style={{ marginBottom: 0 }}
                  >
                    <Input placeholder="2" maxLength={32} autoComplete="off" />
                  </Form.Item>
                  <Form.Item
                    name="cpu_limit"
                    label={intl.formatMessage({
                      id: 'pages.models.deploy.resources.cpu.limit',
                    })}
                    style={{ marginBottom: 0 }}
                  >
                    <Input placeholder="4" maxLength={32} autoComplete="off" />
                  </Form.Item>
                  <Form.Item
                    name="memory_request"
                    label={intl.formatMessage({
                      id: 'pages.models.deploy.resources.memory.request',
                    })}
                    style={{ marginBottom: 0 }}
                  >
                    <Input
                      placeholder="4Gi"
                      maxLength={32}
                      autoComplete="off"
                    />
                  </Form.Item>
                  <Form.Item
                    name="memory_limit"
                    label={intl.formatMessage({
                      id: 'pages.models.deploy.resources.memory.limit',
                    })}
                    style={{ marginBottom: 0 }}
                  >
                    <Input
                      placeholder="8Gi"
                      maxLength={32}
                      autoComplete="off"
                    />
                  </Form.Item>
                </div>

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
              </Form>
            ),
          },
          {
            key: 'preview',
            label: intl.formatMessage({
              id: 'pages.models.deploy.tab.preview',
            }),
            children: (
              // Reuse the workloads YAML editor — CodeMirror + YAML
              // mode + theme-aware colors, same component every other
              // YAML drawer in the app uses. readOnly so the preview
              // can't be hand-edited (regenerate by toggling form
              // fields and switching tabs).
              <div style={{ minHeight: 320 }}>
                {previewing && !yamlPreview ? (
                  <Text type="secondary">
                    {intl.formatMessage({ id: 'pages.common.loading' })}
                  </Text>
                ) : (
                  <YamlEditor value={yamlPreview} readOnly />
                )}
              </div>
            ),
          },
          // Results tab only exists after a deploy attempt — keeps
          // the tab bar at two items on a fresh open and grows to
          // three only when there's something to show. handleDeploy
          // flips activeTab to "result" on submit completion, so
          // success / failure surface immediately without scrolling.
          ...(results
            ? [
                {
                  key: 'result',
                  label: intl.formatMessage({
                    id: 'pages.models.deploy.tab.result',
                  }),
                  children: (
                    <div>
                      {results.length === 0 ? (
                        <Text type="secondary">
                          {intl.formatMessage({
                            id: 'pages.models.deploy.result.empty',
                          })}
                        </Text>
                      ) : (
                        <>
                          {results.every((r) => r.success) ? (
                            <Alert
                              type="success"
                              showIcon
                              style={{ marginBottom: 16 }}
                              message={intl.formatMessage({
                                id: 'pages.models.deploy.result.allOk',
                              })}
                              action={
                                <Button
                                  size="small"
                                  type="link"
                                  onClick={gotoWorkloads}
                                >
                                  {intl.formatMessage({
                                    id: 'pages.models.deploy.gotoWorkloads',
                                  })}
                                </Button>
                              }
                            />
                          ) : (
                            <Alert
                              type="error"
                              showIcon
                              style={{ marginBottom: 16 }}
                              message={intl.formatMessage({
                                id: 'pages.models.deploy.partial',
                              })}
                            />
                          )}
                          <Table
                            size="small"
                            rowKey={(r) => `${r.kind}-${r.name}`}
                            columns={resultColumns}
                            dataSource={results}
                            pagination={false}
                          />
                        </>
                      )}
                    </div>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Drawer>
  );
};

export default DeployDrawer;
