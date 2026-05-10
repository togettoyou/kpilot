import { useRequest } from '@umijs/max';
import { useEffect, useMemo } from 'react';

import { getClusterGPU, type GPUNodeSummary } from '@/services/kpilot/gpu';
import {
  listClusterPlugins,
  type PluginPhase,
} from '@/services/kpilot/plugin';

// GPU virtualization plugin name in the registry. Currently points at
// `volcano-vgpu-device-plugin` (Project-HAMi maintained, ships with the
// Volcano scheduler's deviceshare plugin). Phase 3 of the Volcano pivot
// will land this plugin as a built-in; until then the dep check reports
// "missing" and the GPU dashboard falls through to its empty state.
//
// The worker-side gpu.go parser still reads HAMi-flavored annotations
// (`hami.io/node-nvidia-register`, `hami.io/vgpu-devices-allocated`) —
// also a Phase 3 rewrite. Clusters with a manual HAMi install continue
// to render data; everything else shows the empty state until the
// rewrite lands.
const GPU_PLUGIN_NAME = 'volcano-vgpu-device-plugin';
const POLL_INTERVAL_READY = 10_000;
const POLL_INTERVAL_INSTALLING = 5_000;

export type GPUDepState = 'ready' | 'installing' | 'failed' | 'missing';

function rollUp(phase: PluginPhase | undefined, enabled: boolean): GPUDepState {
  if (!phase || !enabled) return 'missing';
  switch (phase) {
    case 'Running':
      return 'ready';
    case 'Pending':
    case 'Installing':
    case 'Upgrading':
      return 'installing';
    case 'Failed':
      return 'failed';
    default:
      return 'missing';
  }
}

// useGPUData is the shared backbone the GPU sub-pages plug into. Doing
// the dep-check + polling here keeps each page focused on its own
// pivot of the data and means refresh / error state behave identically
// across pages.
export function useGPUData(clusterId: string | undefined) {
  const plugins = useRequest(() => listClusterPlugins(clusterId!), {
    formatResult: (res) => res,
    ready: !!clusterId,
    refreshDeps: [clusterId],
  });

  const gpu = useRequest(() => getClusterGPU(clusterId!), {
    formatResult: (res) => res,
    ready: !!clusterId,
    refreshDeps: [clusterId],
  });

  const depState: GPUDepState = useMemo(() => {
    const item = (plugins.data ?? []).find(
      (p) => p.plugin.name === GPU_PLUGIN_NAME,
    );
    return rollUp(item?.phase, item?.enabled ?? false);
  }, [plugins.data]);

  // Poll the GPU summary while the dep is up.
  useEffect(() => {
    if (depState !== 'ready') return;
    const t = setInterval(() => gpu.refresh(), POLL_INTERVAL_READY);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depState]);

  // Poll the plugin list while mid-install so the page auto-flips
  // when install completes.
  useEffect(() => {
    if (depState !== 'installing') return;
    const t = setInterval(() => plugins.refresh(), POLL_INTERVAL_INSTALLING);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depState]);

  const nodes: GPUNodeSummary[] = gpu.data ?? [];
  return {
    nodes,
    depState,
    pluginsLoading: plugins.loading && !plugins.data,
    gpuLoading: gpu.loading,
    refreshGPU: gpu.refresh,
    refreshPlugins: plugins.refresh,
  };
}
