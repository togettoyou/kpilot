import {
  CheckCircleFilled,
  CheckCircleOutlined,
  CloseCircleFilled,
  ClusterOutlined,
  DatabaseFilled,
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
  MinusCircleOutlined,
  MoreOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { history, useIntl, useRequest } from '@umijs/max';
import { useThemeMode } from 'antd-style';
import type { MenuProps } from 'antd';
import {
  App,
  Button,
  Card,
  Dropdown,
  Empty,
  Form,
  Input,
  Modal,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useMemo, useState } from 'react';
import {
  type Cluster,
  type CreateClusterResult,
  createCluster,
  deleteCluster,
  listClusters,
  regenerateToken,
  updateCluster,
} from '@/services/kpilot/cluster';

const { Text, Paragraph } = Typography;

// ─── Token reveal modal (shown once after create / regenerate) ──────────────

const TokenModal: React.FC<{
  result: { token: string };
  title: string;
  warning: string;
  onClose: () => void;
}> = ({ result, title, warning, onClose }) => {
  const { message } = App.useApp();
  const intl = useIntl();

  return (
    <Modal
      open
      title={title}
      maskClosable={false}
      onCancel={onClose}
      footer={
        <Button type="primary" onClick={onClose}>
          {intl.formatMessage({ id: 'pages.clusters.token.done' })}
        </Button>
      }
      width={520}
    >
      <Space direction="vertical" className="w-full" size="middle">
        <Text type="warning">⚠️ {warning}</Text>
        <div>
          <Text strong>
            {intl.formatMessage({ id: 'pages.clusters.token.label' })}
          </Text>
          <Paragraph
            copyable={{
              onCopy: () =>
                message.success(
                  intl.formatMessage({ id: 'pages.clusters.copied' }),
                ),
            }}
            code
            className="mt-1 break-all"
          >
            {result.token}
          </Paragraph>
        </div>
      </Space>
    </Modal>
  );
};

// ─── KPI stat tile ──────────────────────────────────────────────────────────
//
// Big colored icon-bubble on the left, label + large number on the right.
// We use Tailwind's design-token-bound bg-{color}-50 / text-{color}-500
// pairs (with a dark-mode counterpart) rather than antd's `<Statistic>`
// because the bubble is the visual anchor — `<Statistic>`'s built-in
// `prefix` renders a small inline icon that gets visually lost next to
// the big number.
//
// `tabular-nums` keeps digit width fixed so the page doesn't shift
// horizontally when the polling refresh changes a value (e.g.
// 9 → 10 in the online count).

interface StatTileProps {
  title: string;
  value: number;
  icon: React.ReactNode;
  color: 'blue' | 'green' | 'gray';
}

// Bubble palette is keyed off the app's theme (`useThemeMode`), not
// Tailwind's `dark:` variant. `dark:` follows the OS `prefers-color-scheme`,
// which decouples from the in-app theme switcher and produces dark bubbles
// on a light page when the user runs Windows in dark mode but picks the
// light theme inside KPilot.
const STAT_COLOR_CLASSES: Record<
  StatTileProps['color'],
  { light: string; dark: string }
> = {
  blue: {
    light: 'bg-blue-50 text-blue-500',
    dark: 'bg-blue-900/30 text-blue-400',
  },
  green: {
    light: 'bg-green-50 text-green-500',
    dark: 'bg-green-900/30 text-green-400',
  },
  gray: {
    light: 'bg-gray-100 text-gray-500',
    dark: 'bg-gray-800 text-gray-400',
  },
};

const StatTile: React.FC<StatTileProps> = ({ title, value, icon, color }) => {
  const { isDarkMode } = useThemeMode();
  const palette = STAT_COLOR_CLASSES[color];
  return (
    <Card>
      <div className="flex items-center gap-4">
        <div
          className={`flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full ${
            isDarkMode ? palette.dark : palette.light
          }`}
        >
          <span className="text-2xl">{icon}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            className={`text-sm ${
              isDarkMode ? 'text-gray-400' : 'text-gray-500'
            }`}
          >
            {title}
          </div>
          <div className="mt-1 text-3xl font-semibold tabular-nums">
            {value}
          </div>
        </div>
      </div>
    </Card>
  );
};

// ─── Per-cluster card ───────────────────────────────────────────────────────

interface ClusterCardProps {
  cluster: Cluster;
  onEdit: (c: Cluster) => void;
  onRegenerate: (c: Cluster) => void;
  onDelete: (c: Cluster) => void;
}

const ClusterCard: React.FC<ClusterCardProps> = ({
  cluster,
  onEdit,
  onRegenerate,
  onDelete,
}) => {
  const intl = useIntl();
  const isOnline = cluster.status === 'online';

  // Action menu items. Each handler stops propagation defensively in case
  // a future antd version allows it to bubble up to the clickable Card.
  const menuItems: MenuProps['items'] = [
    {
      key: 'edit',
      icon: <EditOutlined />,
      label: intl.formatMessage({ id: 'pages.clusters.action.edit' }),
      onClick: ({ domEvent }) => {
        domEvent.stopPropagation();
        onEdit(cluster);
      },
    },
    {
      key: 'token',
      icon: <KeyOutlined />,
      label: intl.formatMessage({ id: 'pages.clusters.token.regenerate' }),
      onClick: ({ domEvent }) => {
        domEvent.stopPropagation();
        onRegenerate(cluster);
      },
    },
    { type: 'divider' },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      danger: true,
      label: intl.formatMessage({ id: 'pages.clusters.action.delete' }),
      onClick: ({ domEvent }) => {
        domEvent.stopPropagation();
        onDelete(cluster);
      },
    },
  ];

  // Show date + time down to the second so the user can tell apart
  // multiple updates within the same day (token regenerate / edit).
  const formatDate = (iso: string) => new Date(iso).toLocaleString();

  return (
    <Card
      hoverable
      onClick={() => history.push(`/clusters/${cluster.id}/nodes`)}
      title={
        // Flex with min-width:0 on the name so long cluster names
        // truncate instead of pushing the status tag offscreen.
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
          }}
        >
          <ClusterOutlined className="text-blue-500" style={{ flexShrink: 0 }} />
          <Text
            strong
            ellipsis={{ tooltip: cluster.name }}
            style={{ minWidth: 0, flex: 1 }}
          >
            {cluster.name}
          </Text>
          <Tag
            color={isOnline ? 'success' : 'default'}
            icon={isOnline ? <CheckCircleOutlined /> : <MinusCircleOutlined />}
            style={{ flexShrink: 0, marginInlineEnd: 0 }}
          >
            {intl.formatMessage({
              id: isOnline
                ? 'pages.clusters.status.online'
                : 'pages.clusters.status.offline',
            })}
          </Tag>
        </div>
      }
      extra={
        <Dropdown menu={{ items: menuItems }} trigger={['click']}>
          <Button
            type="text"
            icon={<MoreOutlined />}
            onClick={(e) => e.stopPropagation()}
          />
        </Dropdown>
      }
    >
      {/* Description — CSS line-clamp keeps card heights aligned.
          Long descriptions reveal in an antd Tooltip on hover, capped
          at 280px tall and scrollable inside (overlayInnerStyle), so
          a multi-paragraph description doesn't paint half the screen.
          Switched away from antd Paragraph's ellipsis={{tooltip}} —
          it kept re-measuring on hover under hoverable Card and
          flickered. */}
      <Tooltip
        title={cluster.description}
        placement="topLeft"
        overlayInnerStyle={{
          maxHeight: 280,
          overflowY: 'auto',
          wordBreak: 'break-all',
        }}
      >
        <div
          className="mb-3 min-h-[44px]"
          style={{
            color: 'var(--ant-color-text-secondary)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-all',
          }}
        >
          {cluster.description ||
            intl.formatMessage({ id: 'pages.clusters.card.noDescription' })}
        </div>
      </Tooltip>
      {/* Created / updated side-by-side, both single-line. The grid
          drops from 4 → 3 columns at xl so each card has enough room
          for two date+time strings without wrapping. */}
      <div
        className="flex justify-between text-xs text-gray-400"
        style={{ gap: 12, whiteSpace: 'nowrap' }}
      >
        <span>
          {intl.formatMessage(
            { id: 'pages.clusters.card.createdAt' },
            { date: formatDate(cluster.created_at) },
          )}
        </span>
        <span>
          {intl.formatMessage(
            { id: 'pages.clusters.card.updatedAt' },
            { date: formatDate(cluster.updated_at) },
          )}
        </span>
      </div>
    </Card>
  );
};

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ClustersPage() {
  const { modal, message } = App.useApp();
  const intl = useIntl();
  const [createVisible, setCreateVisible] = useState(false);
  const [editingCluster, setEditingCluster] = useState<Cluster | null>(null);
  const [tokenResult, setTokenResult] = useState<{
    token: string;
    title: string;
    warning: string;
  } | null>(null);
  // Destroy-by-name flow: deletingCluster opens the type-name modal;
  // deleteConfirmName mirrors the input so the proceed button can
  // gate on exact match.
  const [deletingCluster, setDeletingCluster] = useState<Cluster | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const {
    data: clusters,
    loading,
    refresh,
  } = useRequest(listClusters, {
    pollingInterval: 10000,
    formatResult: (res) => res,
    pollingWhenHidden: false,
  });
  const clusterList: Cluster[] = Array.isArray(clusters) ? clusters : [];

  // Derive stats client-side. Cheap, no extra round-trip; once we add
  // node / GPU summaries this can move to a /summary endpoint.
  const stats = useMemo(() => {
    const total = clusterList.length;
    const online = clusterList.filter((c) => c.status === 'online').length;
    return { total, online, offline: total - online };
  }, [clusterList]);

  const { loading: creating, run: doCreate } = useRequest(createCluster, {
    manual: true,
    formatResult: (res) => res,
    onSuccess: (result) => {
      setCreateVisible(false);
      form.resetFields();
      setTokenResult({
        token: (result as CreateClusterResult).token,
        title: intl.formatMessage({ id: 'pages.clusters.token.title' }),
        warning: intl.formatMessage({ id: 'pages.clusters.token.warning' }),
      });
      refresh();
    },
  });

  const { loading: editing, run: doEdit } = useRequest(updateCluster, {
    manual: true,
    formatResult: (res) => res,
    onSuccess: () => {
      setEditingCluster(null);
      editForm.resetFields();
      message.success(
        intl.formatMessage({ id: 'pages.clusters.edit.success' }),
      );
      refresh();
    },
  });

  const { run: doRegenerate } = useRequest(regenerateToken, {
    manual: true,
    formatResult: (res) => res,
    onSuccess: (result) => {
      setTokenResult({
        token: (result as { token: string }).token,
        title: intl.formatMessage({
          id: 'pages.clusters.token.regenerateTitle',
        }),
        warning: intl.formatMessage({
          id: 'pages.clusters.token.regenerateWarning',
        }),
      });
    },
  });

  const handleEdit = (c: Cluster) => {
    setEditingCluster(c);
    editForm.setFieldsValue({ name: c.name, description: c.description });
  };

  const handleRegenerate = (c: Cluster) => {
    modal.confirm({
      title: intl.formatMessage({ id: 'pages.clusters.token.regenerate' }),
      content: intl.formatMessage({
        id: 'pages.clusters.token.regenerateConfirm',
      }),
      okType: 'danger',
      onOk: () => doRegenerate(c.id),
    });
  };

  // Two-step destroy: step 1 user types the cluster name to prove
  // they know which cluster they're nuking; step 2 a final confirm
  // dialog asks once more. Same pattern GitHub uses for "delete repo".
  const handleDelete = (c: Cluster) => {
    setDeletingCluster(c);
    setDeleteConfirmName('');
  };

  const performDelete = async () => {
    if (!deletingCluster) return;
    await deleteCluster(deletingCluster.id);
    message.success(
      intl.formatMessage({ id: 'pages.clusters.delete.success' }),
    );
    setDeletingCluster(null);
    setDeleteConfirmName('');
    refresh();
  };

  const handleProceedToFinalConfirm = () => {
    if (!deletingCluster) return;
    modal.confirm({
      title: intl.formatMessage(
        { id: 'pages.clusters.delete.finalTitle' },
        { name: deletingCluster.name },
      ),
      content: intl.formatMessage({
        id: 'pages.clusters.delete.finalContent',
      }),
      okType: 'danger',
      okText: intl.formatMessage({ id: 'pages.clusters.delete.finalOk' }),
      cancelText: intl.formatMessage({ id: 'pages.clusters.delete.cancel' }),
      onOk: performDelete,
    });
  };

  // Distinguish "still loading initial data" from "loaded, empty" so we
  // don't flash the empty state's "create your first cluster" CTA on the
  // first render before the request resolves.
  const isInitialLoading = clusters === undefined && loading;

  return (
    <PageContainer
      header={{
        title: intl.formatMessage({ id: 'pages.clusters.title' }),
        subTitle: intl.formatMessage({ id: 'pages.clusters.subtitle' }),
      }}
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setCreateVisible(true)}
        >
          {intl.formatMessage({ id: 'pages.clusters.addCluster' })}
        </Button>
      }
    >
      {/* ── Stats row ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <StatTile
          color="blue"
          icon={<DatabaseFilled />}
          title={intl.formatMessage({ id: 'pages.clusters.stats.total' })}
          value={stats.total}
        />
        <StatTile
          color="green"
          icon={<CheckCircleFilled />}
          title={intl.formatMessage({ id: 'pages.clusters.stats.online' })}
          value={stats.online}
        />
        <StatTile
          color="gray"
          icon={<CloseCircleFilled />}
          title={intl.formatMessage({ id: 'pages.clusters.stats.offline' })}
          value={stats.offline}
        />
      </div>

      {/* ── Card grid / Empty state ─────────────────────────────────── */}
      {isInitialLoading ? (
        <div className="flex justify-center py-20">
          <Spin size="large" />
        </div>
      ) : clusterList.length === 0 ? (
        <Card>
          <Empty
            description={
              <Space direction="vertical" size={4}>
                <Text strong>
                  {intl.formatMessage({ id: 'pages.clusters.empty.title' })}
                </Text>
                <Text type="secondary">
                  {intl.formatMessage({ id: 'pages.clusters.empty.hint' })}
                </Text>
              </Space>
            }
          >
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreateVisible(true)}
            >
              {intl.formatMessage({ id: 'pages.clusters.empty.action' })}
            </Button>
          </Empty>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {clusterList.map((c) => (
            <ClusterCard
              key={c.id}
              cluster={c}
              onEdit={handleEdit}
              onRegenerate={handleRegenerate}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* ── Create modal ────────────────────────────────────────────── */}
      <Modal
        title={intl.formatMessage({ id: 'pages.clusters.modal.add' })}
        open={createVisible}
        onCancel={() => {
          setCreateVisible(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        confirmLoading={creating}
        okText={intl.formatMessage({ id: 'pages.clusters.modal.create' })}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => doCreate(values)}
          className="mt-4"
        >
          <Form.Item
            name="name"
            label={intl.formatMessage({ id: 'pages.clusters.modal.name' })}
            rules={[
              {
                required: true,
                message: intl.formatMessage({
                  id: 'pages.clusters.modal.nameRequired',
                }),
              },
            ]}
          >
            <Input
              placeholder={intl.formatMessage({
                id: 'pages.clusters.modal.namePlaceholder',
              })}
              maxLength={255}
            />
          </Form.Item>
          <Form.Item
            name="description"
            label={intl.formatMessage({
              id: 'pages.clusters.modal.description',
            })}
          >
            <Input.TextArea
              rows={2}
              placeholder={intl.formatMessage({
                id: 'pages.clusters.modal.descPlaceholder',
              })}
              maxLength={500}
              showCount
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── Edit modal ──────────────────────────────────────────────── */}
      <Modal
        title={intl.formatMessage({ id: 'pages.clusters.edit.title' })}
        open={!!editingCluster}
        onCancel={() => {
          setEditingCluster(null);
          editForm.resetFields();
        }}
        onOk={() => editForm.submit()}
        confirmLoading={editing}
        okText={intl.formatMessage({ id: 'pages.clusters.edit.apply' })}
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(values) => {
            if (!editingCluster) return;
            doEdit(editingCluster.id, values);
          }}
          className="mt-4"
        >
          <Form.Item
            name="name"
            label={intl.formatMessage({ id: 'pages.clusters.modal.name' })}
            rules={[
              {
                required: true,
                message: intl.formatMessage({
                  id: 'pages.clusters.modal.nameRequired',
                }),
              },
            ]}
          >
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item
            name="description"
            label={intl.formatMessage({
              id: 'pages.clusters.modal.description',
            })}
          >
            <Input.TextArea rows={2} maxLength={500} showCount />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── Token reveal modal ──────────────────────────────────────── */}
      {tokenResult && (
        <TokenModal
          result={tokenResult}
          title={tokenResult.title}
          warning={tokenResult.warning}
          onClose={() => setTokenResult(null)}
        />
      )}

      {/* ── Destroy-by-name modal (step 1) ──────────────────────────── */}
      <Modal
        title={
          deletingCluster
            ? intl.formatMessage(
                { id: 'pages.clusters.delete.title' },
                { name: deletingCluster.name },
              )
            : ''
        }
        open={!!deletingCluster}
        maskClosable={false}
        onCancel={() => {
          setDeletingCluster(null);
          setDeleteConfirmName('');
        }}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setDeletingCluster(null);
              setDeleteConfirmName('');
            }}
          >
            {intl.formatMessage({ id: 'pages.clusters.delete.cancel' })}
          </Button>,
          <Button
            key="next"
            danger
            disabled={
              !deletingCluster ||
              deleteConfirmName !== deletingCluster.name
            }
            onClick={handleProceedToFinalConfirm}
          >
            {intl.formatMessage({ id: 'pages.clusters.delete.next' })}
          </Button>,
        ]}
      >
        <p style={{ marginTop: 0 }}>
          {intl.formatMessage({ id: 'pages.clusters.delete.content' })}
        </p>
        <p>
          {intl.formatMessage(
            { id: 'pages.clusters.delete.confirmPrompt' },
            {
              name: (
                <Text code style={{ fontSize: 13 }}>
                  {deletingCluster?.name}
                </Text>
              ),
            },
          )}
        </p>
        <Input
          autoFocus
          value={deleteConfirmName}
          onChange={(e) => setDeleteConfirmName(e.target.value)}
          placeholder={deletingCluster?.name}
        />
      </Modal>
    </PageContainer>
  );
}
