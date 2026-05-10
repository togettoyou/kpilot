import React from 'react';

import { VolcanoCRPage } from './CRPage';

// Volcano Job (`batch.volcano.sh/v1alpha1`) — gang-scheduled batch job
// with built-in plugins (env, svc, ssh, mpi, ...). Namespaced.
export default function VolcanoJobsPage() {
  return (
    <VolcanoCRPage
      cr={{
        group: 'batch.volcano.sh',
        version: 'v1alpha1',
        kind: 'Job',
        scope: 'Namespaced',
      }}
    />
  );
}
