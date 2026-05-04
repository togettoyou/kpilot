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
  const initial = (plugin.display_name || plugin.name)
    .slice(0, 2)
    .toUpperCase();

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
      // height:100% lets the card fill its flex-stretched wrapper, but
      // antd Card body doesn't grow to fill the card on its own — it
      // sizes to content. Make the card a flex column and the body
      // flex:1 so body stretches, which is what `marginTop: auto` on
      // the bottom action row needs to actually align across siblings.
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
      // antd Card size="small" uses very tight padding (8px header,
      // 12px body); on a 280px-wide card it ended up with text
      // bumping the frame. Push both to a comfortable 14×16.
      styles={{
        header: { padding: '10px 16px' },
        body: {
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '14px 16px',
        },
      }}
      title={
        // Two-line stacked title: display_name on top, chart name below
        // in secondary grey. Long chart names ellipsis instead of
        // colliding with the top-right tag area. Tooltip shows the
        // repo URL or "local file" depending on chart_type.
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
        >
          <Avatar size={32} src={plugin.icon_url || undefined}>
            {initial}
          </Avatar>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              minWidth: 0,
              flex: 1,
            }}
          >
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
      // per-cluster page) both live in the top-right corner. Stack
      // them vertically when BOTH are present — horizontal layout
      // ate enough title-row width to truncate longer display_names
      // ("VictoriaMetrics" → "VictoriaMetri").
      extra={
        plugin.is_builtin || extra ? (
          <Space
            size={4}
            direction={plugin.is_builtin && extra ? 'vertical' : 'horizontal'}
            align="end"
          >
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
        <Tooltip title={plugin.description} placement="topLeft">
          <div
            style={{
              color: 'var(--ant-color-text-secondary)',
              fontSize: 13,
              // Clamp at 3 lines so long descriptions can't blow up
              // the card height. -webkit-line-clamp is the de-facto
              // cross-browser way (Safari, Chrome, Firefox 68+).
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {plugin.description}
          </div>
        </Tooltip>
      )}
      {/* Chart-source tag is shown for ALL three types (repo / oci /
          local) so the comparison is symmetric — a card with no source
          tag would otherwise look like the "default" type, even though
          the choice between Helm repo, OCI registry, and uploaded .tgz
          carries real differences for users (network reachability from
          their cluster, who controls the source, offline use). */}
      <Space size={4} wrap>
        {plugin.chart_type === 'repo' && (
          <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
            {intl.formatMessage({ id: 'pages.plugins.repoTag' })}
          </Tag>
        )}
        {plugin.chart_type === 'oci' && (
          <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
            {intl.formatMessage({ id: 'pages.plugins.ociTag' })}
          </Tag>
        )}
        {plugin.chart_type === 'local' && (
          <Tag color="purple" style={{ marginInlineEnd: 0 }}>
            {intl.formatMessage({ id: 'pages.plugins.localTag' })}
          </Tag>
        )}
        {plugin.default_version && <Tag>{plugin.default_version}</Tag>}
      </Space>
      {/* Single bottom action row — right-aligned (marketplace convention)
          and pushed to the card bottom via marginTop:auto so cards in the
          same flex row visually align even with different content height. */}
      {(onView || actions || (!plugin.is_builtin && (onEdit || onDelete))) && (
        <Space
          style={{
            // Auto pushes the row to the bottom on cards stretched by
            // their flex sibling; paddingTop guarantees a minimum gap
            // above the buttons even on short cards where auto = 0
            // (otherwise they sat right under the chart subtitle).
            marginTop: 'auto',
            paddingTop: 8,
            justifyContent: 'flex-end',
            display: 'flex',
          }}
          wrap
        >
          {onView && (
            <Button
              size="small"
              icon={<EyeOutlined />}
              onClick={() => onView(plugin)}
            >
              {intl.formatMessage({ id: 'pages.plugins.view' })}
            </Button>
          )}
          {actions}
          {!plugin.is_builtin && onEdit && (
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => onEdit(plugin)}
            >
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
