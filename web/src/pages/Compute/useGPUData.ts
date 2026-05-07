import { useRequest } from '@umijs/max';
import { useEffect, useMemo } from 'react';

import { getClusterGPU, type GPUNodeSummary } from '@/services/kpilot/gpu';
import {
  listClusterPlugins,
  type PluginPhase,
} from '@/services/kpilot/plugin';

const HAMI_PLUGIN_NAME = 'hami';
const POLL_INTERVAL_READY = 10_000;
const POLL_INTERVAL_INSTALLING = 5_000;

export type HAMiState = 'ready' | 'installing' | 'failed' | 'missing';

function rollUp(phase: PluginPhase | undefined, enabled: boolean): HAMiState {
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

// useGPUData is the shared backbone all four 智算 sub-pages plug into.
// Doing the dep-check + polling here keeps each page focused on its own
// pivot of the data and means refresh / error state behave identically
// across pages — the user sees the same dep-check Result on Overview,
// Nodes, Cards, and Tasks rather than four near-but-not-identical
// implementations.
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

  const hamiState: HAMiState = useMemo(() => {
    const item = (plugins.data ?? []).find(
      (p) => p.plugin.name === HAMI_PLUGIN_NAME,
    );
    return rollUp(item?.phase, item?.enabled ?? false);
  }, [plugins.data]);

  // Poll the GPU summary while HAMi is up. We don't poll the plugins
  // list — its state changes are driven by enable/disable handler
  // pushes already; the 5s while-installing poll below covers the only
  // dynamic transition.
  useEffect(() => {
    if (hamiState !== 'ready') return;
    const t = setInterval(() => gpu.refresh(), POLL_INTERVAL_READY);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hamiState]);

  // Poll the plugin list while HAMi is mid-install so the page flips
  // to data-view automatically when install completes.
  useEffect(() => {
    if (hamiState !== 'installing') return;
    const t = setInterval(() => plugins.refresh(), POLL_INTERVAL_INSTALLING);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hamiState]);

  const nodes: GPUNodeSummary[] = gpu.data ?? [];
  return {
    nodes,
    hamiState,
    pluginsLoading: plugins.loading && !plugins.data,
    gpuLoading: gpu.loading,
    refreshGPU: gpu.refresh,
    refreshPlugins: plugins.refresh,
  };
}
