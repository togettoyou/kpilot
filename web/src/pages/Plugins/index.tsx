import { PlusOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { useIntl, useRequest } from '@umijs/max';
import { App, Button, Empty, Spin, Typography } from 'antd';
import React, { useMemo, useState } from 'react';

import type { Plugin, PluginCategory } from '@/services/kpilot/plugin';
import { deletePlugin, listPlugins } from '@/services/kpilot/plugin';

import { PluginCard } from './PluginCard';
import { PluginEditDrawer } from './PluginEditDrawer';

const { Title } = Typography;

// Display order: pure category grouping. The "built-in" status is shown
// as a tag on each card, not as a separate section, so HAMi (gpu) and a
// user's custom GPU plugin sit side-by-side under "GPU".
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

interface CategorySection {
  key: string;
  label: string;
  plugins: Plugin[];
}

export default function PluginsPage() {
  const intl = useIntl();
  const { message } = App.useApp();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Plugin | null>(null);

  const { data, loading, refresh } = useRequest(listPlugins, {
    formatResult: (res) => res,
  });

  const sections = useMemo<CategorySection[]>(() => {
    const all = data ?? [];
    const byCat = new Map<PluginCategory, Plugin[]>();
    for (const p of all) {
      const cat = (p.category ?? 'custom') as PluginCategory;
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(p);
    }
    const out: CategorySection[] = [];
    for (const cat of CATEGORY_ORDER) {
      const list = byCat.get(cat);
      if (list && list.length > 0) {
        out.push({
          key: cat,
          label: intl.formatMessage({ id: `pages.plugins.category.${cat}` }),
          plugins: list,
        });
      }
    }
    return out;
  }, [data, intl]);

  const handleDelete = async (p: Plugin) => {
    try {
      await deletePlugin(p.id);
      message.success(
        intl.formatMessage({ id: 'pages.plugins.delete.success' }),
      );
      refresh();
    } catch {
      // global toast
    }
  };

  return (
    <PageContainer
      title={intl.formatMessage({ id: 'pages.plugins.title' })}
      subTitle={intl.formatMessage({ id: 'pages.plugins.subtitle' })}
      extra={[
        <Button
          key="add"
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditing(null);
            setDrawerOpen(true);
          }}
        >
          {intl.formatMessage({ id: 'pages.plugins.add' })}
        </Button>,
      ]}
    >
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
              {section.plugins.map((p) => (
                <div key={p.id} style={{ width: 300 }}>
                  <PluginCard
                    plugin={p}
                    onEdit={(plugin) => {
                      setEditing(plugin);
                      setDrawerOpen(true);
                    }}
                    onDelete={handleDelete}
                  />
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      <PluginEditDrawer
        open={drawerOpen}
        editing={editing}
        onClose={() => setDrawerOpen(false)}
        onSaved={refresh}
      />
    </PageContainer>
  );
}
