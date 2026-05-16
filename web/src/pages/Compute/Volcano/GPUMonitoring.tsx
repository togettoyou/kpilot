import React from 'react';

import GrafanaEmbed from '@/components/GrafanaEmbed';

// Physical GPU monitoring page. Sister to /compute/:id/vgpu — that
// page reads Volcano vGPU annotations to show slice allocation; this
// page reads DCGM Exporter counters to show hardware-level health
// (utilization, temperature, power, framebuffer mem, SM clock, tensor
// activity).
//
// All the iframe / scroll / theme / dep-check machinery is in
// GrafanaEmbed; this page just supplies the GPU-monitoring config:
// the three required builtins (visualization + metrics pipeline + DCGM
// exporter) and the dashboard UID baked into the bundled JSON at
// pkg/server/dashboards/builtin/nvidia-dcgm.json.
const GPUMonitoringPage: React.FC = () => (
  <GrafanaEmbed
    required={['grafana', 'victoria-metrics', 'dcgm-exporter']}
    recommended={[]}
    dashboardUID="Oxed_c6Wz"
    i18nPrefix="pages.gpuMonitoring"
  />
);

export default GPUMonitoringPage;
