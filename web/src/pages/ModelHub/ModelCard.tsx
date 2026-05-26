import {
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import { Avatar, Button, Card, Space, Tag, Tooltip, Typography } from 'antd';
import React from 'react';

import type { Model } from '@/services/kpilot/model';
import { FAMILY_META, RUNTIME_LABELS } from '@/services/kpilot/model';

const { Text, Paragraph } = Typography;

interface Props {
  model: Model;
  onView: (m: Model) => void;
  onEdit: (m: Model) => void;
  onDuplicate: (m: Model) => void;
  onDelete: (m: Model) => void;
  onDeploy: (m: Model) => void;
}

// SourceLine renders the "where does the model come from" line for
// a catalog row. Visual is one of:
//   🤗 Qwen/Qwen3-0.6B          (HuggingFace)
//   📦 Qwen/Qwen3-0.6B          (ModelScope)
//   📁 /models/qwen3-0.6b        (Local Path)
//   🗂  ghcr.io/.../qwen:v1      (OCI)
// Returns null when the source's primary field is empty so a
// half-edited row doesn't render a bare prefix.
const SourceLine: React.FC<{ model: Model }> = ({ model }) => {
  const source = model.source || 'huggingface';
  let prefix = '🤗';
  let value = model.source_ref;
  if (source === 'modelscope') {
    prefix = '📦';
    value = model.source_ref;
  } else if (source === 'local_path') {
    prefix = '📁';
    value = model.local_path;
  } else if (source === 'oci') {
    prefix = '🗂';
    value = model.oci_url;
  }
  if (!value) return null;
  return (
    <Text
      type="secondary"
      code
      style={{ fontSize: 11, wordBreak: 'break-all' }}
    >
      {prefix} {value}
    </Text>
  );
};

// ModelCard renders one catalog entry in the family-grouped grid.
// Clicking anywhere on the card body opens the read-only detail
// drawer (View); the action toolbar at the bottom-right has explicit
// Edit / Duplicate / Delete buttons that stop propagation. The
// duplicate-from-builtin path is the key UX win — built-ins lock
// Edit/Delete but Duplicate is always available so admins can fork
// a preset into a custom row instead of being told "no".
const ModelCard: React.FC<Props> = ({
  model,
  onView,
  onEdit,
  onDuplicate,
  onDelete,
  onDeploy,
}) => {
  const intl = useIntl();
  const meta =
    model.family === 'custom'
      ? null
      : FAMILY_META[model.family as Exclude<typeof model.family, 'custom'>];
  const lockedTip = intl.formatMessage({
    id: 'pages.models.registry.builtinHint',
  });

  // Parsed GPU shape rendered as a compact string. Falls back to
  // empty (we just omit the badge) when the row is malformed.
  const gpuLabel = (() => {
    if (!model.recommended_gpu) return '';
    try {
      const g = JSON.parse(model.recommended_gpu) as {
        count?: number;
        memoryGiB?: number;
        model?: string;
      };
      const parts: string[] = [];
      if (g.count) parts.push(`${g.count}×`);
      if (g.memoryGiB) parts.push(`${g.memoryGiB}G`);
      const head = parts.join(' ');
      const tail = g.model && g.model !== 'any' ? ` ${g.model}` : '';
      return head + tail;
    } catch {
      return '';
    }
  })();

  // Avatar: official org logo on top of a colored bg. If src fails
  // to load, antd Avatar renders the children (first letter of the
  // display_name) on the colored bg. Custom rows skip the logo and
  // go straight to the letter on a neutral gray.
  const avatar = (
    <Avatar
      shape="square"
      size={40}
      src={meta?.iconUrl}
      style={{
        backgroundColor: meta?.color ?? '#8c8c8c',
        color: '#fff',
        flexShrink: 0,
      }}
    >
      {model.display_name.charAt(0).toUpperCase()}
    </Avatar>
  );

  return (
    <Card
      hoverable
      onClick={() => onView(model)}
      style={{ height: '100%' }}
      styles={{
        body: {
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          height: '100%',
        },
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {avatar}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 8,
            }}
          >
            <Text
              strong
              style={{ fontSize: 14, lineHeight: 1.3 }}
              ellipsis={{ tooltip: false }}
            >
              {model.display_name}
            </Text>
            {model.is_builtin && (
              <Tag color="blue" style={{ marginRight: 0, flexShrink: 0 }}>
                {intl.formatMessage({ id: 'pages.models.registry.builtin' })}
              </Tag>
            )}
          </div>
          <Text type="secondary" code style={{ fontSize: 11 }}>
            {model.name}
          </Text>
        </div>
      </div>

      {/* Body — source identifier (the meaningful "where it comes
          from" string for this catalog row) + description. Prefix
          icon picks the most recognizable visual cue per source. */}
      <SourceLine model={model} />


      {/* Description: 4-line preview, no hover-tooltip on overflow.
          Card click opens the read-only detail drawer where the
          full description lives — keeps the "hover reveals stuff"
          pattern out of the catalog browse path. */}
      <Paragraph
        type="secondary"
        ellipsis={{ rows: 4, tooltip: false }}
        style={{ fontSize: 12, marginBottom: 0, flex: 1 }}
      >
        {model.description || (
          <span style={{ fontStyle: 'italic' }}>
            {intl.formatMessage({ id: 'pages.models.registry.noDescription' })}
          </span>
        )}
      </Paragraph>

      {/* Footer — badges + actions */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <Space size={4} wrap>
          <Tag style={{ marginRight: 0 }}>{RUNTIME_LABELS[model.runtime]}</Tag>
          {gpuLabel && (
            <Tag color="geekblue" style={{ marginRight: 0 }}>
              {gpuLabel}
            </Tag>
          )}
          {model.license && (
            <Tag color="default" style={{ marginRight: 0 }}>
              {model.license}
            </Tag>
          )}
        </Space>
        <Space
          size="small"
          onClick={(e) => e.stopPropagation()} // don't trigger card View
        >
          {/* Deploy is the primary CTA — stays in its own Space
              slot with a visible gap from the secondary icon row,
              so users don't accidentally click Duplicate when
              aiming for Deploy on small screens. */}
          <Tooltip
            title={intl.formatMessage({
              id: 'pages.models.deploy.action.deploy',
            })}
          >
            <Button
              size="small"
              type="primary"
              icon={<CloudUploadOutlined />}
              onClick={() => onDeploy(model)}
            />
          </Tooltip>
          <Space size={0}>
            <Tooltip
              title={intl.formatMessage({
                id: 'pages.models.registry.action.duplicate',
              })}
            >
              <Button
                size="small"
                type="text"
                icon={<CopyOutlined />}
                onClick={() => onDuplicate(model)}
              />
            </Tooltip>
            <Tooltip
              title={
                model.is_builtin
                  ? lockedTip
                  : intl.formatMessage({ id: 'pages.common.edit' })
              }
            >
              <Button
                size="small"
                type="text"
                icon={<EditOutlined />}
                disabled={model.is_builtin}
                onClick={() => onEdit(model)}
              />
            </Tooltip>
            <Tooltip
              title={
                model.is_builtin
                  ? lockedTip
                  : intl.formatMessage({ id: 'pages.common.delete' })
              }
            >
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                disabled={model.is_builtin}
                onClick={() => onDelete(model)}
              />
            </Tooltip>
          </Space>
        </Space>
      </div>
    </Card>
  );
};

export default ModelCard;
