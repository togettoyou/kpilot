import { PlusOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { useIntl, useRequest } from '@umijs/max';
import { App, Button, Col, Empty, Row, Spin, Typography } from 'antd';
import React, { useMemo, useState } from 'react';

import type { Plugin, PluginCategory } from '@/services/kpilot/plugin';
import { deletePlugin, listPlugins } from '@/services/kpilot/plugin';

import { PluginCard } from './PluginCard';
import { PluginEditDrawer } from './PluginEditDrawer';

const { Title } = Typography;

// Display order: built-ins on top (one section), then category groups in
// this order. Anything outside this list falls into "custom".
const CATEGORY_ORDER: PluginCategory[] = [
  'gpu',
  'monitoring',
  'logging',
  'networking',
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
    const builtins = all.filter((p) => p.is_builtin);
    const customsByCat = new Map<PluginCategory, Plugin[]>();
    for (const p of all) {
      if (p.is_builtin) continue;
      const cat = p.category ?? 'custom';
      if (!customsByCat.has(cat)) customsByCat.set(cat, []);
      customsByCat.get(cat)!.push(p);
    }
    const out: CategorySection[] = [];
    if (builtins.length > 0) {
      out.push({
        key: 'builtin',
        label: intl.formatMessage({ id: 'pages.plugins.builtin' }),
        plugins: builtins,
      });
    }
    for (const cat of CATEGORY_ORDER) {
      const list = customsByCat.get(cat);
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
            <Row gutter={[16, 16]}>
              {section.plugins.map((p) => (
                <Col key={p.id} xs={24} sm={12} md={8} xl={6}>
                  <PluginCard
                    plugin={p}
                    onEdit={(plugin) => {
                      setEditing(plugin);
                      setDrawerOpen(true);
                    }}
                    onDelete={handleDelete}
                  />
                </Col>
              ))}
            </Row>
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
