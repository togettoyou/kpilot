import { request } from '@umijs/max';

// repo  = traditional Helm repo (https + index.yaml)
// local = uploaded .tgz, dedup'd by sha256 in PluginBlob
// oci   = OCI registry (Helm 3.8+); chart_repo holds the full oci:// URL
export type ChartType = 'repo' | 'local' | 'oci';
export type PluginCategory =
  | 'gpu'
  | 'scheduling'
  | 'networking'
  | 'storage'
  | 'monitoring'
  | 'logging'
  | 'security'
  | 'serving'
  | 'custom';
export type PluginPhase =
  | 'Disabled'
  | 'Pending'
  | 'Installing'
  | 'Upgrading'
  | 'Running'
  | 'Failed'
  | 'Uninstalling';

// Plugin matches the registry row returned by GET /api/v1/plugins.
export interface Plugin {
  id: number;
  name: string;
  display_name: string;
  description: string;
  category: PluginCategory;
  is_builtin: boolean;
  sort_order?: number;
  icon_url?: string;
  chart_type: ChartType;
  chart_repo?: string;
  chart_name?: string;
  chart_blob_id?: number;
  default_version?: string;
  default_values?: string;
  default_release_namespace?: string;
  created_at: string;
  updated_at: string;
}

// Per-cluster view row joining registry + ClusterPlugin state.
export interface ClusterPluginItem {
  plugin: Plugin;
  enabled: boolean;
  phase: PluginPhase;
  message?: string;
  observed_version?: string;
  helm_revision?: number;
  installed_at?: string;
  version_override?: string;
  values_override?: string;
}

// Body sent on create / update of a registry plugin entry.
export interface PluginInput {
  name: string;
  display_name: string;
  description?: string;
  category: PluginCategory;
  icon_url?: string;
  chart_type: ChartType;
  chart_repo?: string;
  chart_name?: string;
  chart_blob_id?: number;
  default_version?: string;
  default_values?: string;
  default_release_namespace?: string;
}

export interface UploadResult {
  id: number;
  sha256: string;
  size_bytes: number;
  filename: string;
}

// ─── Global registry ──────────────────────────────────────────────────────

// listPlugins returns a "brief" plugin list — every field except
// default_values, which is omitted server-side because that single
// column dominates the response payload (a 64 KiB cap per row, polled
// every few seconds across the cluster Plugins page). Use getPlugin
// to fetch a single plugin's full record when the YAML editor needs
// to seed its default values.
export function listPlugins() {
  return request<Plugin[]>('/api/v1/plugins', { method: 'GET' });
}

export function getPlugin(id: number) {
  return request<Plugin>(`/api/v1/plugins/${id}`, { method: 'GET' });
}

export function createPlugin(data: PluginInput) {
  return request<Plugin>('/api/v1/plugins', { method: 'POST', data });
}

export function updatePlugin(id: number, data: PluginInput) {
  return request(`/api/v1/plugins/${id}`, { method: 'PATCH', data });
}

export function deletePlugin(id: number) {
  return request(`/api/v1/plugins/${id}`, { method: 'DELETE' });
}

// uploadPluginChart sends a multipart .tgz; the body is a FormData built
// from the file the user dropped on the upload control.
export function uploadPluginChart(file: File) {
  const form = new FormData();
  form.append('file', file);
  return request<UploadResult>('/api/v1/plugins/upload', {
    method: 'POST',
    data: form,
    requestType: 'form',
  });
}

// ─── Per-cluster ──────────────────────────────────────────────────────────

export function listClusterPlugins(clusterId: string) {
  return request<ClusterPluginItem[]>(
    `/api/v1/clusters/${clusterId}/plugins`,
    { method: 'GET' },
  );
}

export interface EnableParams {
  values_override?: string;
  version_override?: string;
}

export function enablePlugin(
  clusterId: string,
  pluginName: string,
  params: EnableParams,
) {
  return request(
    `/api/v1/clusters/${clusterId}/plugins/${pluginName}/enable`,
    { method: 'POST', data: params },
  );
}

export function disablePlugin(clusterId: string, pluginName: string) {
  return request(
    `/api/v1/clusters/${clusterId}/plugins/${pluginName}/disable`,
    { method: 'POST' },
  );
}
