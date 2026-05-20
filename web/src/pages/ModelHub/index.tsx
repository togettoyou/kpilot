import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { useIntl, useRequest } from '@umijs/max';
import {
  Alert,
  App,
  Avatar,
  Badge,
  Button,
  Col,
  Collapse,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Typography,
} from 'antd';
import React, { useMemo, useState } from 'react';

import type { Model, ModelFamily, ModelRuntime } from '@/services/kpilot/model';
import {
  deleteModel,
  FAMILY_META,
  listModels,
  MODEL_FAMILIES,
  MODEL_RUNTIMES,
  RUNTIME_LABELS,
} from '@/services/kpilot/model';

import ModelCard from './ModelCard';
import ModelDetailDrawer from './ModelDetailDrawer';
import type { ModelDrawerMode } from './ModelDrawer';
import ModelDrawer from './ModelDrawer';

const { Text } = Typography;

// Sort options exposed in the toolbar Select.
//   - family    : built-ins first then family + sort_order (server default)
//   - name-asc  : alphabetical by display_name
//   - recent    : newest updated first (covers "I just edited this, where is it")
type SortKey = 'family' | 'name-asc' | 'recent';

// Catalog of deployable model presets (P15). Family-grouped card
// layout: each family becomes a collapsible section, cards inside
// render the headline metadata + hover-revealed actions. Card click
// opens read-only detail; Edit / Duplicate / Delete are explicit
// buttons. Duplicate works on built-ins too — clones the row as a
// fresh custom entry so admins can fork a preset instead of being
// stopped at "built-in is locked".
const ModelHubPage: React.FC = () => {
  const intl = useIntl();
  const { message, modal } = App.useApp();

  // Drawer state — kept as discriminated union over `mode` so the
  // child drawer can decide create / edit / duplicate behaviors from
  // a single prop.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<ModelDrawerMode>('create');
  const [drawerSource, setDrawerSource] = useState<Model | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailModel, setDetailModel] = useState<Model | null>(null);

  // Filter / sort state.
  const [query, setQuery] = useState('');
  const [licenseFilter, setLicenseFilter] = useState<string | undefined>();
  const [runtimeFilter, setRuntimeFilter] = useState<
    ModelRuntime | undefined
  >();
  const [sortKey, setSortKey] = useState<SortKey>('family');

  // Track which sections are expanded. Default = all open so first
  // visit feels like an overview, not a maze. Stored as activeKey
  // array directly so Collapse can mutate it.
  const [openFamilies, setOpenFamilies] = useState<string[]>([
    ...MODEL_FAMILIES,
  ]);

  const { data, loading, refresh } = useRequest(listModels, {
    formatResult: (res) => res,
  });

  const rows = useMemo<Model[]>(() => data ?? [], [data]);

  // Distinct license values for the License Select. Computed from
  // current rows so we never advertise a filter that would produce
  // zero matches (built-ins + custom rows together).
  const licenseOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r.license) set.add(r.license);
    }
    return Array.from(set).sort();
  }, [rows]);

  // Filter + sort, then group by family. The grouping step preserves
  // the order produced by sort within each section, so picking
  // "name-asc" sorts inside Qwen alphabetically AND keeps Qwen above
  // DeepSeek (family order is the section order, separate axis).
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    let filtered = rows;
    if (q) {
      filtered = filtered.filter((m) => {
        const hay =
          `${m.name} ${m.display_name} ${m.hugging_face_id} ${m.description}`.toLowerCase();
        return hay.includes(q);
      });
    }
    if (licenseFilter) {
      filtered = filtered.filter((m) => m.license === licenseFilter);
    }
    if (runtimeFilter) {
      filtered = filtered.filter((m) => m.runtime === runtimeFilter);
    }

    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === 'name-asc') {
        return a.display_name.localeCompare(b.display_name);
      }
      if (sortKey === 'recent') {
        return (
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
      }
      // family default mirrors server-side order: built-ins first,
      // then sort_order within a family, then name as tiebreaker.
      if (a.is_builtin !== b.is_builtin) return a.is_builtin ? -1 : 1;
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.display_name.localeCompare(b.display_name);
    });

    // Map<family, Model[]> respecting MODEL_FAMILIES iteration order.
    const buckets = new Map<ModelFamily, Model[]>();
    for (const f of MODEL_FAMILIES) buckets.set(f, []);
    for (const m of sorted) {
      const arr = buckets.get(m.family);
      if (arr) arr.push(m);
      else buckets.set('custom', [...(buckets.get('custom') ?? []), m]);
    }
    return buckets;
  }, [rows, query, licenseFilter, runtimeFilter, sortKey]);

  const totalAfterFilter = useMemo(() => {
    let n = 0;
    for (const arr of grouped.values()) n += arr.length;
    return n;
  }, [grouped]);

  // Action handlers — drawer state mutators routed through one
  // function each so the card / detail drawer can call them.
  const openCreate = () => {
    setDrawerMode('create');
    setDrawerSource(null);
    setDrawerOpen(true);
  };
  const openEdit = (m: Model) => {
    setDrawerMode('edit');
    setDrawerSource(m);
    setDrawerOpen(true);
    setDetailOpen(false); // close detail if it was open
  };
  const openDuplicate = (m: Model) => {
    setDrawerMode('duplicate');
    setDrawerSource(m);
    setDrawerOpen(true);
    setDetailOpen(false);
  };
  const openDetail = (m: Model) => {
    setDetailModel(m);
    setDetailOpen(true);
  };
  const handleDelete = (m: Model) => {
    modal.confirm({
      title: intl.formatMessage(
        { id: 'pages.models.registry.delete.confirm' },
        { name: m.display_name },
      ),
      okType: 'danger',
      onOk: async () => {
        await deleteModel(m.id);
        message.success(
          intl.formatMessage({ id: 'pages.models.registry.delete.success' }),
        );
        refresh();
      },
    });
  };

  // Section header for one family. Renders the logo, label, and a
  // count badge; the whole header is the Collapse's clickable area.
  const renderFamilyHeader = (family: ModelFamily, count: number) => {
    const meta =
      family === 'custom'
        ? null
        : FAMILY_META[family as Exclude<ModelFamily, 'custom'>];
    const label =
      meta?.label ?? intl.formatMessage({ id: 'pages.models.registry.custom' });
    return (
      <Space size={10}>
        <Avatar
          shape="square"
          size={28}
          src={meta?.iconUrl}
          style={{
            backgroundColor: meta?.color ?? '#8c8c8c',
            color: '#fff',
            fontSize: 13,
          }}
        >
          {label.charAt(0).toUpperCase()}
        </Avatar>
        <Text strong style={{ fontSize: 15 }}>
          {label}
        </Text>
        <Badge
          count={count}
          showZero
          style={{
            backgroundColor: count > 0 ? '#f0f0f0' : '#fafafa',
            color: '#595959',
            fontSize: 11,
          }}
        />
      </Space>
    );
  };

  // Build Collapse items — only families with rows get a section.
  // Section order = MODEL_FAMILIES iteration order (curated): Qwen
  // first, custom last.
  const collapseItems = MODEL_FAMILIES.map((family) => {
    const items = grouped.get(family) ?? [];
    if (items.length === 0) return null;
    return {
      key: family,
      label: renderFamilyHeader(family, items.length),
      children: (
        <Row gutter={[16, 16]}>
          {items.map((m) => (
            <Col key={m.id} xs={24} sm={12} lg={8} xxl={6}>
              <ModelCard
                model={m}
                onView={openDetail}
                onEdit={openEdit}
                onDuplicate={openDuplicate}
                onDelete={handleDelete}
              />
            </Col>
          ))}
        </Row>
      ),
    };
  }).filter(Boolean) as {
    key: string;
    label: React.ReactNode;
    children: React.ReactNode;
  }[];

  return (
    <PageContainer
      header={{
        title: intl.formatMessage({ id: 'pages.models.registry.title' }),
        subTitle: intl.formatMessage({ id: 'pages.models.registry.subtitle' }),
      }}
    >
      {/* Toolbar — search + filters + sort + new */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder={intl.formatMessage({
            id: 'pages.models.registry.search.placeholder',
          })}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 280 }}
        />
        <Select
          allowClear
          placeholder={intl.formatMessage({
            id: 'pages.models.registry.filter.runtime',
          })}
          value={runtimeFilter}
          onChange={setRuntimeFilter}
          style={{ width: 140 }}
          options={MODEL_RUNTIMES.map((r) => ({
            label: RUNTIME_LABELS[r],
            value: r,
          }))}
        />
        <Select
          allowClear
          placeholder={intl.formatMessage({
            id: 'pages.models.registry.filter.license',
          })}
          value={licenseFilter}
          onChange={setLicenseFilter}
          style={{ width: 160 }}
          options={licenseOptions.map((l) => ({ label: l, value: l }))}
        />
        <Select
          value={sortKey}
          onChange={setSortKey}
          style={{ width: 160 }}
          options={[
            {
              label: intl.formatMessage({
                id: 'pages.models.registry.sort.family',
              }),
              value: 'family',
            },
            {
              label: intl.formatMessage({
                id: 'pages.models.registry.sort.name',
              }),
              value: 'name-asc',
            },
            {
              label: intl.formatMessage({
                id: 'pages.models.registry.sort.recent',
              }),
              value: 'recent',
            },
          ]}
        />
        <Text type="secondary">
          {intl.formatMessage(
            { id: 'pages.models.registry.toolbar.count' },
            { n: totalAfterFilter, total: rows.length },
          )}
        </Text>
        <div style={{ flex: 1 }} />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {intl.formatMessage({ id: 'pages.models.registry.new' })}
        </Button>
      </div>

      {/* Body — collapse sections OR empty state */}
      {loading && rows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Text type="secondary">
            {intl.formatMessage({ id: 'pages.common.loading' })}
          </Text>
        </div>
      ) : collapseItems.length === 0 ? (
        <Empty
          description={
            rows.length === 0
              ? intl.formatMessage({
                  id: 'pages.models.registry.empty.title',
                })
              : intl.formatMessage({
                  id: 'pages.models.registry.empty.noMatch',
                })
          }
          style={{ marginTop: 40 }}
        />
      ) : (
        <Collapse
          activeKey={openFamilies}
          onChange={(keys) =>
            setOpenFamilies(Array.isArray(keys) ? keys : [keys])
          }
          items={collapseItems}
          bordered={false}
          style={{ background: 'transparent' }}
        />
      )}

      {/* Roadmap reminder — kept from previous layout for honesty */}
      <Alert
        type="info"
        showIcon
        style={{ marginTop: 24 }}
        message={intl.formatMessage({
          id: 'pages.models.registry.roadmap.title',
        })}
        description={intl.formatMessage({
          id: 'pages.models.registry.roadmap.desc',
        })}
      />

      <ModelDetailDrawer
        open={detailOpen}
        model={detailModel}
        onClose={() => setDetailOpen(false)}
        onEdit={openEdit}
        onDuplicate={openDuplicate}
      />

      <ModelDrawer
        open={drawerOpen}
        model={drawerSource}
        mode={drawerMode}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => {
          setDrawerOpen(false);
          refresh();
        }}
      />

      {/* Section card cosmetic overrides — gives each family panel a
          rounded white card on a transparent background, matching the
          plugins page card grid feel. One-shot inline style; if it
          grows beyond two selectors move to antd-style createStyles. */}
      <style>{`
        .ant-collapse > .ant-collapse-item { margin-bottom: 12px; background: #fff; border-radius: 8px !important; }
        .ant-collapse > .ant-collapse-item > .ant-collapse-header { padding: 12px 16px !important; }
      `}</style>
    </PageContainer>
  );
};

export default ModelHubPage;
