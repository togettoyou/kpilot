import React from 'react';

import type { TimeRangeValue } from '@/components/TimeRangePicker';

// Tab identifiers — used by both the Tabs container and individual
// LazySections to decide whether they're in the active tab.
export type MonitoringTab = 'cluster' | 'node' | 'pod';

// MonitoringCtx is the shared bus between the page shell and every
// section / chart / table mounted inside it. The shell owns the
// range picker, polling tick and active-tab state; sections subscribe
// via useMonitoringCtx.
//
// Polling works by incrementing `tick` on every interval fire — each
// section that is currently *active* (visible tab + scrolled into
// view) listens for tick changes via useEffect and refetches itself.
// Sections in hidden tabs ignore tick changes, so flipping back to a
// tab sees its last-known data without spending bandwidth while away.
export interface MonitoringCtxValue {
  clusterId: string;
  range: TimeRangeValue;
  tick: number;
  activeTab: MonitoringTab;
  dark: boolean;
}

export const MonitoringCtx = React.createContext<MonitoringCtxValue | null>(
  null,
);

export function useMonitoringCtx(): MonitoringCtxValue {
  const v = React.useContext(MonitoringCtx);
  if (!v) {
    throw new Error('useMonitoringCtx must be used inside <MonitoringCtx.Provider>');
  }
  return v;
}
