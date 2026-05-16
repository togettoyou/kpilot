import { request } from '@umijs/max';

// Mirrors pkg/server/api/handler/device_health.go::deviceHealthResponse.
//
// `severity` and `kind` are the same closed enums as the Go side.
// New `kind` values added on the server are surfaced raw by the frontend
// (the row renderer falls back to the kind string) — frontend i18n
// catches up on its own pace without breaking the page.

export type AlertSeverity = 'critical' | 'warning' | 'info';

export type AlertKind =
  | 'xid_error'
  | 'ecc_uncorrectable'
  | 'overheat'
  | 'fb_memory_near_full';

export interface DeviceAlert {
  severity: AlertSeverity;
  kind: AlertKind | string;
  hostname?: string;
  instance?: string;
  gpu?: string;
  uuid?: string;
  value: number;
  message: string;
}

export interface DeviceHealthResponse {
  alerts: DeviceAlert[];
  generatedAt: string;
  counts: {
    critical: number;
    warning: number;
    info: number;
  };
}

export function getDeviceHealth(clusterId: string) {
  return request<DeviceHealthResponse>(
    `/api/v1/clusters/${clusterId}/device-health`,
    { method: 'GET' },
  );
}
