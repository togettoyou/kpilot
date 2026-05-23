import { CaretDownOutlined, CaretRightOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import { Card, Spin, Typography } from 'antd';
import React from 'react';

import { useMonitoringCtx, type MonitoringTab } from './MonitoringContext';

// LazySection wraps a page section (a Card with collapsible body) so
// the chart subtree inside it only mounts when first visible — either
// because the user expanded the section manually or because it
// scrolled into view. Once mounted, the subtree stays mounted across
// collapse/expand so the chart's local state (legend toggles, etc.)
// survives.
//
// "Visible" feeds two distinct behaviors:
//   1. First-mount gating (via hasBeenSeen) — avoids paying the
//      PromQL fan-out + chart bundle cost for sections the user
//      never scrolls to.
//   2. Polling participation (via `active`) — sections only refetch
//      on the shared polling tick when they're in the current tab
//      AND expanded. Hidden tabs + collapsed sections sit at zero
//      network cost.
//
// Children receive { active } so they can early-return their fetch
// effect when paused.
interface Props {
  tab: MonitoringTab;
  title: React.ReactNode;
  // Right-side header content — usually a filter input or namespace
  // picker. Always visible (independent of the collapsed state) so
  // the user can adjust scope without expanding first.
  extra?: React.ReactNode;
  // Whether the section is open by default. Most sections default
  // to true; "advanced" sections (e.g., Storage I/O) can default
  // closed to keep first paint cheap.
  defaultOpen?: boolean;
  children: (api: { active: boolean }) => React.ReactNode;
}

const LazySection: React.FC<Props> = ({
  tab,
  title,
  extra,
  defaultOpen = true,
  children,
}) => {
  const intl = useIntl();
  const { activeTab } = useMonitoringCtx();
  const isActiveTab = activeTab === tab;
  const [open, setOpen] = React.useState(defaultOpen);
  // Tracks whether the section has ever been mounted (visible). Once
  // true, child stays in the DOM permanently so chart state and last-
  // known data survive collapse/expand cycles. Re-collapsing only
  // pauses polling; it doesn't unmount.
  const [hasBeenSeen, setHasBeenSeen] = React.useState(defaultOpen);
  const sentinelRef = React.useRef<HTMLDivElement>(null);

  // IntersectionObserver — fires once when the section sentinel
  // enters the viewport. Disconnect immediately after first fire to
  // free the observer; we don't need to track exits.
  //
  // Gated on `open` so a default-closed section scrolling into view
  // does NOT silently fire the server fetch — the user must opt in by
  // clicking the header. Default-open sections start with
  // hasBeenSeen=true (see useState init) so this effect early-returns
  // for them anyway; the gate matters for the default-closed case.
  React.useEffect(() => {
    if (hasBeenSeen) return;
    if (!isActiveTab) return; // observers in hidden tabs would never fire anyway
    if (!open) return; // collapsed: never auto-fire from scroll
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (e && e.isIntersecting) {
          setHasBeenSeen(true);
          io.disconnect();
        }
      },
      // 5% threshold + a 100px rootMargin so the section starts
      // mounting just before it scrolls fully into view, hiding the
      // chart bundle's first-paint flicker.
      { threshold: 0.05, rootMargin: '100px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasBeenSeen, isActiveTab, open]);

  // active = the section should currently be doing work (polling, etc.)
  const active = isActiveTab && open && hasBeenSeen;

  const header = (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        // Expanding from collapsed for the first time should also
        // mark hasBeenSeen so the first manual open triggers
        // initial fetch even if the section was below the fold.
        if (!hasBeenSeen) setHasBeenSeen(true);
        setOpen((v) => !v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!hasBeenSeen) setHasBeenSeen(true);
          setOpen((v) => !v);
        }
      }}
      style={{
        cursor: 'pointer',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      {open ? <CaretDownOutlined /> : <CaretRightOutlined />}
      <Typography.Text strong>{title}</Typography.Text>
    </div>
  );

  return (
    <Card
      size="small"
      title={header}
      extra={extra}
      styles={{ body: { padding: open ? 16 : 0 } }}
    >
      {/* Sentinel is always present so IntersectionObserver can fire
          even when the body is collapsed. Sized to 1px so it doesn't
          influence layout. */}
      <div ref={sentinelRef} style={{ height: 1, marginTop: -1 }} aria-hidden />
      {hasBeenSeen ? (
        // Display:none keeps the child mounted (preserving local
        // chart state) while collapsed. Polling effects gate on
        // `active`, so a collapsed section doesn't refetch on the
        // shared tick.
        <div style={{ display: open ? 'block' : 'none' }}>{children({ active })}</div>
      ) : open ? (
        // First-paint placeholder while the section is opened but
        // the IntersectionObserver hasn't fired yet (edge case: user
        // expanded a section that was already in view before the
        // observer attached). Browser hands us isIntersecting on the
        // next tick.
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin />
        </div>
      ) : (
        // Collapsed + unmounted: leave a small hint so the section
        // header isn't visually orphaned. Cheap (no JS, no chart).
        <div
          style={{
            textAlign: 'center',
            color: 'var(--ant-color-text-tertiary)',
            fontSize: 12,
            padding: '12px 0',
          }}
        >
          {intl.formatMessage({
            id: 'pages.monitoring.lazy.scrollToLoad',
            defaultMessage: '展开查看',
          })}
        </div>
      )}
    </Card>
  );
};

// usePollingRefresh wires a section's local fetcher to the page's
// shared polling tick — only firing when the section is currently
// active (visible tab + expanded). Sections call this once at mount;
// initial fetch is handled by their useClusterRequest (which fires
// on its own deps).
//
// Skipping the very first tick value avoids a double-fetch on first
// mount: useClusterRequest already fired its initial run; we shouldn't
// fire again at tick=N where N is whatever the page is at when this
// section first mounts.
export function usePollingRefresh(refresh: () => void, active: boolean) {
  const { tick } = useMonitoringCtx();
  const seenTickRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!active) {
      // Reset on deactivation so the next activation doesn't fire
      // a "missed" refresh as a stale tick value comes back.
      seenTickRef.current = tick;
      return;
    }
    if (seenTickRef.current === null) {
      seenTickRef.current = tick;
      return;
    }
    if (tick !== seenTickRef.current) {
      seenTickRef.current = tick;
      refresh();
    }
  }, [tick, active]);
  // intentional: don't include `refresh` in deps — useRequest hands
  // back a new function on every render. Reading the latest via
  // closure is fine; we only want to fire on tick change.
}

// Suspense fallback wrapped in standard padding — used by every
// chart Row in the sections.
export const ChartFallback: React.FC = () => (
  <div style={{ textAlign: 'center', padding: 48 }}>
    <Spin />
  </div>
);

export default LazySection;
