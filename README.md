# KPilot

**Unified control plane for multi-cluster Kubernetes management, GPU compute scheduling, and model serving.**

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

Multi-cluster is the default — a single KPilot Server manages many clusters, with the in-cluster agent dialing back over a single TCP+TLS connection. No inbound ports on the cluster side, no shared kubeconfigs, no per-cloud divergence.

## Why KPilot

- **Zero inbound ports; kubeconfigs never leave the cluster.** Worker dials Server outbound over a single multiplexed TCP+TLS channel — every K8s API call, Helm install, Pod log / exec session, embedded-UI reverse proxy (Grafana, VictoriaMetrics), and inference SSE stream concurrently shares the connection without head-of-line blocking. See [`docs/transport-v2.md`](docs/transport-v2.md) for the architecture record.

- **GPU + Volcano as one integrated platform.** Volcano gang scheduling across 10 CR kinds with 7 typed authoring forms and a visual scheduler-policy editor; vGPU device-plugin slicing (slot / framebuffer / SM cores) parsed per-card with the Pods currently holding each slice; DCGM-driven GPU-Hour usage reports across 1h / 24h / 7d / 30d windows plus alerts on XID, ECC, thermal, and framebuffer pressure — one console for who scheduled it, who's using it, and whether the hardware is healthy.

- **In-app model serving from catalog to API.** One-click deploy curated open-weights LLMs (Qwen3, DeepSeek-R1, Llama-4, Mistral, Phi-4, GLM-5.1, Gemma-4, Kimi-K2.6 — all on vLLM by default) to any managed cluster with vGPU resource shaping, debug each instance through the in-browser chat playground, then mint scoped OpenAI-compatible Bearer keys for application teams. No separate model-serving stack to operate.

- **Plugin-first platform.** KPilot's own observability stack — VictoriaMetrics, VictoriaLogs, Grafana, DCGM Exporter, Metrics Server, kube-state-metrics — ships through the same built-in Helm registry operators use to install arbitrary customer charts. Per-cluster enable / disable / upgrade from the UI with the install log streamed live; per-cluster values overrides; bring your own charts the same way.

## Architecture

<p align="center">
  <img src="docs/assets/architecture.en.svg" alt="KPilot architecture (C4 container diagram)" width="820">
</p>

**Server** owns the UI, API, and durable state (cluster registry, plugin metadata, accounts, API keys, model templates) but holds no kubeconfigs. **Worker** runs inside each managed cluster, dials the Server over a single long-lived multiplexed TCP+TLS channel, and brokers every Kubernetes operation on its behalf — no inbound ports, no shared credentials, no cross-cloud divergence. Plugins ship as Helm charts and reconcile via an in-cluster CRD, executing in the cluster's own RBAC context.

## Quick Start

**Server + local Worker in one shot** (the common "manage the cluster you're installing into" path):

```bash
helm install kpilot oci://ghcr.io/togettoyou/charts/kpilot \
  --version 0.0.0-dev \
  --namespace kpilot-system --create-namespace \
  --set server.admin.password='<change-me>' \
  --set worker.enabled=true
```

The chart auto-generates a shared bootstrap token, points the Worker at the in-cluster transport Service, and the Server registers a cluster row named `local` on first start. No need to click through the UI to mint a token — the cluster shows up Online within a few seconds.

Port-forward the UI and log in with `kpilot` / `<your password>`:

```bash
kubectl -n kpilot-system port-forward svc/kpilot-server 8080:80
open http://localhost:8080
```

**Optional: add a remote managed cluster** (one per cluster). Create a cluster row in the UI, copy the one-time ClusterToken, then on the target cluster:

```bash
helm install kpilot-worker oci://ghcr.io/togettoyou/charts/kpilot \
  --version 0.0.0-dev \
  --namespace kpilot-system --create-namespace \
  --set server.enabled=false,worker.enabled=true,postgresql.enabled=false \
  --set worker.serverAddr='<Server transport external addr>:9090' \
  --set worker.clusterToken='<paste-token>'
```

Production exposure (Ingress, external Postgres, image registry mirrors) is covered in [`deploy/README.md`](deploy/README.md).

## Use Cases

- **Multi-cluster GPU operations** — run a single platform team across clusters in different VPCs, regions, or clouds without touching network policies.
- **Shared GPU tenancy** — partition each card into vGPU slices and govern allocation through Volcano queues with explicit capability / guarantee / deserved policies.
- **GPU usage metering** — produce GPU-Hour reports per node and per card straight from DCGM, then drill into hotspots from the same UI.
- **Self-service AI inference** — let teams deploy curated open-weights models from the catalog (Qwen3, DeepSeek, Llama-4, …) to any managed cluster in seconds, debug via the in-browser chat, and hand out scoped OpenAI-compatible Bearer keys to application teams.

## Key Features

| | |
|---|---|
| **Cluster Management**<ul><li>Multi-cluster onboarding via a single-use token; no kubeconfig sharing</li><li>Live node and workload browser covering native and custom resources</li><li>In-browser Pod logs, terminal, and per-container CPU / memory metrics</li><li>Inline YAML editor with apply / describe / delete for any resource</li></ul> | **Compute Scheduling**<ul><li>Volcano gang scheduling across Queue, Job, CronJob, PodGroup, HyperNode</li><li>Fine-grained GPU sharing via volcano-vgpu-device-plugin (slot / framebuffer / SM cores)</li><li>Multi-resource queue quotas with capability, guarantee, allocated, and deserved views</li><li>Visual scheduler-policy editor for actions, tiers, and plugin parameters</li></ul> |
| **GPU Observability**<ul><li>Per-card panels for utilization, temperature, power, framebuffer, SM clock, tensor activity</li><li>DCGM-driven GPU-Hour usage reports across 1h / 24h / 7d / 30d windows</li><li>Alerting on DCGM XID, ECC, thermal, and framebuffer-pressure conditions</li><li>vGPU view mapping every physical card to its current slice holders</li></ul> | **Plugin Management**<ul><li>Built-in Helm registry covering Volcano, DCGM Exporter, VictoriaMetrics, VictoriaLogs, Grafana, Metrics Server, kube-state-metrics</li><li>Per-cluster enable / disable / upgrade with the install log streamed live</li><li>Bring-your-own charts with per-cluster values overrides</li><li>The same plugin pipeline that powers customer workloads also bootstraps KPilot's own observability stack</li></ul> |
| **Model Serving**<ul><li>Curated catalog: Qwen3-0.6B/8B/14B/32B-Instruct, Qwen3-30B-A3B (MoE), DeepSeek-R1, Llama-4-Scout-17B-16E (MoE), Mistral-Small-3.2-24B, Phi-4, GLM-5.1, Gemma-4-31B, Kimi-K2.6 — all on vLLM by default</li><li>One-click deploy to any managed cluster with `nvidia.com/gpu` or Volcano vGPU resource shaping, HF token injected via Secret + envFrom, PVC heuristically sized per model</li><li>Cross-cluster ProTable of running instances with per-row chat / Describe / Delete</li><li>In-browser chat playground for smoke testing — picks any deployed instance via grouped Select</li></ul> | **OpenAI-Compatible Gateway**<ul><li>Per-deployment Bearer keys (`kp-sk-…`, sha256-hashed at rest, shown once at creation)</li><li>End-to-end SSE streaming — vLLM `stream: true` tokens reach the SDK live; browser Stop kills the upstream sub-second via yamux FIN cascade</li><li>Two-stage scope picker (cluster → deployment) at key creation prevents scope drift</li><li>Soft revoke (preserve audit row) + hard delete row actions</li></ul> |

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

### Model Serving — [`docs/models.md`](docs/models.md)

Curated catalog → one-click deploy → in-browser chat → OpenAI-compatible reverse-proxy with per-deployment Bearer keys. End-to-end SSE streaming over the yamux transport; browser Stop cascades through to the upstream sub-second.

### Plugin Management — [`docs/plugins.md`](docs/plugins.md)

<table width="100%">
<tr>
<td width="50%"><img src="docs/assets/screenshots/plugin-admin.png" alt="Plugin admin" width="480"></td>
<td width="50%"><img src="docs/assets/screenshots/plugin.png" alt="Plugin install" width="480"></td>
</tr>
</table>
