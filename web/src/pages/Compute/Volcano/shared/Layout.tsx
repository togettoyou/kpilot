import { DownOutlined, ReloadOutlined } from '@ant-design/icons';
import { history, useIntl } from '@umijs/max';
import { Alert, Button, Dropdown, Result, Space } from 'antd';
import React, { useEffect } from 'react';

// Layout helpers shared by every Volcano list page.
//
// Each page renders a ProTable directly (no longer goes through
// WorkloadsContent / VolcanoCRPage), so we factor out the few small
// pieces every page repeats: the not-installed empty state, the
// poll-interval picker + refresh button, and the age formatter.

interface NotInstalledProps {
  clusterId: string;
}

// NotInstalled is shown when the dedicated list endpoint returns 404 /
// RESOURCE_NOT_AVAILABLE — that's how the server signals "this CRD
// isn't on the cluster", which for any Volcano page means "Volcano
// plugin isn't enabled". We point users straight at the per-cluster
// plugin page so they can flip it on.
export function NotInstalled({ clusterId }: NotInstalledProps) {
  const intl = useIntl();
  return (
    <div className="p-6">
      <Result
        status="info"
        title={intl.formatMessage({
          id: 'pages.compute.volcano.notInstalled.title',
        })}
        subTitle={intl.formatMessage({
          id: 'pages.compute.volcano.notInstalled.subTitle',
        })}
        extra={
          <Button
            type="primary"
            onClick={() => history.push(`/clusters/${clusterId}/plugins`)}
          >
            {intl.formatMessage({
              id: 'pages.compute.volcano.notInstalled.action',
            })}
          </Button>
        }
      />
    </div>
  );
}

// useAutoRefresh wires interval state to a polling effect. Returns
// the current interval and a setter; the caller renders a picker.
//
// Why not useRequest's `pollingInterval`? The polling interval is
// supposed to be user-toggleable (5s → 30s → off), and useRequest's
// pollingInterval is captured at hook init — changing it at runtime
// is silently ignored. A plain setInterval driven by React state is
// straightforward and reliable.
export function useAutoRefresh(refresh: () => void, ready: boolean) {
  // Default off: pages should be quiet until the user opts in. Auto-
  // polling on first paint surprises users and burns API requests on
  // pages they're just glancing at.
  const [interval, setIntervalState] = React.useState<number>(0);
  useEffect(() => {
    if (!ready || interval <= 0) return;
    const t = window.setInterval(refresh, interval);
    return () => window.clearInterval(t);
  }, [ready, interval, refresh]);
  return [interval, setIntervalState] as const;
}

interface RefreshControlProps {
  interval: number;
  setInterval: (n: number) => void;
  refresh: () => void;
  loading?: boolean;
}

// RefreshControl: icon-only reload button + interval dropdown,
// rendered as a single Space.Compact group. Mirrors the workloads
// page exactly (pages/ClusterDetail/Workloads/index.tsx) so the
// compute pages feel identical. Pages that use it should also pass
// `options={{ reload: false }}` to ProTable to hide its built-in
// reload icon (otherwise the two would stack).
export function RefreshControl({
  interval,
  setInterval,
  refresh,
  loading,
}: RefreshControlProps) {
  const intl = useIntl();
  return (
    <Space.Compact>
      <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh} />
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            {
              key: '0',
              label: intl.formatMessage({
                id: 'pages.workloads.refresh.off',
              }),
            },
            { type: 'divider' },
            { key: '5000', label: '5s' },
            { key: '10000', label: '10s' },
            { key: '30000', label: '30s' },
            { key: '60000', label: '60s' },
          ],
          selectedKeys: [String(interval)],
          onClick: ({ key }) => setInterval(Number(key)),
        }}
      >
        <Button style={{ minWidth: 46 }}>
          {interval > 0 ? `${interval / 1000}s` : <DownOutlined />}
        </Button>
      </Dropdown>
    </Space.Compact>
  );
}

// formatAge renders a creationTimestamp into a kubectl-style age:
// "5m", "3h", "2d". K8s itself produces these in the Table API; we
// regenerate it client-side because the slim list endpoints return
// the raw RFC3339 timestamp.
export function formatAge(creationTimestamp?: string): string {
  if (!creationTimestamp) return '';
  const t = new Date(creationTimestamp).getTime();
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

// isResourceNotAvailable detects the RESOURCE_NOT_AVAILABLE 404 the
// volcano list endpoints return when the corresponding CRD isn't
// installed. Used by every page to swap to <NotInstalled />.
export function isResourceNotAvailable(error: unknown): boolean {
  return (
    (error as { response?: { data?: { code?: string } } } | undefined)
      ?.response?.data?.code === 'RESOURCE_NOT_AVAILABLE'
  );
}

// useStaggeredRefresh returns a fire(delaysMs) helper that schedules a
// list of setTimeout(refresh, d) calls and tracks their ids so unmount
// clears them. Volcano lifecycle Commands (Open/Close queue, Suspend
// CronJob, ...) take a beat for the controller to apply, so a series
// of staggered refreshes catches the new state without making the user
// click again — but firing setTimeout-then-unmount would otherwise
// schedule refresh on a hook that's already gone.
export function useStaggeredRefresh(refresh: () => void) {
  const timersRef = React.useRef<number[]>([]);
  useEffect(
    () => () => {
      timersRef.current.forEach((t) => window.clearTimeout(t));
      timersRef.current = [];
    },
    [],
  );
  return (delaysMs: number[]) => {
    delaysMs.forEach((d) => {
      timersRef.current.push(window.setTimeout(refresh, d));
    });
  };
}

// ResourceIntro renders a one-line "what is this" hint at the top of
// each Volcano CR page so a user landing cold understands what the
// resource is for + when to use it without leaving the UI. The text
// itself lives in pages.compute.intro.<resource> i18n keys; the
// component is just a thin wrapper so all pages share styling +
// position. Non-closable: the cost of one persistent line is small
// and we'd rather keep onboarding consistent than save a few px.
export function ResourceIntro({ id }: { id: string }) {
  const intl = useIntl();
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 8 }}
      message={intl.formatMessage({ id })}
    />
  );
}

// TruncatedBanner surfaces the server-side cap (default 500 rows) when
// a Volcano list endpoint returned a `continue` token. We don't wire
// cursor pagination yet — for now the banner just tells the user there
// is more data and how to narrow the view (namespace picker / filter).
export function TruncatedBanner({
  shown,
  count,
}: {
  shown: number;
  count?: number;
}) {
  const intl = useIntl();
  if (!shown) return null;
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 8 }}
      message={intl.formatMessage(
        { id: 'pages.compute.list.truncated' },
        { n: count ?? shown },
      )}
    />
  );
}
