import { useIntl, useParams, useRequest } from '@umijs/max';
import {
  App,
  Badge,
  Button,
  Col,
  Empty,
  Popconfirm,
  Row,
  Spin,
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

import { EnableDrawer } from './EnableDrawer';

const { Title } = Typography;

const CATEGORY_ORDER: PluginCategory[] = [
  'gpu',
  'monitoring',
  'logging',
  'networking',
  'serving',
  'custom',
];

// Map K8s-style phases to the antd Badge "status" prop. Anything outside
// this set falls back to "default" (grey dot).
const PHASE_STATUS: Record<
  PluginPhase,
  'default' | 'success' | 'processing' | 'error' | 'warning'
> = {
  Disabled: 'default',
  Pending: 'warning',
  Installing: 'processing',
  Upgrading: 'processing',
  Running: 'success',
  Failed: 'error',
  Uninstalling: 'processing',
};

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
    const builtins = all.filter((it) => it.plugin.is_builtin);
    const customsByCat = new Map<PluginCategory, ClusterPluginItem[]>();
    for (const it of all) {
      if (it.plugin.is_builtin) continue;
      const cat = (it.plugin.category ?? 'custom') as PluginCategory;
      if (!customsByCat.has(cat)) customsByCat.set(cat, []);
      customsByCat.get(cat)!.push(it);
    }
    const out: CategorySection[] = [];
    if (builtins.length > 0) {
      out.push({
        key: 'builtin',
        label: intl.formatMessage({ id: 'pages.plugins.builtin' }),
        items: builtins,
      });
    }
    for (const cat of CATEGORY_ORDER) {
      const list = customsByCat.get(cat);
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
    const phaseLabel = intl.formatMessage({
      id: `pages.clusterPlugins.phase.${phase}`,
    });
    const phaseTag = (
      <Tooltip title={it.message || undefined}>
        <Badge status={PHASE_STATUS[phase] ?? 'default'} text={phaseLabel} />
      </Tooltip>
    );
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
      <Col key={it.plugin.id} xs={24} sm={12} md={8} xl={6}>
        <PluginCard
          plugin={it.plugin}
          extra={phaseTag}
          footer={<div>{action}</div>}
        />
      </Col>
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
            <Row gutter={[16, 16]}>{section.items.map(renderCard)}</Row>
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
    </div>
  );
}
