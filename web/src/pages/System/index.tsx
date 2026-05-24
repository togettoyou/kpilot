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
import { formatBigNumber, formatBytes, formatDurationSeconds, formatPercent } from './format';

// One-row record fed to ProTable. Merges the static node list with
// the most-recent batched snapshot envelope; KPI cells render the
// snapshot fields when present, dash otherwise.
type Row = SystemNode & {
  envelope?: SystemSnapshotEnvelope;
};

// 10 s is slow enough that the server's tunnel fan-out cost stays
// negligible even at ~50 connected workers (one yamux roundtrip per
// worker per refresh), and fast enough that a worker coming online /
// dropping out is visible within ~10 s without the operator clicking
// Refresh. The detail page's 1 Hz WS stream is where you go for the
// "live" view; this is just the landing index.
const REFRESH_INTERVAL_MS = 10_000;

export default function SystemLandingPage() {
  const intl = useIntl();
  const [nodes, setNodes] = useState<SystemNode[]>([]);
  const [envelopes, setEnvelopes] = useState<Record<string, SystemSnapshotEnvelope>>({});
  // prevEnvelopes is the previous poll's batch — we need two samples
  // to derive CPU% / CPU cores from the cumulative cpu_*_seconds
  // counters in runtime/metrics. First load shows "—" for CPU; the
  // second poll has both, so it's accurate from then on. 10 s window
  // between samples (REFRESH_INTERVAL_MS) gives a 10-second averaged
  // CPU number, which is fine for a navigation page.
  const [prevEnvelopes, setPrevEnvelopes] = useState<Record<string, SystemSnapshotEnvelope>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Refs let the polling timer call latest fetchers without re-creating
  // the interval every render. envelopesRef mirrors `envelopes` so we
  // can read the most-recent batch inside `reload` (which is captured
  // by setInterval at mount-time — without the ref we'd close over the
  // initial empty object and never compute a real CPU delta).
  const inflightRef = useRef(false);
  const envelopesRef = useRef<Record<string, SystemSnapshotEnvelope>>({});

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
      setPrevEnvelopes(envelopesRef.current);
      envelopesRef.current = next;
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
      width: 110,
      render: (_, row) => {
        const n = row.envelope?.snapshot?.runtime?.goroutines;
        return n === undefined ? '—' : formatBigNumber(n);
      },
    },
    // CPU — % primary, cores secondary. Needs delta of two snapshots
    // so first poll shows "—"; from the 2nd 10 s tick onwards it's
    // an accurate 10-second-window CPU utilization.
    {
      title: intl.formatMessage({ id: 'system.col.cpu', defaultMessage: 'CPU' }),
      width: 150,
      render: (_, row) => {
        const cur = row.envelope?.snapshot;
        const prev = prevEnvelopes[row.node_id]?.snapshot;
        if (!cur || !prev) return '—';
        const a = prev.runtime;
        const b = cur.runtime;
        const totalDelta = b.cpu_total_seconds - a.cpu_total_seconds;
        const busyDelta =
          b.cpu_user_seconds +
          b.cpu_gc_seconds +
          b.cpu_scavenge_seconds -
          (a.cpu_user_seconds + a.cpu_gc_seconds + a.cpu_scavenge_seconds);
        const wallSec = (new Date(cur.at).getTime() - new Date(prev.at).getTime()) / 1000;
        if (totalDelta <= 0 || wallSec <= 0) return '—';
        const pct = Math.max(0, Math.min(1, busyDelta / totalDelta));
        const cores = Math.max(0, busyDelta / wallSec);
        return (
          <div style={{ lineHeight: 1.3 }}>
            <div>{formatPercent(pct)}</div>
            <div style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary, #999)' }}>
              {cores.toFixed(2)} / {cur.identity.num_cpu}{' '}
              {intl.formatMessage({ id: 'system.kpi.coresUnit', defaultMessage: '核' })}
            </div>
          </div>
        );
      },
    },
    // Memory — % primary, RSS / total secondary. Single-snapshot
    // derivation (no delta needed). Linux-only data; macOS/Windows
    // workers report 0 and we show "—".
    {
      title: intl.formatMessage({ id: 'system.col.memory', defaultMessage: '内存' }),
      width: 180,
      render: (_, row) => {
        const r = row.envelope?.snapshot?.runtime;
        if (!r || r.rss_bytes <= 0 || r.mem_total_bytes <= 0) return '—';
        const pct = Math.max(0, Math.min(1, r.rss_bytes / r.mem_total_bytes));
        return (
          <div style={{ lineHeight: 1.3 }}>
            <div>{formatPercent(pct)}</div>
            <div style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary, #999)' }}>
              {formatBytes(r.rss_bytes)} / {formatBytes(r.mem_total_bytes)}
            </div>
          </div>
        );
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
        // Tunnel up/down status was removed — the row's overall
        // online/offline tag in the Status column already conveys
        // the same signal; the Tag here was redundant.
        const tunnel = snap.custom.tunnel as { streams_open?: number } | undefined;
        const proxy = snap.custom.proxy as
          | { inflight_resource?: number; inflight_http_proxy?: number }
          | undefined;
        return (
          <Space size="middle">
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
