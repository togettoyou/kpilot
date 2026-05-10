import React from 'react';

import { VolcanoCRPage } from './CRPage';

// Volcano PodGroup (`scheduling.volcano.sh/v1beta1`) — gang-scheduling
// unit. minMember / minResources govern when the group is allowed to
// start. Namespaced. Auto-created by the Job controller for Volcano
// Jobs but users can also create standalone PodGroups for non-Job
// workloads that want gang scheduling.
export default function VolcanoPodGroupsPage() {
  return (
    <VolcanoCRPage
      cr={{
        group: 'scheduling.volcano.sh',
        version: 'v1beta1',
        kind: 'PodGroup',
        scope: 'Namespaced',
      }}
    />
  );
}
