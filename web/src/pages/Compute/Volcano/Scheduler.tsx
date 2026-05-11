import {
  EditOutlined,
  InfoCircleOutlined,
  MinusCircleOutlined,
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
  Empty,
  Result,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import yaml from 'js-yaml';
import React, { useEffect, useMemo, useState } from 'react';

import { YamlEditor } from '@/pages/ClusterDetail/Workloads/YamlEditor';
import { listClusterPlugins } from '@/services/kpilot/plugin';
import { applyManifest } from '@/services/kpilot/volcano';
import { getWorkload } from '@/services/kpilot/workload';
import { NotInstalled } from './shared/Layout';
import {
  ACTION_NAMES,
  ACTIONS_META,
  metaForAction,
  metaForPlugin,
  PLUGIN_NAMES,
  PLUGINS_META,
} from './schedulerMeta';

const { Text, Paragraph } = Typography;

interface SchedulerConf {
  actions?: string;
  tiers?: TierEntry[];
}

interface TierEntry {
  plugins?: PluginEntry[];
}

interface PluginEntry {
  name?: string;
  // Plugin args are open-ended; preserved as-is on round-trip so the
  // YAML view can edit `enablePreemptable`, `priorityClassNames`,
  // etc. The form view treats plugins as just-a-name; users who
  // want to set plugin args drop into the YAML tab.
  [k: string]: unknown;
}

// VolcanoSchedulerPage renders the scheduler's runtime config from
// volcano-scheduler-configmap, with two views the user can switch
// between freely:
//
//   - 表单 view: action multi-select + per-tier plugin chips, every
//     entry annotated with a one-line "what does this knob do"
//     tooltip and a beginner-friendly help section at the bottom.
//   - YAML view: full edit of the configmap's volcano-scheduler.conf
//     key, for plugin args / hand-tuning that the form doesn't
//     surface.
//
// Saving SSA-applies a new ConfigMap manifest with the rebuilt
// volcano-scheduler.conf string. Volcano scheduler watches the
// configmap and reloads automatically.
export default function VolcanoSchedulerPage() {
  const intl = useIntl();
  const { message } = App.useApp();
  const { id: clusterId } = useParams<{ id: string }>();

  // Per-cluster plugin status, NOT the global registry. The global
  // registry always lists Volcano (it's a built-in), so a check against
  // it can't tell us whether *this* cluster has Volcano enabled and
  // running — which is what gates the configmap fetch below.
  const plugins = useRequest(() => listClusterPlugins(clusterId!), {
    formatResult: (res) => res,
    ready: !!clusterId,
    refreshDeps: [clusterId],
  });
  const volcanoEntry = useMemo(() => {
    return plugins.data?.find((p) => p.plugin.name === 'volcano');
  }, [plugins.data]);
  const volcanoNs =
    volcanoEntry?.plugin.default_release_namespace ?? null;
  const volcanoReady = volcanoEntry?.phase === 'Running';

  // Only fetch the scheduler configmap once we know Volcano is actually
  // running on this cluster. Otherwise the request fails with a K8s
  // "configmaps ... not found" that the global error handler would toast,
  // even though the page already renders <NotInstalled> for this case.
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

  // Editable state: draft is the canonical SchedulerConf we mutate
  // from form events; yamlText is the same content as YAML for the
  // YAML view. They sync on tab switch.
  const [view, setView] = useState<'form' | 'yaml'>('form');
  const [draft, setDraft] = useState<SchedulerConf>({
    actions: '',
    tiers: [],
  });
  const [yamlText, setYamlText] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Read-only by default: the page lands as a config inspector. The
  // user clicks 编辑 to enter edit mode (which surfaces save / cancel
  // and unlocks form inputs + the YAML editor). Cancel reverts to
  // the last fetched snapshot.
  const [editing, setEditing] = useState(false);

  // Re-seed draft + yamlText whenever a fresh configmap arrives.
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
        // bad config in cluster; surface as parse error in form view
        // by leaving draft empty. yamlText still gets the raw text
        // so the user can fix it from the YAML tab.
      }
    }
    setDraft(parsed);
    setYamlText(typeof text === 'string' ? text : '');
    setYamlError(null);
    setView('form');
    setEditing(false);
  }, [cm.data]);

  const cancelEdit = () => {
    // Revert to the last fetched snapshot — re-runs the same effect
    // body as the cm.data load above.
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
        setYamlText(yaml.dump(draft));
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
    // If the user is in YAML view, take the raw text as-is so plugin
    // args / formatting they typed survive intact. Form view dumps
    // from draft.
    const text = view === 'yaml' ? yamlText : yaml.dump(draft);
    // Validate the YAML before shipping; an unparseable conf would
    // break the running scheduler.
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

  // Same NotInstalled state the 5 CR pages render. Covers all
  // not-actually-running cases on this cluster: not in registry,
  // never enabled, mid-install (Pending/Installing), Uninstalling,
  // and Failed — pointing the user at the per-cluster Plugins page
  // is the right next step in every one of those.
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
      </Space>

      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {intl.formatMessage({ id: 'pages.compute.scheduler.intro' })}
      </Paragraph>

      {/* Help section sits above the editor — small users land here
          looking for a reference, so the cheatsheet should be the
          first thing they can crack open. */}
      <HelpSection />

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

// ─── Form view ──────────────────────────────────────────────────────────

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

  const setActions = (next: string[]) => {
    onChange({ ...draft, actions: next.join(', ') });
  };
  const setTiers = (next: TierEntry[]) => {
    onChange({ ...draft, tiers: next });
  };
  const addTier = () => setTiers([...tiers, { plugins: [] }]);
  const removeTier = (i: number) =>
    setTiers(tiers.filter((_, idx) => idx !== i));
  const setTierPlugins = (i: number, names: string[]) => {
    // Preserve plugin args when the user keeps a plugin selected;
    // drop entries the user removed from the multi-select; treat
    // newly-added names as { name } only (args left to the YAML
    // tab if needed).
    const current = tiers[i]?.plugins ?? [];
    const byName = new Map(current.filter((p) => p.name).map((p) => [p.name!, p]));
    const nextPlugins: PluginEntry[] = names.map(
      (n) => byName.get(n) ?? ({ name: n } as PluginEntry),
    );
    setTiers(tiers.map((t, idx) => (idx === i ? { plugins: nextPlugins } : t)));
  };

  return (
    <>
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
          onChange={setActions}
          disabled={!editable}
          style={{ width: '100%' }}
          placeholder={intl.formatMessage({
            id: 'pages.compute.scheduler.actions.placeholder',
          })}
          options={ACTION_NAMES.map((n) => ({
            label: <ActionOption name={n} />,
            value: n,
          }))}
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
      </Card>

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
      >
        {tiers.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={intl.formatMessage({
              id: 'pages.compute.scheduler.noTiers',
            })}
          />
        ) : (
          tiers.map((tier, i) => {
            const names = (tier.plugins ?? [])
              .map((p) => p.name ?? '')
              .filter(Boolean);
            return (
              <Card
                key={i}
                size="small"
                type="inner"
                title={intl.formatMessage(
                  { id: 'pages.compute.scheduler.tier' },
                  { n: i + 1 },
                )}
                style={{ marginBottom: 8 }}
                extra={
                  editable ? (
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<MinusCircleOutlined />}
                      onClick={() => removeTier(i)}
                    />
                  ) : null
                }
              >
                <Select
                  mode="multiple"
                  value={names}
                  onChange={(next) => setTierPlugins(i, next as string[])}
                  disabled={!editable}
                  style={{ width: '100%' }}
                  placeholder={intl.formatMessage({
                    id: 'pages.compute.scheduler.plugins.placeholder',
                  })}
                  options={PLUGIN_NAMES.map((n) => ({
                    label: <PluginOption name={n} />,
                    value: n,
                  }))}
                  optionLabelProp="value"
                  tagRender={(props) => (
                    <Tooltip title={metaForPlugin(props.value as string).desc}>
                      <Tag
                        color="green"
                        closable={editable && props.closable}
                        onClose={props.onClose}
                        style={{ marginInlineEnd: 6, marginBlock: 2 }}
                      >
                        {props.value}
                      </Tag>
                    </Tooltip>
                  )}
                />
              </Card>
            );
          })
        )}
      </Card>
    </>
  );
}

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

// ─── Help section ───────────────────────────────────────────────────────

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
              items={Object.entries(ACTIONS_META).map(([k, v]) => ({
                k,
                v,
              }))}
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
              items={Object.entries(PLUGINS_META).map(([k, v]) => ({
                k,
                v,
              }))}
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
