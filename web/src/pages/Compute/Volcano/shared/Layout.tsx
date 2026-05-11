import { history, useIntl } from '@umijs/max';
import { Button, Result, Select } from 'antd';
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

interface AutoRefreshSelectProps {
  interval: number;
  setInterval: (n: number) => void;
}

// AutoRefreshSelect: auto-refresh interval picker. Manual refresh is
// covered by ProTable's built-in reload icon (wired via the page's
// `options={{ reload: refresh }}` prop), so this component is only
// the interval dropdown.
export function AutoRefreshSelect({
  interval,
  setInterval,
}: AutoRefreshSelectProps) {
  const intl = useIntl();
  return (
    <Select
      value={interval}
      onChange={setInterval}
      style={{ width: 110 }}
      options={[
        {
          value: 0,
          label: intl.formatMessage({ id: 'pages.workloads.refresh.off' }),
        },
        { value: 5_000, label: '5s' },
        { value: 10_000, label: '10s' },
        { value: 30_000, label: '30s' },
        { value: 60_000, label: '60s' },
      ]}
    />
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
