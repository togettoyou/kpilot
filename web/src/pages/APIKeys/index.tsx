// APIKeys/index.tsx — P16-D operator UI for the Bearer-token CRUD
// that gates the external OpenAI-compatible inference proxy.
//
// Lifecycle: operator mints a key bound to one inference deployment,
// copies the plaintext token shown ONCE in a result modal, then later
// either revokes it (soft, keeps audit row) or deletes it (hard).
// The middleware treats both terminal states as 401.
//
// Co-located with the model-serving menu because keys exist FOR
// inference deployments — having to hunt for them in a top-level
// /api-keys would be a worse UX. URL is /models/api-keys.

import {
  CopyOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import { useIntl } from '@umijs/max';
import {
  Alert,
  App,
  Button,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import type { APIKey, CreateAPIKeyResponse } from '@/services/kpilot/api-key';
import {
  createAPIKey,
  deleteAPIKey,
  listAPIKeys,
  revokeAPIKey,
} from '@/services/kpilot/api-key';
import type { Cluster } from '@/services/kpilot/cluster';
import { listClusters } from '@/services/kpilot/cluster';
import type { ModelInstance } from '@/services/kpilot/model';
import { listDeployments } from '@/services/kpilot/model';

dayjs.extend(relativeTime);

const { Text, Paragraph } = Typography;

// formField — encodes a deployment as `namespace/name` so antd's
// Select value is a string. Decoded on submit to populate the two
// separate scope fields the API expects.
type CreateFormValues = {
  name: string;
  cluster_id: string;
  deployment: string; // "<namespace>/<name>"
};

const APIKeysPage: React.FC = () => {
  const intl = useIntl();
  const { modal, message } = App.useApp();
  const { token } = theme.useToken();

  const t = useCallback(
    (id: string, defaultMessage?: string) =>
      intl.formatMessage({ id, defaultMessage: defaultMessage ?? id }),
    [intl],
  );

  // ─── Table state ───────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<APIKey[]>([]);
  // Cluster list is fetched up-front so the scope column can render
  // human-readable names (not UUIDs) on first paint. Stable across
  // a session — operators rarely add clusters while managing keys.
  const [clusters, setClusters] = useState<Cluster[]>([]);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listAPIKeys();
      setRows(data ?? []);
    } catch {
      // requestErrorConfig already toasted
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
    listClusters()
      .then((cls) => setClusters(cls ?? []))
      .catch(() => {
        /* requestErrorConfig already toasted */
      });
  }, [fetchKeys]);

  // ─── Create drawer state ───────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm<CreateFormValues>();
  const watchedCluster = Form.useWatch('cluster_id', form);

  // Deployments are fetched only on drawer open — they cross-fan-out
  // to every online worker and we don't want that cost just to render
  // the keys table.
  const [deployments, setDeployments] = useState<ModelInstance[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const openCreate = async () => {
    form.resetFields();
    setCreateOpen(true);
    setDrawerLoading(true);
    try {
      const deps = await listDeployments();
      setDeployments(deps?.instances ?? []);
    } catch {
      // requestErrorConfig already toasted
    } finally {
      setDrawerLoading(false);
    }
  };

  // Deployment options filtered to the currently picked cluster.
  // Empty cluster → empty list so the second Select is naturally
  // disabled.
  const deploymentOptions = useMemo(() => {
    if (!watchedCluster) return [];
    return deployments
      .filter((d) => d.cluster_id === watchedCluster)
      .map((d) => ({
        value: `${d.namespace}/${d.name}`,
        label: `${d.namespace} / ${d.name}`,
        // Pull instance metadata into the option for the rich render.
        instance: d,
      }));
  }, [deployments, watchedCluster]);

  // When the operator switches cluster, the previously-picked
  // deployment is almost certainly stale (a deployment in cluster A
  // wouldn't make sense for cluster B). Clear it so the form can't
  // submit a mismatched scope.
  useEffect(() => {
    form.setFieldValue('deployment', undefined);
  }, [watchedCluster, form]);

  // ─── Result modal — one-shot plaintext token reveal ────────────────
  const [resultData, setResultData] = useState<CreateAPIKeyResponse | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const copyToken = async () => {
    if (!resultData?.token) return;
    try {
      await navigator.clipboard.writeText(resultData.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error(t('pages.describe.copyFailed', 'Copy failed'));
    }
  };

  const submitCreate = async () => {
    let values: CreateFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const slashIdx = values.deployment.indexOf('/');
    if (slashIdx < 0) return;
    const namespace = values.deployment.slice(0, slashIdx);
    const deployName = values.deployment.slice(slashIdx + 1);

    setCreating(true);
    try {
      const res = await createAPIKey({
        name: values.name.trim(),
        cluster_id: values.cluster_id,
        namespace,
        deploy_name: deployName,
      });
      setCreateOpen(false);
      message.success(t('pages.apikeys.toast.created'));
      setResultData(res);
      setCopied(false);
      // Refresh the table in the background; the result modal stays
      // open over it.
      fetchKeys();
    } catch {
      // requestErrorConfig already toasted
    } finally {
      setCreating(false);
    }
  };

  // ─── Row actions ───────────────────────────────────────────────────
  const askRevoke = (row: APIKey) => {
    modal.confirm({
      title: t('pages.apikeys.confirm.revoke.title'),
      icon: <ExclamationCircleOutlined />,
      content: t('pages.apikeys.confirm.revoke.content'),
      okText: t('pages.apikeys.confirm.revoke.ok'),
      okButtonProps: { danger: true },
      cancelText: t('pages.apikeys.create.cancel'),
      onOk: async () => {
        await revokeAPIKey(row.id);
        message.success(t('pages.apikeys.toast.revoked'));
        fetchKeys();
      },
    });
  };

  const askDelete = (row: APIKey) => {
    modal.confirm({
      title: t('pages.apikeys.confirm.delete.title'),
      icon: <ExclamationCircleOutlined />,
      content: t('pages.apikeys.confirm.delete.content'),
      okText: t('pages.apikeys.confirm.delete.ok'),
      okButtonProps: { danger: true },
      cancelText: t('pages.apikeys.create.cancel'),
      onOk: async () => {
        await deleteAPIKey(row.id);
        message.success(t('pages.apikeys.toast.deleted'));
        fetchKeys();
      },
    });
  };

  // ─── Cluster id → name lookup, used in scope column ────────────────
  const clusterNameById = useMemo(() => {
    const m: Record<string, string> = {};
    clusters.forEach((c) => {
      m[c.id] = c.name;
    });
    return m;
  }, [clusters]);

  // ─── Columns ───────────────────────────────────────────────────────
  const columns: ProColumns<APIKey>[] = [
    {
      title: t('pages.apikeys.column.name'),
      dataIndex: 'name',
      width: 200,
      render: (_, row) => <Text strong>{row.name}</Text>,
    },
    {
      title: t('pages.apikeys.column.prefix'),
      dataIndex: 'token_prefix',
      width: 140,
      render: (_, row) => (
        <Text code style={{ fontSize: 12 }}>
          {row.token_prefix}…
        </Text>
      ),
    },
    {
      title: t('pages.apikeys.column.scope'),
      dataIndex: 'cluster_id',
      width: 280,
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Text style={{ fontSize: 12 }}>
            <Text type="secondary">
              {t('pages.apikeys.column.cluster')}:
            </Text>{' '}
            {clusterNameById[row.cluster_id] ?? row.cluster_id}
          </Text>
          <Text style={{ fontSize: 12 }} type="secondary">
            {row.namespace} / {row.deploy_name}
          </Text>
        </Space>
      ),
    },
    {
      title: t('pages.apikeys.column.status'),
      dataIndex: 'revoked_at',
      width: 100,
      render: (_, row) =>
        row.revoked_at ? (
          <Tag color="red">{t('pages.apikeys.status.revoked')}</Tag>
        ) : (
          <Tag color="green">{t('pages.apikeys.status.active')}</Tag>
        ),
      filters: [
        {
          text: t('pages.apikeys.status.active'),
          value: 'active',
        },
        {
          text: t('pages.apikeys.status.revoked'),
          value: 'revoked',
        },
      ],
      onFilter: (value, row) =>
        value === 'active' ? !row.revoked_at : !!row.revoked_at,
    },
    {
      title: t('pages.apikeys.column.lastUsed'),
      dataIndex: 'last_used_at',
      width: 160,
      render: (_, row) =>
        row.last_used_at ? (
          <Tooltip title={dayjs(row.last_used_at).format('YYYY-MM-DD HH:mm:ss')}>
            <Text style={{ fontSize: 12 }}>
              {dayjs(row.last_used_at).fromNow()}
            </Text>
          </Tooltip>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('pages.apikeys.lastUsed.never')}
          </Text>
        ),
    },
    {
      title: t('pages.apikeys.column.createdAt'),
      dataIndex: 'created_at',
      width: 160,
      render: (_, row) => (
        <Tooltip title={dayjs(row.created_at).format('YYYY-MM-DD HH:mm:ss')}>
          <Text style={{ fontSize: 12 }}>
            {dayjs(row.created_at).fromNow()}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: t('pages.apikeys.column.actions'),
      key: 'actions',
      width: 160,
      fixed: 'right',
      render: (_, row) => (
        <Space>
          {!row.revoked_at && (
            <Button
              size="small"
              icon={<StopOutlined />}
              onClick={() => askRevoke(row)}
            >
              {t('pages.apikeys.action.revoke')}
            </Button>
          )}
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => askDelete(row)}
          >
            {t('pages.apikeys.action.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  // ─── Result modal usage example ────────────────────────────────────
  const usageCurl = useMemo(() => {
    if (!resultData) return '';
    const k = resultData.key;
    const base = `${window.location.origin}/api/v1/clusters/${k.cluster_id}/proxy/inference/${k.namespace}/${k.deploy_name}/v1/chat/completions`;
    return [
      `curl -N "${base}" \\`,
      `  -H "Authorization: Bearer ${resultData.token}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"model":"<model field>","messages":[{"role":"user","content":"hi"}],"stream":true}'`,
    ].join('\n');
  }, [resultData]);

  return (
    <PageContainer
      title={t('pages.apikeys.title')}
      content={t('pages.apikeys.subtitle')}
      breadcrumbRender={false}
    >
      <ProTable<APIKey>
        rowKey="id"
        dataSource={rows}
        loading={loading}
        columns={columns}
        search={false}
        // Hide ProTable's bundled toolbar cluster (reload / density /
        // column settings / fullscreen) — we own the refresh button
        // in toolBarRender and the other knobs are noise on a small,
        // fixed-shape table.
        options={false}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
        toolBarRender={() => [
          <Button
            key="refresh"
            icon={<ReloadOutlined />}
            onClick={fetchKeys}
          >
            {t('pages.apikeys.refresh')}
          </Button>,
          <Button
            key="new"
            type="primary"
            icon={<PlusOutlined />}
            onClick={openCreate}
          >
            {t('pages.apikeys.new')}
          </Button>,
        ]}
      />

      {/* ─── Create drawer ────────────────────────────────────────── */}
      <Drawer
        title={
          <Space>
            <KeyOutlined />
            {t('pages.apikeys.create.title')}
          </Space>
        }
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        size="large"
        maskClosable={false}
        destroyOnHidden
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => setCreateOpen(false)} disabled={creating}>
              {t('pages.apikeys.create.cancel')}
            </Button>
            <Button type="primary" loading={creating} onClick={submitCreate}>
              {t('pages.apikeys.create.submit')}
            </Button>
          </Space>
        }
      >
        <Form<CreateFormValues>
          form={form}
          layout="vertical"
          disabled={creating}
        >
          <Form.Item
            name="name"
            label={t('pages.apikeys.field.name')}
            rules={[
              {
                required: true,
                message: t('pages.apikeys.field.name.required'),
              },
            ]}
          >
            <Input
              placeholder={t('pages.apikeys.field.name.placeholder')}
              maxLength={255}
              showCount
            />
          </Form.Item>
          <Form.Item
            name="cluster_id"
            label={t('pages.apikeys.field.cluster')}
            rules={[
              {
                required: true,
                message: t('pages.apikeys.field.cluster.required'),
              },
            ]}
          >
            <Select
              placeholder={t('pages.apikeys.field.cluster.placeholder')}
              loading={drawerLoading}
              showSearch
              optionFilterProp="label"
              options={clusters.map((c) => ({
                value: c.id,
                label: c.name,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="deployment"
            label={t('pages.apikeys.field.deployment')}
            rules={[
              {
                required: true,
                message: t('pages.apikeys.field.deployment.required'),
              },
            ]}
          >
            <Select
              placeholder={t('pages.apikeys.field.deployment.placeholder')}
              loading={drawerLoading}
              disabled={!watchedCluster}
              showSearch
              optionFilterProp="label"
              options={deploymentOptions.map((o) => ({
                value: o.value,
                label: o.label,
              }))}
              notFoundContent={
                watchedCluster && !drawerLoading
                  ? t('pages.apikeys.field.deployment.empty')
                  : undefined
              }
            />
          </Form.Item>
        </Form>
      </Drawer>

      {/* ─── Result modal — token shown once ──────────────────────── */}
      <Modal
        title={
          <Space>
            <KeyOutlined />
            {t('pages.apikeys.result.title')}
          </Space>
        }
        open={!!resultData}
        onCancel={() => setResultData(null)}
        maskClosable={false}
        width={680}
        footer={
          <Button type="primary" onClick={() => setResultData(null)}>
            {t('pages.apikeys.result.close')}
          </Button>
        }
      >
        {resultData && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Alert
              type="warning"
              showIcon
              message={t('pages.apikeys.result.warning')}
            />
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('pages.apikeys.result.tokenLabel')}
              </Text>
              <Space.Compact style={{ width: '100%', marginTop: 6 }}>
                <Input
                  value={resultData.token}
                  readOnly
                  style={{
                    fontFamily:
                      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                    fontSize: 13,
                  }}
                />
                <Button
                  icon={<CopyOutlined />}
                  type={copied ? 'default' : 'primary'}
                  onClick={copyToken}
                >
                  {copied
                    ? t('pages.apikeys.action.copied')
                    : t('pages.apikeys.action.copy')}
                </Button>
              </Space.Compact>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('pages.apikeys.result.usageLabel')}
              </Text>
              <Paragraph
                style={{
                  background: token.colorFillTertiary,
                  borderRadius: 4,
                  padding: 12,
                  margin: '6px 0 0 0',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  fontSize: 12,
                  whiteSpace: 'pre',
                  overflowX: 'auto',
                }}
              >
                {usageCurl}
              </Paragraph>
            </div>
          </Space>
        )}
      </Modal>
    </PageContainer>
  );
};

export default APIKeysPage;
