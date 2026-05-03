import { DeleteOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import { Avatar, Button, Card, Popconfirm, Space, Tag, Tooltip } from 'antd';
import React from 'react';

const SUBTITLE_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--ant-color-text-secondary)',
  fontWeight: 400,
  lineHeight: 1.4,
  // Long chart names like "victoria-metrics-k8s-stack" must not push
  // the title row wider than the card; clip with ellipsis instead.
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

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

  // Subtitle text under the display name — replaces the in-title tag,
  // which didn't fit when chart names were long (victoria-metrics-k8s-
  // stack, etc.). Tooltip just shows the chart name in full, so when
  // the subtitle ellipsises on a narrow card the user can still read
  // it. Repo URL stays out of the way; if users need it they can edit/
  // view the plugin entry.
  const subtitleText = plugin.chart_name || plugin.name;
  const subtitleTooltip = subtitleText;

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      styles={{ body: { display: 'flex', flexDirection: 'column', gap: 8 } }}
      title={
        // Two-line stacked title: display_name on top, chart name below
        // in secondary grey. Long chart names ellipsis instead of
        // colliding with the top-right tag area. Tooltip shows the
        // repo URL or "local file" depending on chart_type.
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Avatar size={32} src={plugin.icon_url || undefined}>
            {initial}
          </Avatar>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span style={{ fontWeight: 500, lineHeight: 1.4 }}>
              {plugin.display_name}
            </span>
            <Tooltip title={subtitleTooltip}>
              <span style={SUBTITLE_STYLE}>{subtitleText}</span>
            </Tooltip>
          </div>
        </div>
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
      {(plugin.default_version || plugin.chart_type === 'local') && (
        <Space size={4} wrap>
          {plugin.chart_type === 'local' && (
            <Tag color="purple" style={{ marginInlineEnd: 0 }}>
              {intl.formatMessage({ id: 'pages.plugins.localTag' })}
            </Tag>
          )}
          {plugin.default_version && <Tag>{plugin.default_version}</Tag>}
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
