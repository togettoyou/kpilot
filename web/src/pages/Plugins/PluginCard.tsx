import { DeleteOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import { Avatar, Button, Card, Popconfirm, Space, Tag, Tooltip } from 'antd';
import React from 'react';

import type { Plugin } from '@/services/kpilot/plugin';

interface PluginCardProps {
  plugin: Plugin;
  // Always-available read-only inspector. The drawer it opens is the
  // same edit drawer in `readOnly` mode, so users see chart_repo /
  // default values / etc. without risking accidental edits. Shown
  // unconditionally when provided (even on built-ins where edit is off).
  onView?: (p: Plugin) => void;
  // Edit + delete buttons. Built-in plugins call these as undefined so
  // their card stays read-only.
  onEdit?: (p: Plugin) => void;
  onDelete?: (p: Plugin) => void;
  // Right-side overlay (phase tag for the per-cluster page; nothing on
  // the global registry).
  extra?: React.ReactNode;
  // Page-specific action(s) appended to the bottom button row alongside
  // view/edit/delete — e.g. the per-cluster page's enable/disable.
  actions?: React.ReactNode;
}

export function PluginCard({
  plugin,
  onView,
  onEdit,
  onDelete,
  extra,
  actions,
}: PluginCardProps) {
  const intl = useIntl();
  const initial = (plugin.display_name || plugin.name).slice(0, 2).toUpperCase();

  // Show chart source as a small badge so users can tell at-a-glance
  // whether a plugin pulls from a repo or runs from an uploaded file.
  const chartTag =
    plugin.chart_type === 'repo' ? (
      <Tooltip title={plugin.chart_repo}>
        <Tag color="blue" style={{ marginInlineEnd: 0 }}>
          {plugin.chart_name || plugin.name}
        </Tag>
      </Tooltip>
    ) : (
      <Tag color="purple" style={{ marginInlineEnd: 0 }}>
        local
      </Tag>
    );

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      styles={{ body: { display: 'flex', flexDirection: 'column', gap: 8 } }}
      title={
        <Space size={8}>
          <Avatar size={28} src={plugin.icon_url || undefined}>
            {initial}
          </Avatar>
          <span style={{ fontWeight: 500 }}>{plugin.display_name}</span>
          {/* Inline chart-source badge — secondary identifier sits next
              to the display name instead of in the body, freeing up the
              body for the description. */}
          {chartTag}
        </Space>
      }
      // The "内置" tag and the page-specific extra (phase badge on the
      // per-cluster page) both live in the top-right corner — combine
      // them into one Space so the title row stays uncluttered.
      extra={
        plugin.is_builtin || extra ? (
          <Space size={8}>
            {plugin.is_builtin && (
              <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                {intl.formatMessage({ id: 'pages.plugins.builtin' })}
              </Tag>
            )}
            {extra}
          </Space>
        ) : undefined
      }
    >
      {plugin.description && (
        <div style={{ color: 'var(--ant-color-text-secondary)', fontSize: 13 }}>
          {plugin.description}
        </div>
      )}
      {plugin.default_version && (
        <Space size={4} wrap>
          <Tag>{plugin.default_version}</Tag>
        </Space>
      )}
      {/* Single bottom action row — right-aligned (marketplace convention)
          and pushed to the card bottom via marginTop:auto so cards in the
          same flex row visually align even with different content height. */}
      {(onView || actions || (!plugin.is_builtin && (onEdit || onDelete))) && (
        <Space style={{ marginTop: 'auto', justifyContent: 'flex-end', display: 'flex' }} wrap>
          {onView && (
            <Button size="small" icon={<EyeOutlined />} onClick={() => onView(plugin)}>
              {intl.formatMessage({ id: 'pages.plugins.view' })}
            </Button>
          )}
          {actions}
          {!plugin.is_builtin && onEdit && (
            <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(plugin)}>
              {intl.formatMessage({ id: 'pages.plugins.edit' })}
            </Button>
          )}
          {!plugin.is_builtin && onDelete && (
            <Popconfirm
              title={intl.formatMessage(
                { id: 'pages.plugins.delete.confirm' },
                { name: plugin.display_name },
              )}
              onConfirm={() => onDelete(plugin)}
              okType="danger"
            >
              <Button size="small" danger icon={<DeleteOutlined />}>
                {intl.formatMessage({ id: 'pages.plugins.delete' })}
              </Button>
            </Popconfirm>
          )}
        </Space>
      )}
    </Card>
  );
}
