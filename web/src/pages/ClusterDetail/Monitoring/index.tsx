import React from 'react';

import GrafanaEmbed from '@/components/GrafanaEmbed';

// All the iframe / scroll / theme / dep-check machinery lives in
// GrafanaEmbed; this page just supplies the monitoring-specific config:
// metrics-side dependencies and the Node Exporter Full dashboard UID.
const MonitoringPage: React.FC = () => (
  <GrafanaEmbed
    required={['grafana', 'victoria-metrics']}
    recommended={['node-exporter']}
    // UID baked into the upstream NodeExporterFull JSON we embed at
    // pkg/server/dashboards/builtin/node-exporter-full.json.
    dashboardUID="rYdddlPWk"
    i18nPrefix="pages.monitoring"
  />
);

export default MonitoringPage;
