import React from 'react';

import GrafanaEmbed from '@/components/GrafanaEmbed';

// Mirror of MonitoringPage with the logging-specific deps and dashboard.
// Required: grafana (UI) + victoria-logs (storage). Grafana itself is
// where the VictoriaLogs datasource plugin runs; the user enables both
// from the cluster's plugin page and we land on the Explorer dashboard.
const LoggingPage: React.FC = () => (
  <GrafanaEmbed
    required={['grafana', 'victoria-logs']}
    recommended={[]}
    // UID baked into the upstream VictoriaLogs Explorer K8S (pods) JSON
    // at pkg/server/dashboards/builtin/victoria-logs-explorer.json.
    dashboardUID="g6mvjz"
    i18nPrefix="pages.logging"
  />
);

export default LoggingPage;
