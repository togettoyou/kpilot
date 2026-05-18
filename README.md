# KPilot

**Unified GPU + model platform for Kubernetes.**

[English](README.md) · [中文](README.zh-CN.md)

<p align="center">
  <a href="https://github.com/togettoyou/kpilot/blob/main/LICENSE"><img src="https://img.shields.io/github/license/togettoyou/kpilot?style=flat-square" alt="License"></a>
  <a href="https://github.com/togettoyou/kpilot/stargazers"><img src="https://img.shields.io/github/stars/togettoyou/kpilot?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/togettoyou/kpilot/commits/main"><img src="https://img.shields.io/github/last-commit/togettoyou/kpilot?style=flat-square" alt="Last commit"></a>
  <img src="https://img.shields.io/badge/helm-0.0.0--dev-blue?style=flat-square" alt="Helm chart">
</p>

---

## What is KPilot

KPilot is a control plane for running GPU workloads on Kubernetes. Cluster operations, Volcano-based batch scheduling, vGPU governance, hardware telemetry, plugin lifecycle, and model serving live behind one console with a consistent permission and audit surface.

Multi-cluster is the default — a single KPilot Server manages many clusters, with the in-cluster agent dialing back over gRPC. No inbound ports on the cluster side, no shared kubeconfigs, no per-cloud divergence.

## Why KPilot

- **One reverse-connecting gRPC stream per cluster.** Worker dials Server outbound; no inbound ports on the cluster, no kubeconfig leaves it. The same stream multiplexes K8s API proxying, Helm chart blobs, Pod logs / exec, and HTTP / WebSocket reverse-proxy for embedded UIs (Grafana, VictoriaMetrics).

- **Chunked transport, gzip-compressed, fair-queued.** Large payloads (chart .tgz, describe output, log tail) are sliced into ≤256 KiB frames and gzip-compressed at the gRPC stream level (5–8× shrink on JSON). The per-stream sender drains a Heartbeat fast lane first, then round-robin schedules across per-request sub-queues, so a 20 MiB log response can't head-of-line block a concurrent `/workloads/nodes` call. Liveness rides on HTTP/2 keepalive PINGs, decoupled from application heartbeats.

- **Deep Volcano integration.** 10 CR browsers, 7 typed authoring forms, and a visual scheduler-policy editor covering every Volcano action / tier / plugin parameter. vGPU slices are parsed from device-plugin annotations and rendered card-by-card with the Pods currently holding them.

- **In-app dashboards, Grafana for ad-hoc work.** Cluster / GPU monitoring, log search (virtualized list + histogram), queue-quota bars, and vGPU panels render in-app against VictoriaMetrics / VictoriaLogs / DCGM directly. Grafana stays one route away for ad-hoc PromQL.

## Architecture

<p align="center">
  <img src="docs/assets/architecture.en.svg" alt="KPilot architecture (C4 container diagram)" width="820">
</p>

**Server** owns the UI, API, and durable state (cluster registry, plugin metadata, accounts) but holds no kubeconfigs. **Worker** runs inside each managed cluster, dials the Server over a single long-lived gRPC stream, and brokers every Kubernetes operation on its behalf — no inbound ports, no shared credentials, no cross-cloud divergence. Plugins ship as Helm charts and reconcile via an in-cluster CRD, executing in the cluster's own RBAC context.

## Quick Start

**Install the Server** (control-plane cluster):

```bash
helm install kpilot oci://ghcr.io/togettoyou/charts/kpilot \
  --version 0.0.0-dev \
  --namespace kpilot-system --create-namespace \
  --set server.admin.password='<change-me>'
```

Port-forward the UI and log in with `kpilot` / `<your password>`:

```bash
kubectl -n kpilot-system port-forward svc/kpilot-server 8080:80
open http://localhost:8080
```

**Install the Worker** (each managed cluster). Create a cluster row in the UI, copy the one-time ClusterToken, then:

```bash
helm install kpilot-worker oci://ghcr.io/togettoyou/charts/kpilot \
  --version 0.0.0-dev \
  --namespace kpilot-system --create-namespace \
  --set server.enabled=false,worker.enabled=true,postgresql.enabled=false \
  --set worker.serverAddr='kpilot-server-grpc.kpilot-system.svc:9090' \
  --set worker.clusterToken='<paste-token>'
```

The cluster row in the Server UI transitions to Online within a few seconds. Production exposure (Ingress, external Postgres, image registry mirrors) is covered in [`deploy/README.md`](deploy/README.md).

## Use Cases

- **Multi-cluster GPU operations** — run a single platform team across clusters in different VPCs, regions, or clouds without touching network policies.
- **Shared GPU tenancy** — partition each card into vGPU slices and govern allocation through Volcano queues with explicit capability / guarantee / deserved policies.
- **GPU usage metering** — produce GPU-Hour reports per node and per card straight from DCGM, then drill into hotspots from the same UI.
- **Self-service AI platform** *(roadmap)* — let teams deploy inference endpoints from a model catalog and run distributed fine-tuning without writing YAML.

## Key Features

| | |
|---|---|
| **Cluster Management**<ul><li>Multi-cluster onboarding via a single-use token; no kubeconfig sharing</li><li>Live node and workload browser covering native and custom resources</li><li>In-browser Pod logs, terminal, and per-container CPU / memory metrics</li><li>Inline YAML editor with apply / describe / delete for any resource</li></ul> | **Compute Scheduling**<ul><li>Volcano gang scheduling across Queue, Job, CronJob, PodGroup, HyperNode</li><li>Fine-grained GPU sharing via volcano-vgpu-device-plugin (slot / framebuffer / SM cores)</li><li>Multi-resource queue quotas with capability, guarantee, allocated, and deserved views</li><li>Visual scheduler-policy editor for actions, tiers, and plugin parameters</li></ul> |
| **GPU Observability**<ul><li>Per-card panels for utilization, temperature, power, framebuffer, SM clock, tensor activity</li><li>DCGM-driven GPU-Hour usage reports across 1h / 24h / 7d / 30d windows</li><li>Alerting on DCGM XID, ECC, thermal, and framebuffer-pressure conditions</li><li>vGPU view mapping every physical card to its current slice holders</li></ul> | **Plugin Management**<ul><li>Built-in Helm registry covering Volcano, DCGM Exporter, VictoriaMetrics, VictoriaLogs, Grafana, Metrics Server, kube-state-metrics</li><li>Per-cluster enable / disable / upgrade with the install log streamed live</li><li>Bring-your-own charts with per-cluster values overrides</li><li>The same plugin pipeline that powers customer workloads also bootstraps KPilot's own observability stack</li></ul> |

## Screenshots

### Cluster Management — [`docs/clusters.md`](docs/clusters.md)

<table width="100%">
<tr>
<td width="50%"><img src="docs/assets/screenshots/pod.png" alt="Pod browser with live logs and terminal" width="480"></td>
<td width="50%"><img src="docs/assets/screenshots/vm.png" alt="Self-rendered cluster monitoring" width="480"></td>
</tr>
<tr>
<td width="50%"><img src="docs/assets/screenshots/vmlogs.png" alt="Cluster logging" width="480"></td>
<td width="50%"><img src="docs/assets/screenshots/grafana.png" alt="Embedded Grafana escape hatch" width="480"></td>
</tr>
</table>

### Compute Scheduling — [`docs/compute.md`](docs/compute.md)

<table width="100%">
<tr>
<td width="50%"><img src="docs/assets/screenshots/scheduler-config.png" alt="Visual scheduler policy editor" width="480"></td>
<td width="50%"><img src="docs/assets/screenshots/scheduler-queue.png" alt="Queue quotas" width="480"></td>
</tr>
<tr>
<td width="50%"><img src="docs/assets/screenshots/gpu.png" alt="vGPU view" width="480"></td>
<td width="50%"><img src="docs/assets/screenshots/volcano-job.png" alt="Volcano Job authoring" width="480"></td>
</tr>
</table>

### Plugin Management — [`docs/plugins.md`](docs/plugins.md)

<table width="100%">
<tr>
<td width="50%"><img src="docs/assets/screenshots/plugin-admin.png" alt="Plugin admin" width="480"></td>
<td width="50%"><img src="docs/assets/screenshots/plugin.png" alt="Plugin install" width="480"></td>
</tr>
</table>

## Roadmap — Model Serving

Coming in upcoming releases:

- Model repository with curated vLLM templates for Qwen, DeepSeek, Llama, and other open-weights families
- One-click inference deployment with a built-in chat playground
- OpenAI-compatible routing with canary and A/B controls
- Distributed fine-tuning on Volcano gang scheduling
