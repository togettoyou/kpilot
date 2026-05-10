import React from 'react';

import { VolcanoCRPage } from './CRPage';

// Volcano HyperNode (`topology.volcano.sh/v1alpha1`) — network
// topology declaration for topology-aware scheduling. Cluster-scoped.
// Used by the network-topology scheduling plugin to pack pods into the
// same physical hierarchy (rack / spine / pod-of-racks) when latency
// matters.
export default function VolcanoHyperNodesPage() {
  return (
    <VolcanoCRPage
      cr={{
        group: 'topology.volcano.sh',
        version: 'v1alpha1',
        kind: 'HyperNode',
        scope: 'Cluster',
      }}
    />
  );
}
