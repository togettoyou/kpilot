import React from 'react';

import { VolcanoCRPage } from './CRPage';

// Volcano Queue (`scheduling.volcano.sh/v1beta1`) — cluster-scoped
// resource pool. Carries capability / guarantee quotas, weight, state.
export default function VolcanoQueuesPage() {
  return (
    <VolcanoCRPage
      cr={{
        group: 'scheduling.volcano.sh',
        version: 'v1beta1',
        kind: 'Queue',
        scope: 'Cluster',
      }}
    />
  );
}
