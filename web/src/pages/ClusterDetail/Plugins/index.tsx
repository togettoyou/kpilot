import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import { useIntl, useParams, useRequest } from '@umijs/max';
import {
  App,
  Button,
  Empty,
  Popconfirm,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import React, { useMemo, useState } from 'react';

import type {
  ClusterPluginItem,
  Plugin,
  PluginCategory,
  PluginPhase,
} from '@/services/kpilot/plugin';
import { disablePlugin, listClusterPlugins } from '@/services/kpilot/plugin';
import { PluginCard } from '@/pages/Plugins/PluginCard';
import { PluginEditDrawer } from '@/pages/Plugins/PluginEditDrawer';

import { EnableDrawer } from './EnableDrawer';

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

  return message ? <Tooltip title={message}>{inner}</Tooltip> : inner;
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
  // The per-cluster page has no edit/delete; "view" is the only way to
  // inspect chart_repo, default_values, etc. Reuses the global page's
  // PluginEditDrawer in readOnly mode.
  const [viewing, setViewing] = useState<Plugin | null>(null);

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
    const action = it.enabled ? (
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
    return (
      <div key={it.plugin.id} style={{ width: 280 }}>
        <PluginCard
          plugin={it.plugin}
          onView={(p) => setViewing(p)}
          extra={phaseTag}
          actions={action}
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
        onEnabled={refresh}
      />
      <PluginEditDrawer
        open={!!viewing}
        editing={viewing}
        readOnly
        onClose={() => setViewing(null)}
        onSaved={() => {}}
      />
    </div>
  );
}
