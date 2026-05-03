import { useCallback, useState } from 'react';

import { listNamespaces } from '@/services/kpilot/workload';

interface NamespaceState {
  selected: string;
  list: string[];
  loading: boolean;
}

const DEFAULT: NamespaceState = {
  selected: '',
  list: [],
  loading: false,
};

// useNamespace tracks per-cluster namespace selection so the global picker in
// the top bar persists across page navigations within a cluster (deployments
// → services → ... keeps the chosen ns) and across cluster switches stays
// independent (each cluster has its own selection + list).
//
// Registered automatically by Umi's model plugin (file in src/models/).
// Consume via `useModel('namespace')`.
export default function useNamespace() {
  const [byCluster, setByCluster] = useState<Record<string, NamespaceState>>(
    {},
  );

  const get = useCallback(
    (id: string): NamespaceState => byCluster[id] ?? DEFAULT,
    [byCluster],
  );

  const setSelected = useCallback((id: string, ns: string) => {
    setByCluster((p) => ({
      ...p,
      [id]: { ...(p[id] ?? DEFAULT), selected: ns },
    }));
  }, []);

  const refresh = useCallback(async (id: string) => {
    setByCluster((p) => ({
      ...p,
      [id]: { ...(p[id] ?? DEFAULT), loading: true },
    }));
    try {
      const list = (await listNamespaces(id)) as unknown as string[];
      setByCluster((p) => ({
        ...p,
        [id]: { ...(p[id] ?? DEFAULT), list, loading: false },
      }));
    } catch {
      setByCluster((p) => ({
        ...p,
        [id]: { ...(p[id] ?? DEFAULT), loading: false },
      }));
    }
  }, []);

  return { get, setSelected, refresh };
}
