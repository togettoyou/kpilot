import React from 'react';

import { VolcanoCRPage } from './CRPage';

// Volcano CronJob (`batch.volcano.sh/v1alpha1`) — scheduled trigger
// for a Volcano Job template. Namespaced.
export default function VolcanoCronJobsPage() {
  return (
    <VolcanoCRPage
      cr={{
        group: 'batch.volcano.sh',
        version: 'v1alpha1',
        kind: 'CronJob',
        scope: 'Namespaced',
      }}
    />
  );
}
