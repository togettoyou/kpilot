import { history, useIntl } from '@umijs/max';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import { Badge, Button, Space, Tag, Tooltip } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  batchSystemSnapshots,
  listSystemNodes,
  type SystemNode,
  type SystemSnapshotEnvelope,
} from '@/services/kpilot/system';
import { formatBigNumber, formatBytes, formatDurationSeconds, formatMillis } from './format';

// One-row record fed to ProTable. Merges the static node list with
// the most-recent batched snapshot envelope; KPI cells render the
// snapshot fields when present, dash otherwise.
type Row = SystemNode & {
  envelope?: SystemSnapshotEnvelope;
};

const REFRESH_INTERVAL_MS = 4000;

export default function SystemLandingPage() {
  const intl = useIntl();
  const [nodes, setNodes] = useState<SystemNode[]>([]);
  const [envelopes, setEnvelopes] = useState<Record<string, SystemSnapshotEnvelope>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Refs let the polling timer call latest fetchers without re-creating
  // the interval every render.
  const inflightRef = useRef(false);

  const reload = async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    setRefreshing(true);
    try {
      const [list, batch] = await Promise.all([listSystemNodes(), batchSystemSnapshots()]);
      setNodes(list || []);
      const next: Record<string, SystemSnapshotEnvelope> = {};
      (batch || []).forEach((e) => {
        next[e.node_id] = e;
      });
      setEnvelopes(next);
    } catch {
      // Errors are toasted globally by requestErrorConfig.
    } finally {
      setLoading(false);
      setRefreshing(false);
      inflightRef.current = false;
    }
  };

  useEffect(() => {
    reload();
    const t = window.setInterval(reload, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo<Row[]>(
    () => nodes.map((n) => ({ ...n, envelope: envelopes[n.node_id] })),
    [nodes, envelopes],
  );

  const columns: ProColumns<Row>[] = [
    {
      title: intl.formatMessage({ id: 'system.col.node', defaultMessage: '节点' }),
      dataIndex: 'node_id',
      render: (_, row) => {
        if (row.kind === 'server') {
          return (
            <Space>
              <Tag color="processing">
                {intl.formatMessage({ id: 'system.kind.server', defaultMessage: 'Server' })}
              </Tag>
              <span>control-plane</span>
            </Space>
          );
        }
        return (
          <Space>
            <Tag color="default">
              {intl.formatMessage({ id: 'system.kind.worker', defaultMessage: 'Worker' })}
            </Tag>
            <span>{row.cluster_name || row.node_id}</span>
          </Space>
        );
      },
    },
    {
      title: intl.formatMessage({ id: 'system.col.status', defaultMessage: '状态' }),
      dataIndex: 'online',
      width: 110,
      render: (_, row) => {
        if (!row.online) {
          return (
            <Badge
              status="default"
              text={intl.formatMessage({ id: 'system.status.offline', defaultMessage: '离线' })}
            />
          );
        }
        if (!row.diag_available) {
          return (
            <Tooltip
              title={intl.formatMessage({
                id: 'system.status.noDiag.tooltip',
                defaultMessage: 'Worker 端 diag 未启用,无法采集指标',
              })}
            >
              <Badge
                status="warning"
                text={intl.formatMessage({ id: 'system.status.noDiag', defaultMessage: '无指标' })}
              />
            </Tooltip>
          );
        }
        return (
          <Badge
            status="success"
            text={intl.formatMessage({ id: 'system.status.online', defaultMessage: '在线' })}
          />
        );
      },
    },
    {
      title: intl.formatMessage({ id: 'system.col.uptime', defaultMessage: '上线时长' }),
      width: 130,
      render: (_, row) => {
        const s = row.envelope?.snapshot?.identity?.uptime_seconds;
        return s === undefined ? '—' : formatDurationSeconds(s);
      },
    },
    {
      title: intl.formatMessage({ id: 'system.col.goroutines', defaultMessage: 'Goroutines' }),
      width: 130,
      render: (_, row) => {
        const n = row.envelope?.snapshot?.runtime?.goroutines;
        return n === undefined ? '—' : formatBigNumber(n);
      },
    },
    {
      title: intl.formatMessage({ id: 'system.col.heap', defaultMessage: 'Heap' }),
      width: 130,
      render: (_, row) => {
        const b = row.envelope?.snapshot?.runtime?.heap_inuse_bytes;
        return b === undefined ? '—' : formatBytes(b);
      },
    },
    {
      title: intl.formatMessage({ id: 'system.col.gcPause', defaultMessage: 'GC p99' }),
      width: 110,
      render: (_, row) => {
        const s = row.envelope?.snapshot?.runtime?.gc_pause_p99_seconds;
        return s === undefined ? '—' : formatMillis(s);
      },
    },
    {
      title: intl.formatMessage({ id: 'system.col.rss', defaultMessage: 'RSS' }),
      width: 130,
      render: (_, row) => {
        const b = row.envelope?.snapshot?.runtime?.rss_bytes;
        if (b === undefined || b === 0) return '—';
        return formatBytes(b);
      },
    },
    {
      title: intl.formatMessage({ id: 'system.col.kpi', defaultMessage: '业务指标' }),
      render: (_, row) => {
        const snap = row.envelope?.snapshot;
        if (!snap?.custom) return '—';
        if (row.kind === 'server') {
          const yamux = snap.custom.yamux as { sessions?: number; streams_open?: number } | undefined;
          const http = snap.custom.http as { in_flight?: number; requests_per_sec?: number } | undefined;
          return (
            <Space size="middle">
              <span>
                {intl.formatMessage({ id: 'system.kpi.sessions', defaultMessage: 'sessions' })}:{' '}
                {yamux?.sessions ?? 0}
              </span>
              <span>
                {intl.formatMessage({ id: 'system.kpi.streams', defaultMessage: 'streams' })}:{' '}
                {yamux?.streams_open ?? 0}
              </span>
              <span>RPS: {http?.requests_per_sec ?? 0}</span>
            </Space>
          );
        }
        const tunnel = snap.custom.tunnel as
          | { connected?: boolean; streams_open?: number; reconnect_total?: number }
          | undefined;
        const proxy = snap.custom.proxy as
          | { inflight_resource?: number; inflight_http_proxy?: number }
          | undefined;
        return (
          <Space size="middle">
            <Tag color={tunnel?.connected ? 'success' : 'error'}>
              {tunnel?.connected
                ? intl.formatMessage({ id: 'system.kpi.tunnelUp', defaultMessage: 'tunnel↑' })
                : intl.formatMessage({ id: 'system.kpi.tunnelDown', defaultMessage: 'tunnel↓' })}
            </Tag>
            <span>
              {intl.formatMessage({ id: 'system.kpi.streams', defaultMessage: 'streams' })}:{' '}
              {tunnel?.streams_open ?? 0}
            </span>
            <span>
              {intl.formatMessage({ id: 'system.kpi.inflight', defaultMessage: 'inflight' })}:{' '}
              {(proxy?.inflight_resource ?? 0) + (proxy?.inflight_http_proxy ?? 0)}
            </span>
          </Space>
        );
      },
    },
    {
      title: intl.formatMessage({ id: 'system.col.actions', defaultMessage: '操作' }),
      key: 'actions',
      fixed: 'right',
      width: 100,
      render: (_, row) => (
        <Button
          type="link"
          size="small"
          disabled={!row.online || !row.diag_available}
          onClick={() => history.push(`/system/${encodeURIComponent(row.node_id)}`)}
        >
          {intl.formatMessage({ id: 'system.action.detail', defaultMessage: '查看' })}
        </Button>
      ),
    },
  ];

  return (
    <PageContainer
      header={{
        title: intl.formatMessage({ id: 'system.title', defaultMessage: '系统监控' }),
        breadcrumb: {},
      }}
      extra={[
        <Button
          key="refresh"
          icon={<ReloadOutlined spin={refreshing} />}
          onClick={reload}
        >
          {intl.formatMessage({ id: 'system.refresh', defaultMessage: '刷新' })}
        </Button>,
      ]}
    >
      <ProTable<Row>
        rowKey="node_id"
        columns={columns}
        dataSource={rows}
        loading={loading && rows.length === 0}
        search={false}
        options={false}
        pagination={false}
        scroll={{ x: 'max-content' }}
      />
    </PageContainer>
  );
}
