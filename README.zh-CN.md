# KPilot

**Kubernetes 上的 GPU + 模型一体化平台。**

[English](README.md) · [中文](README.zh-CN.md)

---

## 什么是 KPilot

KPilot 是面向 Kubernetes 上 GPU 工作负载的控制面。集群运维、基于 Volcano 的批量调度、vGPU 治理、硬件遥测、插件生命周期、模型服务，全部在一个控制台中管理，共享一致的权限与审计层。

多集群是默认能力 —— 一个 KPilot Server 纳管多个集群，由集群内 Worker 主动通过 gRPC 回连。集群侧无需开放入站端口、无需共享 kubeconfig、无需为不同云做差异化适配。

## 使用场景

- **多集群 GPU 运维** —— 平台团队跨 VPC、跨 Region、跨云管理多个集群，不需要协商网络策略。
- **GPU 共享租户** —— 把每张物理卡切成 vGPU 切片，通过 Volcano 队列以 capability / guarantee / deserved 策略治理分配。
- **GPU 用量计量** —— 从 DCGM 原始采样直接产出按节点 / 按卡的 GPU-Hour 报告，并在同一界面深入排查热点。
- **自助式 AI 平台** *(规划中)* —— 业务团队从模型目录一键部署推理端点、提交分布式微调任务，无需手写 YAML。

## 核心功能

### 集群管理
- 单 Token 一次性纳管，无需共享 kubeconfig
- 节点与工作负载实时浏览，覆盖原生与自定义资源
- 浏览器直接调取 Pod 日志、终端、按容器查看 CPU / 内存即时指标
- 内置 YAML 编辑器，对任意资源执行 apply / describe / delete

### 算力调度
- 基于 Volcano 的 gang scheduling，覆盖 Queue / Job / CronJob / PodGroup / HyperNode
- 借助 volcano-vgpu-device-plugin 实现 GPU 精细切片（按显存槽位、显存量、SM 算力）
- 多资源队列配额可视化（capability / guarantee / allocated / deserved 四维拆解）
- 调度策略可视化编辑器 —— actions、tier、plugin 参数全字段提示

### GPU 可观测性
- 物理卡级面板：利用率、温度、功耗、显存、SM 频率、Tensor 活动
- 基于 DCGM 的 GPU-Hour 用量报告，支持 1h / 24h / 7d / 30d 窗口
- DCGM XID、ECC、温度、显存压力四类告警一站汇聚
- vGPU 视图按物理卡列出当前持有切片的所有 Pod

### 插件管理
- 内置 Helm 注册表 —— Volcano、DCGM Exporter、VictoriaMetrics、VictoriaLogs、Grafana、Metrics Server、kube-state-metrics 开箱即用
- 按集群启用 / 禁用 / 升级，安装日志实时流回 UI
- 支持自定义 chart，按集群覆盖 values
- KPilot 自身的可观测性栈即由这条插件流水线启动

## 架构

<p align="center">
  <img src="docs/assets/architecture.zh.svg" alt="KPilot 架构（C4 容器视图）" width="820">
</p>

**Server** 持有 UI、API 与持久化状态（集群注册表、插件元数据、账号）。它**不保管任何 kubeconfig**，所有运行时资源读写均由 Worker 代理。

**Worker** 作为 Operator 部署在每个被纳管的集群中，通过单条长连 gRPC 流回连 Server 并代为执行 Kubernetes 操作。这一模型消除了集群侧的入站网络要求，并屏蔽跨云拓扑差异。

插件以 Helm chart 形态分发，通过集群内 CRD 协调，Helm SDK 在集群的 RBAC 上下文中执行。

## 演进路线 —— 模型服务

后续版本规划：

- 模型仓库，内置 Qwen / DeepSeek / Llama 等开源权重的 vLLM 启动模板
- 一键部署推理服务，附带 chat 调试面板
- OpenAI 兼容路由，支持灰度与 A/B 控制
- 基于 Volcano gang scheduling 的分布式 fine-tune

## 快速开始

`deploy/chart/` 下的 Helm chart 可部署 Server、Worker 或两者。
镜像发布在 `ghcr.io/togettoyou/kpilot-{server,worker}`。

### 1. 部署 Server（控制面集群）

```bash
helm dependency build deploy/chart
helm install kpilot deploy/chart \
  --namespace kpilot-system --create-namespace \
  --set server.admin.password='<请替换>'
```

这一步会启动 Server、内置 Bitnami PostgreSQL，并暴露两个 ClusterIP
Service（`kpilot-server` HTTP、`kpilot-server-grpc`）。打开 UI：

```bash
kubectl -n kpilot-system port-forward svc/kpilot-server 8080:80
open http://localhost:8080
```

默认管理员账号：`kpilot` + 上一步设置的密码。生产部署时请设
`server.ingress.enabled=true`，gRPC Service 改用 LoadBalancer 或支持
gRPC 的 Ingress 暴露。

### 2. 部署 Worker（每个被纳管集群一次）

在 Server UI 创建集群条目，会展示一次性 ClusterToken。复制后：

```bash
helm install kpilot-worker deploy/chart \
  --namespace kpilot-system --create-namespace \
  --set server.enabled=false \
  --set worker.enabled=true \
  --set postgresql.enabled=false \
  --set worker.serverAddr='kpilot.example.com:9090' \
  --set worker.clusterToken='<粘贴 token>'
```

数秒后该集群在 UI 中的状态会翻 Online。升级、卸载、对接外部
Postgres 的细节见 [`deploy/README.md`](deploy/README.md)。
