import {
  CloudUploadOutlined,
  CopyOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import {
  App,
  Avatar,
  Button,
  Descriptions,
  Drawer,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import React from 'react';

import type { Model } from '@/services/kpilot/model';
import { FAMILY_META, RUNTIME_LABELS } from '@/services/kpilot/model';

const { Text, Paragraph } = Typography;

interface Props {
  open: boolean;
  model: Model | null;
  onClose: () => void;
  onEdit: (m: Model) => void;
  onDuplicate: (m: Model) => void;
  onDeploy: (m: Model) => void;
}

// Read-only detail view that opens when a card is clicked. Separates
// "I want to look at this row" from "I want to edit this row" — the
// latter goes through the Edit button (or, for built-ins, the
// Duplicate button which lands in the editor pre-filled).
const ModelDetailDrawer: React.FC<Props> = ({
  open,
  model,
  onClose,
  onEdit,
  onDuplicate,
  onDeploy,
}) => {
  const intl = useIntl();
  const { message } = App.useApp();
  // Same tokens the page uses — keeps the args code block legible
  // in both light + dark themes (the previous hard-coded #f5f5f5
  // background was invisible in dark mode).
  const { token } = theme.useToken();

  if (!model) return null;

  const meta =
    model.family === 'custom'
      ? null
      : FAMILY_META[model.family as Exclude<typeof model.family, 'custom'>];

  // Parse default_args once; fallback to raw string if shape is bad.
  const args = (() => {
    try {
      const parsed = JSON.parse(model.default_args);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      /* fall through */
    }
    return null;
  })();

  // Parse recommended_gpu once. Same fallback semantics.
  const gpu = (() => {
    try {
      return JSON.parse(model.recommended_gpu) as {
        count?: number;
        memoryGiB?: number;
        model?: string;
      };
    } catch {
      return null;
    }
  })();

  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      message.success(intl.formatMessage({ id: 'pages.common.copied' }));
    } catch {
      message.error(intl.formatMessage({ id: 'pages.common.copyFailed' }));
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="large"
      maskClosable
      destroyOnHidden
      title={
        <Space size={12}>
          <Avatar
            shape="square"
            size={36}
            src={meta?.iconUrl}
            style={{
              backgroundColor: meta?.color ?? '#8c8c8c',
              color: '#fff',
            }}
          >
            {model.display_name.charAt(0).toUpperCase()}
          </Avatar>
          <Space direction="vertical" size={0}>
            <Text strong style={{ fontSize: 16 }}>
              {model.display_name}
            </Text>
            <Text type="secondary" code style={{ fontSize: 12 }}>
              {model.name}
            </Text>
          </Space>
        </Space>
      }
      extra={
        <Space>
          <Button icon={<CopyOutlined />} onClick={() => onDuplicate(model)}>
            {intl.formatMessage({
              id: 'pages.models.registry.action.duplicate',
            })}
          </Button>
          <Button
            icon={<EditOutlined />}
            disabled={model.is_builtin}
            onClick={() => onEdit(model)}
          >
            {intl.formatMessage({ id: 'pages.common.edit' })}
          </Button>
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            onClick={() => onDeploy(model)}
          >
            {intl.formatMessage({ id: 'pages.models.deploy.action.deploy' })}
          </Button>
        </Space>
      }
    >
      {/* badges row */}
      <Space size={6} wrap style={{ marginBottom: 16 }}>
        {model.is_builtin && (
          <Tag color="blue">
            {intl.formatMessage({ id: 'pages.models.registry.builtin' })}
          </Tag>
        )}
        <Tag color={meta?.color ?? 'default'}>
          {meta?.label ??
            intl.formatMessage({ id: 'pages.models.registry.custom' })}
        </Tag>
        <Tag>{RUNTIME_LABELS[model.runtime]}</Tag>
        {model.license && <Tag color="default">{model.license}</Tag>}
      </Space>

      {/* description */}
      {model.description && (
        <Paragraph style={{ marginBottom: 16 }}>{model.description}</Paragraph>
      )}

      <Descriptions
        column={1}
        size="small"
        bordered
        labelStyle={{ width: 180 }}
        items={[
          {
            key: 'hf',
            label: intl.formatMessage({ id: 'pages.models.registry.col.hf' }),
            children: model.hugging_face_id ? (
              <Space size={6}>
                <a
                  href={`https://huggingface.co/${model.hugging_face_id}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                >
                  🤗 {model.hugging_face_id}
                </a>
                <Button
                  size="small"
                  type="text"
                  icon={<CopyOutlined />}
                  onClick={() => copyToClipboard(model.hugging_face_id)}
                />
              </Space>
            ) : (
              <Text type="secondary">—</Text>
            ),
          },
          {
            key: 'image',
            label: intl.formatMessage({
              id: 'pages.models.registry.col.image',
            }),
            children: (
              <Space size={6}>
                <Text code style={{ fontSize: 12 }}>
                  {model.image}
                </Text>
                <Button
                  size="small"
                  type="text"
                  icon={<CopyOutlined />}
                  onClick={() => copyToClipboard(model.image)}
                />
              </Space>
            ),
          },
          {
            key: 'gpu',
            label: intl.formatMessage({ id: 'pages.models.registry.col.gpu' }),
            children: gpu ? (
              <Text>
                {gpu.count ? `${gpu.count}×` : ''}{' '}
                {gpu.memoryGiB ? `${gpu.memoryGiB} GiB` : ''}
                {gpu.model && gpu.model !== 'any' ? ` (${gpu.model})` : ''}
              </Text>
            ) : (
              <Text type="secondary">—</Text>
            ),
          },
        ]}
      />

      {/* Default args list. We render each element on its own line —
          a single horizontal blob would mask which args belong to
          which flag. Empty / unparseable falls back to a code block
          of the raw string. */}
      <Typography.Title level={5} style={{ marginTop: 24, marginBottom: 8 }}>
        {intl.formatMessage({
          id: 'pages.models.registry.form.defaultArgs',
        })}
      </Typography.Title>
      {args ? (
        <div
          style={{
            background: token.colorFillTertiary,
            padding: 12,
            borderRadius: token.borderRadius,
            fontFamily: 'monospace',
            fontSize: 12,
            color: token.colorText,
          }}
        >
          {args.length === 0 ? (
            <Text type="secondary">
              {intl.formatMessage({ id: 'pages.models.registry.noArgs' })}
            </Text>
          ) : (
            // Args are positional CLI flags parsed from immutable
            // JSON; they never reorder within a single drawer
            // lifetime, so index is the correct key. Combining with
            // `arg` doesn't help because the same flag CAN repeat.
            args.map((arg, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable-order args
              <div key={i}>{arg}</div>
            ))
          )}
        </div>
      ) : (
        <Text code style={{ fontSize: 12 }}>
          {model.default_args || '—'}
        </Text>
      )}
    </Drawer>
  );
};

export default ModelDetailDrawer;
