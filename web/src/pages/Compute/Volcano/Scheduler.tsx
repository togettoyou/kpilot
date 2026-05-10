import { ReloadOutlined } from '@ant-design/icons';
import { useIntl, useParams, useRequest } from '@umijs/max';
import {
  Alert,
  Button,
  Card,
  Empty,
  Result,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import yaml from 'js-yaml';
import React, { useMemo } from 'react';

import { listPlugins } from '@/services/kpilot/plugin';
import { getWorkload } from '@/services/kpilot/workload';

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
  // Plugin args are open-ended; we just enumerate them as label/value
  // tags. Booleans, numbers, strings — all rendered as-is.
  [k: string]: unknown;
}

// SchedulerPage shows the Volcano scheduler's runtime configuration
// (volcano-scheduler-configmap → key volcano-scheduler.conf) in a
// structured read-only view. The configmap is the user's most direct
// answer to "what plugins are actually scheduling my pods" — much
// more informative than deriving it from chart values.
//
// Editing happens through the Plugins page (volcano plugin's values
// override) so we don't have to round-trip the configmap edit ourselves
// — and editing it raw would defeat the rolling-upgrade flow that
// changes to the chart's helm values trigger.
export default function VolcanoSchedulerPage() {
  const intl = useIntl();
  const { id: clusterId } = useParams<{ id: string }>();

  // Pull the Volcano plugin entry so we know which namespace the
  // configmap lives in. listPlugins is the brief variant — fine, we
  // only need the namespace.
  const plugins = useRequest(listPlugins, {
    formatResult: (res) => res,
  });
  const volcanoNs = useMemo(() => {
    const list = plugins.data ?? [];
    const v = list.find((p) => p.name === 'volcano');
    return v?.default_release_namespace || 'volcano-system';
  }, [plugins.data]);

  const cm = useRequest(
    () =>
      getWorkload(clusterId!, 'configmaps', 'volcano-scheduler-configmap', volcanoNs),
    {
      formatResult: (res) => res,
      ready: !!clusterId && !!volcanoNs,
      refreshDeps: [clusterId, volcanoNs],
    },
  );

  const { conf, parseError } = useMemo<{
    conf: SchedulerConf | null;
    parseError: string | null;
  }>(() => {
    const obj: any = cm.data;
    if (!obj) return { conf: null, parseError: null };
    const text =
      obj?.data?.['volcano-scheduler.conf'] ??
      obj?.data?.['volcano-scheduler.yaml'];
    if (!text || typeof text !== 'string') {
      return { conf: null, parseError: 'no volcano-scheduler.conf key' };
    }
    try {
      const parsed = yaml.load(text) as SchedulerConf;
      return { conf: parsed, parseError: null };
    } catch (e: any) {
      return { conf: null, parseError: String(e?.message ?? e) };
    }
  }, [cm.data]);

  if (cm.loading && !cm.data) {
    return (
      <div style={{ padding: 24 }}>
        <Spin size="large" />
      </div>
    );
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
            { ns: volcanoNs },
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
      <Space style={{ marginBottom: 16 }} align="center">
        <Text strong>
          {intl.formatMessage({ id: 'pages.compute.scheduler.title' })}
        </Text>
        <Tag>{volcanoNs}/volcano-scheduler-configmap</Tag>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => cm.refresh()}
        >
          {intl.formatMessage({ id: 'pages.workloads.refresh.retry' })}
        </Button>
      </Space>

      <Paragraph type="secondary">
        {intl.formatMessage({ id: 'pages.compute.scheduler.subtitle' })}
      </Paragraph>

      {parseError && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={intl.formatMessage({
            id: 'pages.compute.scheduler.parseError',
          })}
          description={parseError}
        />
      )}

      {conf ? (
        <>
          <Card
            size="small"
            title={intl.formatMessage({
              id: 'pages.compute.scheduler.actions',
            })}
            style={{ marginBottom: 12 }}
          >
            {conf.actions ? (
              <Space wrap>
                {conf.actions.split(',').map((a) => (
                  <Tag color="blue" key={a.trim()} style={{ fontSize: 13 }}>
                    {a.trim()}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Text type="secondary">
                {intl.formatMessage({
                  id: 'pages.compute.scheduler.noActions',
                })}
              </Text>
            )}
          </Card>

          <Card
            size="small"
            title={intl.formatMessage({
              id: 'pages.compute.scheduler.tiers',
            })}
          >
            {!conf.tiers || conf.tiers.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={intl.formatMessage({
                  id: 'pages.compute.scheduler.noTiers',
                })}
              />
            ) : (
              conf.tiers.map((tier, i) => (
                <Card
                  key={i}
                  size="small"
                  type="inner"
                  title={`Tier ${i + 1}`}
                  style={{ marginBottom: 8 }}
                >
                  {!tier.plugins || tier.plugins.length === 0 ? (
                    <Text type="secondary">
                      {intl.formatMessage({
                        id: 'pages.compute.scheduler.noPlugins',
                      })}
                    </Text>
                  ) : (
                    <Space direction="vertical" style={{ width: '100%' }}>
                      {tier.plugins.map((p, j) => (
                        <PluginRow key={j} plugin={p} />
                      ))}
                    </Space>
                  )}
                </Card>
              ))
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}

// PluginRow — one plugin entry inside a tier. Renders the name as a
// tag and the rest of its keys (enablePreemptable / enableJobStarving
// / arguments / etc.) as label = value tags. Skip name itself since
// it's the row's own header.
function PluginRow({ plugin }: { plugin: PluginEntry }) {
  const { name, ...args } = plugin;
  const argEntries = Object.entries(args);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <Tag color="green" style={{ fontSize: 13 }}>
        {String(name ?? 'unknown')}
      </Tag>
      {argEntries.map(([k, v]) => (
        <Tag key={k}>
          <Text strong>{k}</Text> = {fmtArg(v)}
        </Tag>
      ))}
    </div>
  );
}

function fmtArg(v: unknown): string {
  if (v == null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
    return String(v);
  }
  return JSON.stringify(v);
}
