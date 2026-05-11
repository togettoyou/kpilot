import {
  CheckCircleFilled,
  CloseCircleFilled,
  CopyOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import { useIntl, useParams, useRequest } from '@umijs/max';
import {
  App,
  Button,
  Empty,
  Popconfirm,
  Popover,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useMemo, useState } from 'react';

import type {
  ClusterPluginItem,
  PluginCategory,
  PluginPhase,
} from '@/services/kpilot/plugin';
import { disablePlugin, listClusterPlugins } from '@/services/kpilot/plugin';
import { PluginCard } from '@/pages/Plugins/PluginCard';
import { PluginInstallLogDrawer } from '@/components/PluginInstallLogDrawer';

import { EnableDrawer } from './EnableDrawer';

// Phases where the install-log drawer is worth opening: anything
// actively running (worker still emitting log lines) or recently
// failed (user wants to see WHY). Running / Disabled don't show the
// button because their logs are either gone (TTL'd out) or
// uninteresting.
const LOGGABLE_PHASES = new Set<PluginPhase>([
  'Pending',
  'Installing',
  'Upgrading',
  'Uninstalling',
  'Failed',
]);

const { Title } = Typography;

// Display order: pure category grouping. The "built-in" status is shown
// as a tag on each card, not as a separate section.
const CATEGORY_ORDER: PluginCategory[] = [
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

// Visual style for each phase. The in-flight phases (Pending /
// Installing / Upgrading / Uninstalling) use LoadingOutlined whose
// built-in spin gives the "something is happening" cue users expect.
// Running / Failed are static but use bold filled icons so they read
// at-a-glance. Disabled stays muted.
interface PhaseVisual {
  // antd Tag color name. Empty string = no Tag, render plain text.
  color: '' | 'processing' | 'success' | 'error' | 'warning';
  icon: React.ReactNode;
  // Bold the label for failure so it stands out among the cards.
  bold?: boolean;
}

const PHASE_VISUALS: Record<PluginPhase, PhaseVisual> = {
  Disabled: { color: '', icon: <MinusCircleOutlined /> },
  Pending: { color: 'warning', icon: <LoadingOutlined spin /> },
  Installing: { color: 'processing', icon: <LoadingOutlined spin /> },
  Upgrading: { color: 'processing', icon: <LoadingOutlined spin /> },
  Uninstalling: { color: 'warning', icon: <LoadingOutlined spin /> },
  Running: { color: 'success', icon: <CheckCircleFilled /> },
  Failed: { color: 'error', icon: <CloseCircleFilled />, bold: true },
};

function PhaseTag({
  phase,
  message,
}: {
  phase: PluginPhase;
  message?: string;
}) {
  const intl = useIntl();
  const { message: msg } = App.useApp();
  const label = intl.formatMessage({
    id: `pages.clusterPlugins.phase.${phase}`,
  });
  const visual = PHASE_VISUALS[phase];

  const inner = visual.color ? (
    <Tag
      color={visual.color}
      icon={visual.icon}
      style={{
        marginInlineEnd: 0,
        fontWeight: visual.bold ? 600 : undefined,
      }}
    >
      {label}
    </Tag>
  ) : (
    <span
      style={{
        color: 'var(--ant-color-text-secondary)',
        fontSize: 13,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {visual.icon}
      {label}
    </span>
  );

  if (!message) return inner;

  // Failed messages can be long (full Helm error, sometimes near our
  // 4 KiB cap). Tooltip can't scroll on hover, so we use a click
  // Popover with a scrollable monospace block + Copy button.
  if (phase === 'Failed') {
    const handleCopy = async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(message);
        msg.success(intl.formatMessage({ id: 'pages.workloads.copied' }));
      } catch {
        msg.error(intl.formatMessage({ id: 'pages.describe.copyFailed' }));
      }
    };
    return (
      <Popover
        // Hover trigger gives the at-a-glance feel of a Tooltip but,
        // unlike Tooltip, the panel stays open when the cursor moves
        // over its content — so users can scroll a long error and
        // click Copy without it closing.
        trigger="hover"
        mouseLeaveDelay={0.3}
        title={
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <span>
              {intl.formatMessage({
                id: 'pages.clusterPlugins.errorPopover.title',
              })}
            </span>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={handleCopy}
            >
              {intl.formatMessage({
                id: 'pages.clusterPlugins.errorPopover.copy',
              })}
            </Button>
          </div>
        }
        overlayStyle={{ maxWidth: 600 }}
        content={
          <pre
            style={{
              margin: 0,
              maxWidth: 560,
              maxHeight: 400,
              overflow: 'auto',
              // Stop the wheel/touchpad scroll from chaining to the
              // page once we hit either edge — without this, scrolling
              // a long Helm error past its end made the whole window
              // jump.
              overscrollBehavior: 'contain',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily:
                'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
              fontSize: 12,
              lineHeight: 1.5,
              color: 'var(--ant-color-text)',
            }}
          >
            {message}
          </pre>
        }
      >
        {inner}
      </Popover>
    );
  }
  return <Tooltip title={message}>{inner}</Tooltip>;
}

interface CategorySection {
  key: string;
  label: string;
  items: ClusterPluginItem[];
}

export default function ClusterPluginsPage() {
  const intl = useIntl();
  const { message } = App.useApp();
  const { id: clusterId = '' } = useParams<{ id: string }>();
  const [enableTarget, setEnableTarget] = useState<ClusterPluginItem | null>(
    null,
  );
  // 查看 reuses the EnableDrawer in readOnly mode so users see the
  // override that's actually live on this cluster (for enabled rows)
  // or the registry default (for disabled rows where the override was
  // wiped on disable). PluginEditDrawer would only show registry
  // metadata, not the per-cluster install state.
  const [viewing, setViewing] = useState<ClusterPluginItem | null>(null);
  // Live install-log drawer target. Set when the user (a) clicks
  // 查看日志 on an in-flight / failed card, or (b) submits the
  // EnableDrawer — we hand them straight to the progress view
  // instead of a silent "submitted" toast.
  const [installLogTarget, setInstallLogTarget] =
    useState<ClusterPluginItem | null>(null);

  const { data, loading, refresh } = useRequest(
    () => listClusterPlugins(clusterId),
    {
      formatResult: (res) => res,
      refreshDeps: [clusterId],
      // Status updates land in the DB asynchronously (Worker pushes
      // PluginStatusPush), so poll keeps the UI fresh while a Helm
      // install/upgrade/uninstall is in flight. Built-in `useRequest`
      // polling pauses while the tab is hidden, unlike a raw setInterval.
      pollingInterval: 5000,
      pollingWhenHidden: false,
    },
  );

  const sections = useMemo<CategorySection[]>(() => {
    const all = data ?? [];
    const byCat = new Map<PluginCategory, ClusterPluginItem[]>();
    for (const it of all) {
      const cat = (it.plugin.category ?? 'custom') as PluginCategory;
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(it);
    }
    const out: CategorySection[] = [];
    for (const cat of CATEGORY_ORDER) {
      const list = byCat.get(cat);
      if (list && list.length > 0) {
        out.push({
          key: cat,
          label: intl.formatMessage({ id: `pages.plugins.category.${cat}` }),
          items: list,
        });
      }
    }
    return out;
  }, [data, intl]);

  const handleDisable = async (it: ClusterPluginItem) => {
    try {
      await disablePlugin(clusterId, it.plugin.name);
      message.success(
        intl.formatMessage({ id: 'pages.clusterPlugins.disable.success' }),
      );
      refresh();
    } catch {
      // global toast
    }
  };

  const renderCard = (it: ClusterPluginItem) => {
    const phase = it.phase || 'Disabled';
    const phaseTag = <PhaseTag phase={phase} message={it.message} />;
    const primaryAction = it.enabled ? (
      <Popconfirm
        title={intl.formatMessage(
          { id: 'pages.clusterPlugins.disable.confirm' },
          { name: it.plugin.display_name },
        )}
        onConfirm={() => handleDisable(it)}
        okType="danger"
      >
        <Button size="small" danger>
          {intl.formatMessage({ id: 'pages.clusterPlugins.disable' })}
        </Button>
      </Popconfirm>
    ) : (
      <Button
        size="small"
        type="primary"
        onClick={() => setEnableTarget(it)}
      >
        {intl.formatMessage({ id: 'pages.clusterPlugins.enable' })}
      </Button>
    );
    // Show 查看日志 alongside the primary action whenever the plugin
    // is in a phase the install-log is interesting for. Layout: small
    // text button on the left of the primary action, so the destructive
    // button (Disable/Enable) stays in the rightmost slot.
    const logAction = LOGGABLE_PHASES.has(phase) ? (
      <Button
        size="small"
        type="link"
        onClick={() => setInstallLogTarget(it)}
        style={{ paddingInline: 0 }}
      >
        {intl.formatMessage({ id: 'pages.clusterPlugins.viewLog' })}
      </Button>
    ) : null;
    const actions = logAction ? (
      <Space size={4}>
        {logAction}
        {primaryAction}
      </Space>
    ) : (
      primaryAction
    );
    return (
      <div key={it.plugin.id} style={{ width: 280 }}>
        <PluginCard
          plugin={it.plugin}
          onView={() => setViewing(it)}
          extra={phaseTag}
          actions={actions}
        />
      </div>
    );
  };

  return (
    <div className="p-6">
      {loading && !data ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin />
        </div>
      ) : sections.length === 0 ? (
        <Empty description={intl.formatMessage({ id: 'pages.plugins.empty' })} />
      ) : (
        sections.map((section) => (
          <div key={section.key} style={{ marginBottom: 24 }}>
            <Title level={5} style={{ marginBottom: 12 }}>
              {section.label}
            </Title>
            {/* Flex-wrap with fixed-width cards: a category with one
                plugin shows a single card at its natural width instead
                of a stretched 25%-wide card with empty space. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
              {section.items.map(renderCard)}
            </div>
          </div>
        ))
      )}
      <EnableDrawer
        open={!!enableTarget}
        clusterId={clusterId}
        target={enableTarget}
        onClose={() => setEnableTarget(null)}
        // Hand the user from the enable form straight into the live
        // install-log so they see the chart pull / helm install /
        // wait progress instead of a silent toast + polling card.
        onEnabled={() => {
          if (enableTarget) setInstallLogTarget(enableTarget);
          refresh();
        }}
      />
      <EnableDrawer
        open={!!viewing}
        clusterId={clusterId}
        target={viewing}
        readOnly
        onClose={() => setViewing(null)}
        onEnabled={() => {}}
      />
      <PluginInstallLogDrawer
        open={!!installLogTarget}
        clusterId={clusterId}
        pluginName={installLogTarget?.plugin.name ?? ''}
        displayName={installLogTarget?.plugin.display_name ?? ''}
        onClose={() => setInstallLogTarget(null)}
      />
    </div>
  );
}
