import {
  CaretDownOutlined,
  CaretUpOutlined,
  DeleteOutlined,
  EditOutlined,
  InfoCircleOutlined,
  MinusCircleOutlined,
  PartitionOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import { useIntl, useParams, useRequest } from '@umijs/max';
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Drawer,
  Empty,
  Input,
  InputNumber,
  Result,
  Segmented,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import yaml from 'js-yaml';
import React, {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

// FlowDirectionGraph (and the G6 runtime it ships) is ~800 KB —
// lazy-load so the rest of the scheduler page stays light and the
// chart only loads once the user actually opens this page.
const SchedulerFlowDiagram = lazy(() => import('./SchedulerFlowDiagram'));

import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';
import { listClusterPlugins } from '@/services/kpilot/plugin';
import { applyManifest } from '@/services/kpilot/volcano';
import { getWorkload } from '@/services/kpilot/workload';
import {
  ACTION_NAMES,
  ACTIONS_META,
  type ArgSpec,
  ENABLE_FIELDS,
  knownPluginKeys,
  metaForAction,
  metaForPlugin,
  PLUGIN_NAMES,
  PLUGINS_META,
} from './schedulerMeta';
import { NotInstalled } from './shared/Layout';

const { Text, Paragraph } = Typography;

// TristateSegmented is the small three-pill control shared by every
// Enabled* switch and every bool plugin arg. The selected pill gets
// colored + bold text (grey 默认 / green 开 / red 关); unselected
// pills stay muted so the current selection is obvious at a glance.
// value is the raw tri-state (undefined / true / false) — same shape
// Volcano stores in YAML.
function TristateSegmented({
  value,
  onChange,
  disabled,
}: {
  value: boolean | undefined;
  onChange: (next: boolean | undefined) => void;
  disabled?: boolean;
}) {
  const cur: 'default' | 'true' | 'false' =
    value === true ? 'true' : value === false ? 'false' : 'default';
  return (
    <Segmented
      size="small"
      disabled={disabled}
      value={cur}
      onChange={(v) =>
        onChange(v === 'default' ? undefined : v === 'true')
      }
      options={[
        { label: tristateLabel('默认', cur === 'default', 'neutral'), value: 'default' },
        { label: tristateLabel('开', cur === 'true', 'success'), value: 'true' },
        { label: tristateLabel('关', cur === 'false', 'error'), value: 'false' },
      ]}
    />
  );
}

function tristateLabel(
  text: string,
  selected: boolean,
  variant: 'neutral' | 'success' | 'error',
) {
  // Unselected: muted text, normal weight. Selected: variant-tinted
  // text + bold. Combined with antd's own selected-pill background,
  // the active choice is unambiguous in both light and dark themes.
  const selectedColor =
    variant === 'success'
      ? 'var(--ant-color-success)'
      : variant === 'error'
        ? 'var(--ant-color-error)'
        : 'var(--ant-color-text)';
  return (
    <span
      style={{
        color: selected ? selectedColor : 'var(--ant-color-text-tertiary)',
        fontWeight: selected ? 600 : 400,
      }}
    >
      {text}
    </span>
  );
}

// Pre-computed Select options arrays. Both depend only on the
// module-level ACTION_NAMES / PLUGIN_NAMES from schedulerMeta, so
// hoisting them out avoids rebuilding the labels (incl. fresh JSX
// for ActionOption / PluginOption) on every render of ActionsCard /
// TierBody. The list of available actions and plugins is fixed at
// build time.
const ACTION_OPTIONS = ACTION_NAMES.map((n) => ({
  label: <ActionOption name={n} />,
  value: n,
}));
const PLUGIN_OPTIONS = PLUGIN_NAMES.map((n) => ({
  label: <PluginOption name={n} />,
  value: n,
}));

// ─── Types — mirror volcano-scheduler.conf YAML shape ──────────────────

interface SchedulerConf {
  actions?: string;
  tiers?: TierEntry[];
  configurations?: ConfigurationEntry[];
  metrics?: Record<string, string>;
  // Preserve anything else so users with unusual setups don't lose
  // fields when saving from the form view.
  [k: string]: unknown;
}

interface TierEntry {
  plugins?: PluginEntry[];
}

interface PluginEntry {
  name?: string;
  // The 25 generic Enabled* booleans live at this level (NOT under
  // arguments). They're *bool in Go, so we preserve undefined ≠ false.
  // Plugin-specific args live under .arguments map. Other top-level
  // keys (unknown to us) are preserved as-is.
  arguments?: Record<string, unknown>;
  [k: string]: unknown;
}

interface ConfigurationEntry {
  name?: string;
  arguments?: Record<string, unknown>;
}

// ─── Main component ────────────────────────────────────────────────────

// VolcanoSchedulerPage renders the scheduler's runtime config from
// volcano-scheduler-configmap with two views (form / YAML), edit
// mode, and SSA save. The form view auto-generates typed inputs per
// the schema in schedulerMeta.ts, including all 25 Enabled* toggles
// and per-plugin typed arguments.
export default function VolcanoSchedulerPage() {
  const intl = useIntl();
  const { message } = App.useApp();
  const { id: clusterId } = useParams<{ id: string }>();

  const plugins = useRequest(() => listClusterPlugins(clusterId!), {
    formatResult: (res) => res,
    ready: !!clusterId,
    refreshDeps: [clusterId],
  });
  const volcanoEntry = useMemo(() => {
    return plugins.data?.find((p) => p.plugin.name === 'volcano');
  }, [plugins.data]);
  const volcanoNs = volcanoEntry?.plugin.default_release_namespace ?? null;
  const volcanoReady = volcanoEntry?.phase === 'Running';

  const cm = useRequest(
    () =>
      getWorkload(
        clusterId!,
        'configmaps',
        'volcano-scheduler-configmap',
        volcanoNs!,
      ),
    {
      formatResult: (res) => res,
      ready: !!clusterId && !!volcanoNs && volcanoReady,
      refreshDeps: [clusterId, volcanoNs, volcanoReady],
    },
  );

  const [view, setView] = useState<'form' | 'yaml'>('form');
  // Flow diagram opens in a Drawer on demand: defers the @antv/g6
  // import (~800 KB) until the user actually wants to see it, and
  // gives the diagram its own scroll context so wheel-zoom doesn't
  // hijack the page.
  const [flowOpen, setFlowOpen] = useState(false);
  const [draft, setDraft] = useState<SchedulerConf>({
    actions: '',
    tiers: [],
  });
  const [yamlText, setYamlText] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!cm.data) return;
    const obj: any = cm.data;
    const text =
      obj?.data?.['volcano-scheduler.conf'] ??
      obj?.data?.['volcano-scheduler.yaml'] ??
      '';
    let parsed: SchedulerConf = { actions: '', tiers: [] };
    if (typeof text === 'string' && text.trim()) {
      try {
        parsed = (yaml.load(text) as SchedulerConf) ?? parsed;
      } catch {
        // Bad config in cluster; surface as parse error in form view
        // by leaving draft empty. yamlText still gets raw text so
        // the user can fix it from the YAML tab.
      }
    }
    setDraft(parsed);
    setYamlText(typeof text === 'string' ? text : '');
    setYamlError(null);
    setView('form');
    setEditing(false);
  }, [cm.data]);

  const cancelEdit = () => {
    const obj: any = cm.data;
    const text =
      obj?.data?.['volcano-scheduler.conf'] ??
      obj?.data?.['volcano-scheduler.yaml'] ??
      '';
    let parsed: SchedulerConf = { actions: '', tiers: [] };
    if (typeof text === 'string' && text.trim()) {
      try {
        parsed = (yaml.load(text) as SchedulerConf) ?? parsed;
      } catch {
        // ignore — same as initial load
      }
    }
    setDraft(parsed);
    setYamlText(typeof text === 'string' ? text : '');
    setYamlError(null);
    setEditing(false);
  };

  const handleSwitchView = (next: string) => {
    if (next === view) return;
    if (next === 'yaml') {
      try {
        setYamlText(yaml.dump(stripEmpty(draft)));
        setYamlError(null);
        setView('yaml');
      } catch (e: any) {
        setYamlError(String(e?.message ?? e));
      }
    } else {
      try {
        const parsed = (yaml.load(yamlText) as SchedulerConf) ?? {
          actions: '',
          tiers: [],
        };
        setDraft(parsed);
        setYamlError(null);
        setView('form');
      } catch (e: any) {
        setYamlError(String(e?.message ?? e));
      }
    }
  };

  const save = async () => {
    if (!cm.data || !volcanoNs) return;
    const text = view === 'yaml' ? yamlText : yaml.dump(stripEmpty(draft));
    try {
      yaml.load(text);
    } catch (e: any) {
      message.error(`YAML invalid: ${e?.message ?? e}`);
      return;
    }
    setSaving(true);
    try {
      const cur: any = cm.data;
      const manifest = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: 'volcano-scheduler-configmap',
          namespace: volcanoNs,
        },
        data: {
          ...(cur?.data ?? {}),
          'volcano-scheduler.conf': text,
        },
      };
      const res = await applyManifest(clusterId!, manifest);
      const fail = res?.results?.find((r) => !r.success);
      if (fail) {
        message.error(fail.error ?? 'apply failed');
        return;
      }
      message.success(
        intl.formatMessage({ id: 'pages.compute.scheduler.saved' }),
      );
      setEditing(false);
      cm.refresh();
    } catch {
      // global toast
    } finally {
      setSaving(false);
    }
  };

  if ((plugins.loading && !plugins.data) || (cm.loading && !cm.data)) {
    return (
      <div style={{ padding: 24 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (plugins.data && !volcanoReady) {
    return clusterId ? <NotInstalled clusterId={clusterId} /> : null;
  }

  if (cm.error) {
    return (
      <div style={{ padding: 24 }}>
        <Result
          status="info"
          title={intl.formatMessage({
            id: 'pages.compute.scheduler.notFound.title',
          })}
          subTitle={intl.formatMessage(
            { id: 'pages.compute.scheduler.notFound.subtitle' },
            { ns: volcanoNs ?? '?' },
          )}
          extra={
            <Button onClick={() => cm.refresh()} icon={<ReloadOutlined />}>
              {intl.formatMessage({ id: 'pages.workloads.refresh.retry' })}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <Space style={{ marginBottom: 8 }} align="center" wrap>
        <Text strong style={{ fontSize: 16 }}>
          {intl.formatMessage({ id: 'pages.compute.scheduler.title' })}
        </Text>
        <Tag>{volcanoNs}/volcano-scheduler-configmap</Tag>
        <Button
          size="small"
          icon={<PartitionOutlined />}
          onClick={() => setFlowOpen(true)}
        >
          {intl.formatMessage({ id: 'pages.compute.scheduler.flow.button' })}
        </Button>
      </Space>

      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {intl.formatMessage({ id: 'pages.compute.scheduler.intro' })}
      </Paragraph>

      <HelpSection />

      <Drawer
        title={intl.formatMessage({ id: 'pages.compute.scheduler.flow.title' })}
        open={flowOpen}
        onClose={() => setFlowOpen(false)}
        // Two-thirds of the viewport — large enough to lay out a
        // wide pipeline (enqueue → allocate → preempt → reclaim →
        // backfill → shuffle = 6 actions + 2 endpoints) without
        // covering the form behind it.
        width="66.66vw"
        // Each open mounts a fresh diagram so it re-derives from the
        // current draft state (which may have changed between opens).
        destroyOnClose
      >
        <Suspense
          fallback={
            <div
              style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Spin />
            </div>
          }
        >
          {flowOpen && <SchedulerFlowDiagram draft={draft} />}
        </Suspense>
      </Drawer>

      <Tabs
        activeKey={view}
        onChange={handleSwitchView}
        size="small"
        tabBarExtraContent={
          editing ? (
            <Space>
              <Button size="small" onClick={cancelEdit} disabled={saving}>
                {intl.formatMessage({ id: 'pages.workloads.cancel' })}
              </Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                size="small"
                loading={saving}
                onClick={save}
              >
                {intl.formatMessage({ id: 'pages.compute.scheduler.save' })}
              </Button>
            </Space>
          ) : (
            <Space>
              <Button
                icon={<ReloadOutlined />}
                size="small"
                onClick={() => cm.refresh()}
              >
                {intl.formatMessage({ id: 'pages.workloads.refresh' })}
              </Button>
              <Button
                type="primary"
                icon={<EditOutlined />}
                size="small"
                onClick={() => setEditing(true)}
              >
                {intl.formatMessage({ id: 'pages.workloads.edit' })}
              </Button>
            </Space>
          )
        }
        items={[
          {
            key: 'form',
            label: intl.formatMessage({ id: 'pages.compute.form.tab.form' }),
          },
          {
            key: 'yaml',
            label: intl.formatMessage({ id: 'pages.compute.form.tab.yaml' }),
          },
        ]}
      />

      {yamlError && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setYamlError(null)}
          style={{ marginBottom: 12 }}
          message={intl.formatMessage({ id: 'pages.compute.form.yamlError' })}
          description={yamlError}
        />
      )}

      {view === 'yaml' ? (
        <div
          style={{
            border: '1px solid var(--ant-color-border)',
            borderRadius: 4,
          }}
        >
          <YamlEditor
            value={yamlText}
            onChange={setYamlText}
            readOnly={!editing}
          />
        </div>
      ) : (
        <FormView draft={draft} onChange={setDraft} editable={editing} />
      )}
    </div>
  );
}

// ─── Form view shell ───────────────────────────────────────────────────

function FormView({
  draft,
  onChange,
  editable,
}: {
  draft: SchedulerConf;
  onChange: (next: SchedulerConf) => void;
  editable: boolean;
}) {
  const intl = useIntl();
  const actions = useMemo(
    () =>
      (draft.actions ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    [draft.actions],
  );
  const tiers = draft.tiers ?? [];

  const setActions = (next: string[]) =>
    onChange({ ...draft, actions: next.join(', ') });
  const setTiers = (next: TierEntry[]) => onChange({ ...draft, tiers: next });
  const setConfigurations = (next: ConfigurationEntry[]) =>
    onChange({ ...draft, configurations: next });
  const setMetrics = (next: Record<string, string> | undefined) =>
    onChange({ ...draft, metrics: next });

  return (
    <>
      <ActionsCard
        actions={actions}
        onChange={setActions}
        configurations={draft.configurations ?? []}
        onChangeConfigurations={setConfigurations}
        editable={editable}
      />
      <TiersCard
        tiers={tiers}
        onChange={setTiers}
        editable={editable}
        intl={intl}
      />
      <MetricsCard
        metrics={draft.metrics}
        onChange={setMetrics}
        editable={editable}
      />
    </>
  );
}

// ─── Actions card (multi-select + per-action arg panels) ──────────────

function ActionsCard({
  actions,
  onChange,
  configurations,
  onChangeConfigurations,
  editable,
}: {
  actions: string[];
  onChange: (next: string[]) => void;
  configurations: ConfigurationEntry[];
  onChangeConfigurations: (next: ConfigurationEntry[]) => void;
  editable: boolean;
}) {
  const intl = useIntl();

  // Selected actions that actually declare arguments in our schema;
  // these get rendered as expandable arg-editor panels below the
  // multi-select. enqueue / shuffle have no args, so they don't get
  // a panel even when selected. Order follows the user's selection
  // order in the actions list, so the panels match what the user
  // sees in the YAML.
  const eligibleActions = actions.filter((a) => ACTIONS_META[a]?.args?.length);

  const byName = new Map<string, ConfigurationEntry>(
    configurations.filter((c) => c.name).map((c) => [c.name!, c]),
  );

  const setEntry = (name: string, nextArgs: Record<string, unknown>) => {
    const others = configurations.filter((c) => c.name !== name);
    if (Object.keys(nextArgs).length === 0) {
      onChangeConfigurations(others);
    } else {
      onChangeConfigurations([...others, { name, arguments: nextArgs }]);
    }
  };

  return (
    <Card
      size="small"
      title={
        <Space>
          <span>
            {intl.formatMessage({ id: 'pages.compute.scheduler.actions' })}
          </span>
          <Tooltip
            title={intl.formatMessage({
              id: 'pages.compute.scheduler.actions.tip',
            })}
          >
            <InfoCircleOutlined style={{ color: '#999' }} />
          </Tooltip>
        </Space>
      }
      style={{ marginBottom: 12 }}
    >
      <Select
        mode="multiple"
        value={actions}
        onChange={onChange}
        disabled={!editable}
        style={{ width: '100%' }}
        placeholder={intl.formatMessage({
          id: 'pages.compute.scheduler.actions.placeholder',
        })}
        options={ACTION_OPTIONS}
        optionLabelProp="value"
        tagRender={(props) => (
          <Tooltip title={metaForAction(props.value as string).desc}>
            <Tag
              color="blue"
              closable={editable && props.closable}
              onClose={props.onClose}
              style={{ marginInlineEnd: 6, marginBlock: 2 }}
            >
              {props.value}
            </Tag>
          </Tooltip>
        )}
      />

      {/* Per-action arg panels appear right under the multi-select.
          Volcano stores these in a separate `configurations: []` top-
          level field — different YAML structure, same conceptual unit
          ("for this stage, here are its params"), so rendering them
          together avoids forcing the user to scan two cards. Only
          actions with args in our schema get a panel; selecting
          enqueue / shuffle won't add one. */}
      {eligibleActions.length > 0 && (
        <Collapse
          size="small"
          style={{ marginTop: 12 }}
          items={eligibleActions.map((a) => {
            const meta = metaForAction(a);
            const entry = byName.get(a) ?? { name: a, arguments: {} };
            const args = entry.arguments ?? {};
            return {
              key: a,
              label: (
                <Space>
                  <Tag color="blue">{a}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {intl.formatMessage({
                      id: 'pages.compute.scheduler.action.params',
                    })}
                  </Text>
                </Space>
              ),
              children: (
                <ArgsFormSection
                  specs={meta.args ?? []}
                  values={args}
                  onChange={(next) => setEntry(a, next)}
                  editable={editable}
                />
              ),
            };
          })}
        />
      )}
    </Card>
  );
}

// ─── Tiers ─────────────────────────────────────────────────────────────

function TiersCard({
  tiers,
  onChange,
  editable,
  intl,
}: {
  tiers: TierEntry[];
  onChange: (next: TierEntry[]) => void;
  editable: boolean;
  intl: ReturnType<typeof useIntl>;
}) {
  const addTier = () => onChange([...tiers, { plugins: [] }]);
  const removeTier = (i: number) =>
    onChange(tiers.filter((_, idx) => idx !== i));
  const setTierPlugins = (i: number, plugins: PluginEntry[]) =>
    onChange(tiers.map((t, idx) => (idx === i ? { plugins } : t)));

  return (
    <Card
      size="small"
      title={
        <Space>
          <span>
            {intl.formatMessage({ id: 'pages.compute.scheduler.tiers' })}
          </span>
          <Tooltip
            title={intl.formatMessage({
              id: 'pages.compute.scheduler.tiers.tip',
            })}
          >
            <InfoCircleOutlined style={{ color: '#999' }} />
          </Tooltip>
        </Space>
      }
      extra={
        editable ? (
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            onClick={addTier}
          >
            {intl.formatMessage({ id: 'pages.compute.scheduler.addTier' })}
          </Button>
        ) : null
      }
      style={{ marginBottom: 12 }}
    >
      {tiers.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={intl.formatMessage({
            id: 'pages.compute.scheduler.noTiers',
          })}
        />
      ) : (
        // Each tier is its own collapse panel, default collapsed so
        // the page lands as a compact overview. Users click the
        // tier header to expand and edit its plugins.
        <Collapse
          size="small"
          items={tiers.map((tier, i) => ({
            key: String(i),
            label: (
              <Space size={8}>
                <Text strong>
                  {intl.formatMessage(
                    { id: 'pages.compute.scheduler.tier' },
                    { n: i + 1 },
                  )}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {intl.formatMessage(
                    { id: 'pages.compute.scheduler.tier.pluginCount' },
                    { n: (tier.plugins ?? []).length },
                  )}
                </Text>
                {(tier.plugins ?? []).slice(0, 6).map((p, idx) => (
                  <Tag
                    color="green"
                    key={`${p.name ?? '_'}-${idx}`}
                    style={{ marginInlineEnd: 0 }}
                  >
                    {p.name ?? '(empty)'}
                  </Tag>
                ))}
                {(tier.plugins?.length ?? 0) > 6 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    +{(tier.plugins?.length ?? 0) - 6}
                  </Text>
                )}
              </Space>
            ),
            extra: editable ? (
              <Button
                type="text"
                size="small"
                danger
                icon={<MinusCircleOutlined />}
                onClick={(e) => {
                  // Stop the click from toggling the collapse panel.
                  e.stopPropagation();
                  removeTier(i);
                }}
              />
            ) : null,
            children: (
              <TierBody
                plugins={tier.plugins ?? []}
                onChange={(next) => setTierPlugins(i, next)}
                editable={editable}
              />
            ),
          }))}
        />
      )}
    </Card>
  );
}

// TierBody is the expanded content of one tier panel. Stripped of
// the outer Card chrome (the parent Collapse renders the header /
// remove button) — just renders the plugin list + add picker.
function TierBody({
  plugins,
  onChange,
  editable,
}: {
  plugins: PluginEntry[];
  onChange: (next: PluginEntry[]) => void;
  editable: boolean;
}) {
  const intl = useIntl();
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState<string | undefined>(undefined);

  const updatePlugin = (i: number, next: PluginEntry) =>
    onChange(plugins.map((p, idx) => (idx === i ? next : p)));
  const removePlugin = (i: number) =>
    onChange(plugins.filter((_, idx) => idx !== i));
  const movePlugin = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= plugins.length) return;
    const next = [...plugins];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const addPlugin = () => {
    if (!addName) return;
    onChange([...plugins, { name: addName }]);
    setAddName(undefined);
    setAddOpen(false);
  };

  const usedNames = useMemo(
    () => new Set(plugins.map((p) => p.name).filter(Boolean)),
    [plugins],
  );
  // Filter the precomputed PLUGIN_OPTIONS rather than rebuilding the
  // JSX-labeled array from scratch on every render of TierBody.
  const pluginOptions = useMemo(
    () => PLUGIN_OPTIONS.filter((o) => !usedNames.has(o.value)),
    [usedNames],
  );

  return (
    <>
      {plugins.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={intl.formatMessage({
            id: 'pages.compute.scheduler.noPluginsInTier',
          })}
        />
      ) : (
        plugins.map((p, i) => (
          <PluginCard
            key={`${p.name ?? '_'}-${i}`}
            entry={p}
            onChange={(next) => updatePlugin(i, next)}
            onMoveUp={i > 0 ? () => movePlugin(i, -1) : undefined}
            onMoveDown={
              i < plugins.length - 1 ? () => movePlugin(i, 1) : undefined
            }
            onRemove={() => removePlugin(i)}
            editable={editable}
          />
        ))
      )}

      {editable && (
        <div style={{ marginTop: 8 }}>
          {addOpen ? (
            <Space.Compact style={{ width: '100%' }}>
              <Select
                showSearch
                placeholder={intl.formatMessage({
                  id: 'pages.compute.scheduler.plugins.placeholder',
                })}
                value={addName}
                onChange={setAddName}
                style={{ width: '100%' }}
                options={pluginOptions}
                optionLabelProp="value"
              />
              <Button type="primary" onClick={addPlugin} disabled={!addName}>
                {intl.formatMessage({ id: 'pages.compute.scheduler.add' })}
              </Button>
              <Button
                onClick={() => {
                  setAddOpen(false);
                  setAddName(undefined);
                }}
              >
                {intl.formatMessage({ id: 'pages.workloads.cancel' })}
              </Button>
            </Space.Compact>
          ) : (
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={() => setAddOpen(true)}
              block
            >
              {intl.formatMessage({ id: 'pages.compute.scheduler.addPlugin' })}
            </Button>
          )}
        </div>
      )}
    </>
  );
}

// ─── Plugin card ───────────────────────────────────────────────────────

function PluginCard({
  entry,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
  editable,
}: {
  entry: PluginEntry;
  onChange: (next: PluginEntry) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove: () => void;
  editable: boolean;
}) {
  const intl = useIntl();
  const name = entry.name ?? '';
  const meta = metaForPlugin(name);
  const args = (entry.arguments ?? {}) as Record<string, unknown>;

  const setArgs = (next: Record<string, unknown>) => {
    if (Object.keys(next).length === 0) {
      const { arguments: _omit, ...rest } = entry;
      onChange(rest);
    } else {
      onChange({ ...entry, arguments: next });
    }
  };

  const setEnable = (key: string, value: boolean | undefined) => {
    const next = { ...entry };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  // Bucket the top-level keys of the entry: known enables vs unknown
  // extras. We render unknown extras as a small read-only list with a
  // hint so they survive round-trip without surprising the user.
  // The "known" set depends only on the plugin name (stable for the
  // card's lifetime); cache it so we don't rebuild a 25+-entry Set
  // on every parent state change.
  const known = useMemo(() => knownPluginKeys(name), [name]);
  const unknownTopLevel = useMemo<[string, unknown][]>(
    () => Object.entries(entry).filter(([k]) => !known.has(k)),
    [entry, known],
  );
  const setEnabledCount = useMemo(
    () =>
      ENABLE_FIELDS.filter((e) => entry[e.key] !== undefined).length,
    [entry],
  );
  const setArgsCount = useMemo(
    () => meta.args?.filter((a) => args[a.key] !== undefined).length ?? 0,
    [meta.args, args],
  );

  return (
    <Card
      size="small"
      style={{
        marginBottom: 8,
        background: 'var(--ant-color-fill-quaternary)',
      }}
      styles={{ body: { padding: '8px 12px' } }}
    >
      <Space
        style={{ width: '100%', justifyContent: 'space-between' }}
        align="center"
      >
        <Space size={8} align="center">
          <Tag color="green" style={{ marginInlineEnd: 0 }}>
            {name}
          </Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {meta.desc}
          </Text>
        </Space>
        {editable && (
          <Space size={0}>
            <Button
              type="text"
              size="small"
              icon={<CaretUpOutlined />}
              disabled={!onMoveUp}
              onClick={onMoveUp}
            />
            <Button
              type="text"
              size="small"
              icon={<CaretDownOutlined />}
              disabled={!onMoveDown}
              onClick={onMoveDown}
            />
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={onRemove}
            />
          </Space>
        )}
      </Space>

      <Collapse
        size="small"
        ghost
        style={{ marginTop: 4 }}
        items={[
          ...(meta.args && meta.args.length > 0
            ? [
                {
                  key: 'args',
                  label: (
                    <Space size={6}>
                      <Text style={{ fontSize: 13 }}>
                        {intl.formatMessage({
                          id: 'pages.compute.scheduler.plugin.args',
                        })}
                      </Text>
                      {setArgsCount > 0 && (
                        <Tag color="blue">{setArgsCount}</Tag>
                      )}
                    </Space>
                  ),
                  children: (
                    <ArgsFormSection
                      specs={meta.args}
                      values={args}
                      onChange={setArgs}
                      editable={editable}
                    />
                  ),
                },
              ]
            : []),
          {
            key: 'enables',
            label: (
              <Space size={6}>
                <Text style={{ fontSize: 13 }}>
                  {intl.formatMessage(
                    { id: 'pages.compute.scheduler.plugin.enables' },
                    { n: meta.callbacks?.length ?? ENABLE_FIELDS.length },
                  )}
                </Text>
                {setEnabledCount > 0 && (
                  <Tag color="orange">{setEnabledCount}</Tag>
                )}
              </Space>
            ),
            children: (
              <EnableSwitchGrid
                entry={entry}
                pluginName={name}
                onChange={setEnable}
                editable={editable}
              />
            ),
          },
          ...(unknownTopLevel.length > 0
            ? [
                {
                  key: 'extras',
                  label: (
                    <Space size={6}>
                      <Text style={{ fontSize: 13 }}>
                        {intl.formatMessage({
                          id: 'pages.compute.scheduler.plugin.extras',
                        })}
                      </Text>
                      <Tag>{unknownTopLevel.length}</Tag>
                    </Space>
                  ),
                  children: (
                    <Alert
                      type="info"
                      showIcon
                      message={intl.formatMessage({
                        id: 'pages.compute.scheduler.plugin.extras.hint',
                      })}
                      description={
                        <pre style={{ margin: 0, fontSize: 12 }}>
                          {yaml.dump(Object.fromEntries(unknownTopLevel))}
                        </pre>
                      }
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
    </Card>
  );
}

// ─── Enable switch grid ────────────────────────────────────────────────

function EnableSwitchGrid({
  entry,
  pluginName,
  onChange,
  editable,
}: {
  entry: PluginEntry;
  pluginName: string;
  onChange: (key: string, value: boolean | undefined) => void;
  editable: boolean;
}) {
  const intl = useIntl();
  const meta = metaForPlugin(pluginName);
  // visibleFields depends only on the plugin's callback list (stable
  // for the plugin's lifetime). Memoized so a single switch toggle
  // doesn't refilter 25 ENABLE_FIELDS twice on every render. setNoOp
  // needs to react to entry changes (a key the user just unset is no
  // longer a no-op), so it depends on entry — but only entry's
  // unknown-callback keys really matter, so over-firing here is
  // bounded.
  const visibleFields = useMemo(
    () =>
      meta.callbacks
        ? ENABLE_FIELDS.filter((f) => meta.callbacks!.includes(f.key))
        : ENABLE_FIELDS,
    [meta.callbacks],
  );
  const setNoOpFields = useMemo(
    () =>
      meta.callbacks
        ? ENABLE_FIELDS.filter(
            (f) =>
              !meta.callbacks!.includes(f.key) && entry[f.key] !== undefined,
          )
        : [],
    [meta.callbacks, entry],
  );
  const fields = useMemo(
    () => [...visibleFields, ...setNoOpFields],
    [visibleFields, setNoOpFields],
  );

  if (fields.length === 0) {
    return (
      <Alert
        type="info"
        showIcon
        message={intl.formatMessage({
          id: 'pages.compute.scheduler.plugin.enables.none',
        })}
      />
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: 8,
      }}
    >
      {fields.map((f) => {
        const raw = entry[f.key];
        const value: boolean | undefined =
          raw === true ? true : raw === false ? false : undefined;
        return (
          <Card
            key={f.key}
            size="small"
            styles={{ body: { padding: '8px 10px' } }}
          >
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              <span style={{ fontWeight: 500 }}>{f.label}</span>
              <code
                style={{
                  fontSize: 11,
                  color: 'var(--ant-color-text-tertiary)',
                  marginInlineStart: 8,
                }}
              >
                {f.key}
              </code>
            </div>
            <div style={{ marginBottom: 6 }}>
              <TristateSegmented
                disabled={!editable}
                value={value}
                onChange={(next) => onChange(f.key, next)}
              />
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {f.desc}
            </Text>
          </Card>
        );
      })}
    </div>
  );
}

// ─── Generic ArgSpec form ──────────────────────────────────────────────

function ArgsFormSection({
  specs,
  values,
  onChange,
  editable,
}: {
  specs: ArgSpec[];
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  editable: boolean;
}) {
  const setOne = (key: string, raw: unknown) => {
    const next = { ...values };
    if (raw === undefined || raw === null || raw === '') delete next[key];
    else next[key] = raw;
    onChange(next);
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: 12,
      }}
    >
      {specs.map((s) => (
        <ArgField
          key={s.key}
          spec={s}
          value={values[s.key]}
          onChange={(v) => setOne(s.key, v)}
          editable={editable}
        />
      ))}
    </div>
  );
}

function ArgField({
  spec,
  value,
  onChange,
  editable,
}: {
  spec: ArgSpec;
  value: unknown;
  onChange: (next: unknown) => void;
  editable: boolean;
}) {
  let input: React.ReactNode;
  switch (spec.type) {
    case 'int':
    case 'float':
      input = (
        <InputNumber
          disabled={!editable}
          value={typeof value === 'number' ? value : undefined}
          onChange={(n) => onChange(n)}
          placeholder={
            spec.default !== undefined ? String(spec.default) : undefined
          }
          min={spec.min}
          max={spec.max}
          step={spec.type === 'float' ? 0.1 : 1}
          style={{ width: '100%' }}
        />
      );
      break;
    case 'bool': {
      const cur: boolean | undefined =
        value === true ? true : value === false ? false : undefined;
      input = (
        <TristateSegmented
          disabled={!editable}
          value={cur}
          onChange={onChange}
        />
      );
      break;
    }
    case 'object':
      input = (
        <ObjectInput
          value={value}
          onChange={onChange}
          editable={editable}
          placeholder={
            spec.default !== undefined ? String(spec.default) : undefined
          }
        />
      );
      break;
    default:
      input = (
        <Input
          disabled={!editable}
          value={typeof value === 'string' ? value : undefined}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            spec.default !== undefined ? String(spec.default) : undefined
          }
        />
      );
      break;
  }
  return (
    <div>
      <div style={{ marginBottom: 6, fontSize: 13 }}>
        <span style={{ fontWeight: 500 }}>{spec.label}</span>
        <Text
          type="secondary"
          style={{
            fontSize: 11,
            marginInlineStart: 8,
            fontFamily: 'monospace',
          }}
        >
          {spec.key}
        </Text>
      </div>
      <div style={{ marginBottom: 6 }}>{input}</div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {spec.desc}
      </Text>
    </div>
  );
}

// ObjectInput is a small YAML/JSON sub-editor for complex args
// (thresholds, strategies, resources). The user types YAML; on blur
// we parse and store the value. Round-trip preserves the raw text
// when parsing fails so users can fix typos without losing input.
function ObjectInput({
  value,
  onChange,
  editable,
  placeholder,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  editable: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState<string>(() => {
    if (value === undefined) return '';
    try {
      return yaml.dump(value).trimEnd();
    } catch {
      return '';
    }
  });
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Re-sync if upstream value changes (e.g. YAML tab edit + switch
    // back). Don't overwrite while the user is mid-edit (text would
    // jump under them); only re-seed when the parsed shapes differ.
    try {
      const parsed = text.trim() ? yaml.load(text) : undefined;
      if (JSON.stringify(parsed) !== JSON.stringify(value)) {
        setText(value === undefined ? '' : yaml.dump(value).trimEnd());
        setErr(null);
      }
    } catch {
      // keep current text
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div>
      <Input.TextArea
        disabled={!editable}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!text.trim()) {
            onChange(undefined);
            setErr(null);
            return;
          }
          try {
            const parsed = yaml.load(text);
            onChange(parsed);
            setErr(null);
          } catch (e: any) {
            setErr(String(e?.message ?? e));
          }
        }}
        placeholder={placeholder}
        autoSize={{ minRows: 3, maxRows: 10 }}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
      {err && (
        <Text type="danger" style={{ fontSize: 12 }}>
          {err}
        </Text>
      )}
    </div>
  );
}

// ─── Metrics card ──────────────────────────────────────────────────────

function MetricsCard({
  metrics,
  onChange,
  editable,
}: {
  metrics?: Record<string, string>;
  onChange: (next: Record<string, string> | undefined) => void;
  editable: boolean;
}) {
  const intl = useIntl();

  // Local row list keeps the user's in-progress empty rows alive
  // across renders. If we derived rows from `metrics` every render,
  // a freshly-added `['', '']` would be filtered out by commit's
  // empty-key guard before the parent state round-tripped back —
  // the Add button would visibly do nothing. Re-seed from upstream
  // only when the parent's metrics actually differs from our
  // non-empty rows (covers YAML-tab edits / cancel / fresh fetch).
  const [rows, setRows] = useState<[string, string][]>(() =>
    Object.entries(metrics ?? {}),
  );
  // Track what we last committed upstream so we can detect "real"
  // external changes (parent metrics differs from what our own
  // commit() emitted) and re-seed only then. Pure-ref tracking is
  // cheaper than JSON.stringify-on-every-render, which was running
  // even when the user wasn't editing.
  const lastEmittedRef = useRef<string>(JSON.stringify(metrics ?? {}));
  useEffect(() => {
    const upstreamJSON = JSON.stringify(metrics ?? {});
    if (upstreamJSON !== lastEmittedRef.current) {
      setRows(Object.entries(metrics ?? {}));
      lastEmittedRef.current = upstreamJSON;
    }
  }, [metrics]);

  const commit = (next: [string, string][]) => {
    setRows(next);
    const obj: Record<string, string> = {};
    for (const [k, v] of next) if (k) obj[k] = v;
    const emit = Object.keys(obj).length === 0 ? undefined : obj;
    // Stamp lastEmittedRef before calling onChange so the upstream
    // effect doesn't see this round-trip as "external" and clobber
    // the in-progress row list (would wipe the empty row the user
    // just added).
    lastEmittedRef.current = JSON.stringify(emit ?? {});
    onChange(emit);
  };

  const setEntry = (i: number, k: string, v: string) => {
    const next = [...rows];
    next[i] = [k, v];
    commit(next);
  };
  const removeEntry = (i: number) =>
    commit(rows.filter((_, idx) => idx !== i));
  const addEntry = () => commit([...rows, ['', '']]);

  return (
    <Card
      size="small"
      title={
        <Space>
          <span>
            {intl.formatMessage({ id: 'pages.compute.scheduler.metrics' })}
          </span>
          <Tooltip
            title={intl.formatMessage({
              id: 'pages.compute.scheduler.metrics.tip',
            })}
          >
            <InfoCircleOutlined style={{ color: '#999' }} />
          </Tooltip>
        </Space>
      }
      extra={
        editable ? (
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            onClick={addEntry}
          >
            {intl.formatMessage({ id: 'pages.compute.scheduler.metrics.add' })}
          </Button>
        ) : null
      }
      style={{ marginBottom: 12 }}
    >
      {rows.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={intl.formatMessage({
            id: 'pages.compute.scheduler.metrics.empty',
          })}
        />
      ) : (
        rows.map(([k, v], i) => (
          <Space.Compact key={i} style={{ width: '100%', marginBottom: 6 }}>
            <Input
              placeholder="key"
              disabled={!editable}
              value={k}
              onChange={(e) => setEntry(i, e.target.value, v)}
              style={{ width: '40%' }}
            />
            <Input
              placeholder="value"
              disabled={!editable}
              value={v}
              onChange={(e) => setEntry(i, k, e.target.value)}
            />
            {editable && (
              <Button
                danger
                icon={<MinusCircleOutlined />}
                onClick={() => removeEntry(i)}
              />
            )}
          </Space.Compact>
        ))
      )}
    </Card>
  );
}

// ─── Help section ──────────────────────────────────────────────────────

function HelpSection() {
  const intl = useIntl();
  return (
    <Collapse
      style={{ marginBottom: 16 }}
      items={[
        {
          key: 'actions',
          label: intl.formatMessage({
            id: 'pages.compute.scheduler.help.actions',
          }),
          children: (
            <ReferenceList
              items={Object.entries(ACTIONS_META).map(([k, v]) => ({ k, v }))}
            />
          ),
        },
        {
          key: 'plugins',
          label: intl.formatMessage({
            id: 'pages.compute.scheduler.help.plugins',
          }),
          children: (
            <ReferenceList
              items={Object.entries(PLUGINS_META).map(([k, v]) => ({ k, v }))}
            />
          ),
        },
      ]}
    />
  );
}

function ReferenceList({
  items,
}: {
  items: { k: string; v: { label: string; desc: string } }[];
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map(({ k, v }) => (
        <div key={k}>
          <Tag
            color="default"
            style={{ fontFamily: 'monospace', marginInlineEnd: 8 }}
          >
            {v.label}
          </Tag>
          <span style={{ fontSize: 13 }}>{v.desc}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Common option renderers ──────────────────────────────────────────

function ActionOption({ name }: { name: string }) {
  const m = metaForAction(name);
  return (
    <div style={{ paddingBlock: 2 }}>
      <div style={{ fontWeight: 500 }}>{m.label}</div>
      <div style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary)' }}>
        {m.desc}
      </div>
    </div>
  );
}

function PluginOption({ name }: { name: string }) {
  const m = metaForPlugin(name);
  return (
    <div style={{ paddingBlock: 2 }}>
      <div style={{ fontWeight: 500 }}>{m.label}</div>
      <div style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary)' }}>
        {m.desc}
      </div>
    </div>
  );
}

// ─── YAML emission helpers ─────────────────────────────────────────────

// stripEmpty walks the draft and removes empty arguments maps,
// empty configurations / metrics objects, etc. — Volcano accepts
// `arguments: {}` but it clutters the output and reads weirdly.
function stripEmpty(conf: SchedulerConf): SchedulerConf {
  const out: SchedulerConf = { ...conf };
  if (out.tiers) {
    out.tiers = out.tiers.map((t) => ({
      plugins: (t.plugins ?? []).map((p) => {
        const { arguments: args, ...rest } = p;
        const cleanRest: PluginEntry = { ...rest };
        if (args && Object.keys(args).length > 0) cleanRest.arguments = args;
        return cleanRest;
      }),
    }));
  }
  if (out.configurations) {
    out.configurations = out.configurations
      .map((c) => {
        const args = c.arguments;
        if (!args || Object.keys(args).length === 0) {
          return { name: c.name };
        }
        return c;
      })
      .filter((c) => c.name);
  }
  if (out.configurations?.every((c) => !c.arguments)) {
    delete out.configurations;
  }
  if (out.metrics && Object.keys(out.metrics).length === 0) {
    delete out.metrics;
  }
  return out;
}
