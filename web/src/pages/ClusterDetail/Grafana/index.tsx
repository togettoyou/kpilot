import { useParams } from '@umijs/max';
import React from 'react';

import GrafanaEmbed from '@/components/GrafanaEmbed';

// /clusters/:id/grafana — escape hatch into the bundled Grafana
// instance. The two curated pages above (Monitoring / Logging) draw
// their own panels off VictoriaMetrics / VictoriaLogs and don't go
// through Grafana at all. This page exists for the case where an
// operator wants to author their own dashboard, run an ad-hoc PromQL
// query, or browse the upstream Grafana docs UI.
//
// The chart's auth.proxy is wired to hand the KPilot session in as
// the `Admin` role (see pkg/server/api/handler/proxy.go), so the
// operator lands inside Grafana with full edit permissions.
const GrafanaPage: React.FC = () => {
  const { id: clusterId } = useParams<{ id: string }>();
  if (!clusterId) return null;
  return (
    <GrafanaEmbed
      required={['grafana']}
      recommended={[]}
      // Pass an empty UID — GrafanaEmbed treats that as "land on the
      // Grafana home page" instead of forwarding to a specific
      // dashboard. The operator navigates from there.
      dashboardUID=""
      i18nPrefix="pages.grafana"
    />
  );
};

export default GrafanaPage;
