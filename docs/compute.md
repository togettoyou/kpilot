# 算力调度（`/compute`）

> 上层文档：[CLAUDE.md](../CLAUDE.md)。本文档覆盖基于 Volcano 的批量调度平台。

KPilot 的算力调度平台 = **Volcano 批量调度** 为核心，AI / HPC 作业编排为目标，不是 GPU 监控仪表盘。

三层能力：

1. **作业调度层**（已实现）：Volcano Queue / Job / CronJob / PodGroup / HyperNode 的 CR 浏览 + 类型化表单创建编辑 + 生命周期操作；`volcano-scheduler-configmap` 可视化编辑器
2. **GPU 虚拟化层**（计划）：`volcano-vgpu-device-plugin`（Volcano scheduler 的 deviceshare 后端，使用 HAMi-core 做 hard isolation）提供 vGPU 切分、显存 / 算力限制；KPilot 不再独立部署 HAMi
3. **治理层**（远期）：Volcano queue 配额视图 + 设备健康告警 + GPU-Hour 计费

依赖插件：**Volcano**（必需）。GPU 节点上额外需要 `volcano-vgpu-device-plugin`（v1 还没做成内置）。

## 1. 集群选择（`/compute`）

- 顶级 landing 页，集群卡片网格，点击卡片进入算力调度面板（落到 `/scheduler`，平台首屏）
- 不提供集群 CRUD 操作。集群的增删改在「集群管理」完成；本页仅用于选择集群上下文
- `pages/Compute/index.tsx`

## 2. 调度策略（`/compute/:id/scheduler`）

`volcano-scheduler-configmap` 的可视化编辑器。用户进入算力调度后默认落地这一页。

- **数据来源**：从 Volcano 插件的 `default_release_namespace`（默认 `kpilot-scheduling`）拉 `volcano-scheduler-configmap`，解析 `data."volcano-scheduler.conf"` 为 YAML
- **默认只读**：进入页面时表单 Select 全部 disabled、YAML 编辑器 readOnly。右上角 toolbar 是「刷新」+「编辑」
- **编辑模式**：点「编辑」后右上角换成「取消」+「保存」；表单解锁、YAML 可改；取消恢复到上次拉取快照
- **双视图**：
  - **表单**：actions 多选 + tier 卡片，每张 tier 卡里再多选 plugins，添加 / 删除 tier 都有按钮
  - **YAML**：完整 conf 可编辑（plugin args 等高级字段必须从这里改，表单层不暴露）
  - 切换 tab 自动同步：form → yaml 用 `yaml.dump(draft)`，yaml → form 用 `yaml.load(text)` + 同步回 draft
  - YAML 解析失败时不切换、不丢草稿，inline Alert 提示错误
- **保存**：构建新的 ConfigMap manifest（保留其它 data key 如 `volcano-admission.conf`），走 `/apply` SSA 写回。Volcano 调度器 watch configmap，秒级自动 reload
- **新手友好**：
  - 顶部 intro 段说明 actions vs plugin tiers 的概念
  - Select 下拉每一项都带 1 行说明（label + 灰色 desc 双行展示），已选 Tag hover 也显示 desc
  - 卡片标题旁有 ⓘ 图标 hover 看进阶提示
  - 顶部 Collapse 折叠面板「调度阶段一览 / 调度插件一览」列出所有内置 actions / plugins 中文一句话解说，做为快速查阅手册
- **Volcano 内置 actions / plugins 元数据**：维护在 `pages/Compute/Volcano/schedulerMeta.ts`。覆盖 6 个 actions（enqueue / allocate / preempt / reclaim / backfill / shuffle）+ 18 个 plugins。未识别的名字 fallback 到「自定义 plugin」描述，自定义集群不会破页面

## 3. Volcano CR 浏览器（5 个）

每个 CR 一个独立路由，菜单分组在 sider 的「调度资源」下：

| 路由 | Kind | 范围 | GUI 操作 |
|---|---|---|---|
| `/compute/:id/queues` | `scheduling.volcano.sh/v1beta1 Queue` | Cluster | 创建 / 编辑表单 + Open/Close（bus.volcano.sh Command） |
| `/compute/:id/jobs` | `batch.volcano.sh/v1alpha1 Job` | Namespaced | 多任务创建 / 编辑表单 + Resume/Abort/Restart/Complete/Terminate（Command） |
| `/compute/:id/cronjobs` | `batch.volcano.sh/v1alpha1 CronJob` | Namespaced | 创建 / 编辑表单 + Suspend/Resume（直接 SSA patch `spec.suspend`） |
| `/compute/:id/podgroups` | `scheduling.volcano.sh/v1beta1 PodGroup` | Namespaced | 仅通用 CR 浏览 + YAML 编辑 |
| `/compute/:id/hypernodes` | `topology.volcano.sh/v1alpha1 HyperNode` | Cluster | 仅通用 CR 浏览 + YAML 编辑 |

### 3.1 通用机制

- **专用列表端点**：每种 CR 一个 server handler（`pkg/server/api/handler/volcano.go`），通过 worker 的 `list-full` action 一次取齐 spec + status，server 端把字段投影成 slim row JSON 下发前端。**100 个 Queue 渲染 = 1 个 HTTP 请求**——不再是「1 list + 100 GET」N+1 模式
- **Worker `list-full` action**（`pkg/worker/proxy/proxy.go::listFull`）：与通用 K8s Table API 路径并存，dynamic.List 返回完整对象。按需添加新 GVK 时只需在 server 端加 handler，worker 不动
- **页面结构**：所有 5 个页都直接渲染 `<ProTable>`（不再包 `WorkloadsContent`），列定义按 kind 单独写，cell 全部 props-driven 纯渲染（无 per-row fetch）。共享 helper 在 `pages/Compute/Volcano/shared/Layout.tsx`：`<NotInstalled>`、`useAutoRefresh`、`<RefreshControl>`、`formatAge`
- **错误兜底**：list 端点在 CRD 不存在时返回 `404 / RESOURCE_NOT_AVAILABLE`，页面切换为 `<NotInstalled>` 显示「集群尚未安装 Volcano，前往插件管理」
- **NamespacePicker**：顶部命名空间选择器识别 `/compute/:id/{jobs,cronjobs,podgroups}` namespaced 路径，cluster-scoped 的 queues / hypernodes / scheduler 自动隐藏（见 `components/NamespacePicker/index.tsx::COMPUTE_NAMESPACED_KINDS`）。namespaced 页面通过 `useModel('namespace')` 读取选中的 ns 加到 list 请求 query
- **写操作**：edit / delete 仍走通用 `/workloads/_cr` PUT/DELETE（带 GVK query），form drawer 走 `/apply` SSA。Volcano CR 写保护与 K8s 通用工作负载共用同一套 backend 检查

### 3.2 表单 drawer（Queue / Job / CronJob）

每个表单都遵循相同的双视图模式（跟 scheduler 编辑器一致）：

- **创建 vs 编辑**：同一个 drawer，靠 `editing?: { name, namespace? }` prop 区分。编辑模式下：fetch 现有资源、回填表单、name + namespace 输入框 disabled（K8s 不允许改名）
- **表单 ↔ YAML 双视图**：Tabs 切换。两个视图共享同一份 draft：
  - 表单 → YAML：`buildXxxManifest(fvToInput(formValues))` → `yaml.dump`
  - YAML → 表单：`yaml.load` → `formValuesFromManifest`（每个表单各自实现一份提取器）
  - 切换失败（YAML 解析错）显示 inline Alert，保留草稿
- **提交**：依据当前激活 view —— 表单走 validateFields + buildManifest，YAML 走原始 yaml.load。两条路最后都走 `/apply` SSA
- **特定字段处理**：
  - **Queue**：`weight` / `reclaimable` / `parent` / `capability`（cpu / memory / `volcano.sh/vgpu-{number,memory,cores}`）。capability 字段对应 `volcano-vgpu-device-plugin` 资源标签
  - **Job**：基础信息（name / namespace / queue / priorityClassName）+ `minAvailable`（gang）+ plugins 多选（env/svc/ssh/mpi/pytorch/tensorflow，args 默认空）+ tasks 列表（每个 task：image / command / args / replicas / restartPolicy / 资源请求 cpu+memory+vgpu-*）
  - **CronJob**：Job 全部字段 + cron schedule + concurrencyPolicy + history limits + suspend
- **未在表单暴露的字段**（如 tolerations / affinity / 多容器 task / plugin 自定义 args）：用户切到 YAML 视图自己写。表单的 round-trip preserve 这些字段（`extractTasks` 等只读取已知字段，YAML 解析时整体保留）

### 3.3 生命周期操作（lifecycle）

Volcano 提供两套机制：

- **`bus.volcano.sh/v1alpha1 Command` CR**：drop 一条 Command 指 target，Volcano 控制器消费并删除。用于：
  - Queue: `OpenQueue` / `CloseQueue`
  - Job: `ResumeJob` / `AbortJob` / `RestartJob` / `CompleteJob` / `TerminateJob`
- **直接 SSA patch**：CronJob 的暂停 / 恢复改 `spec.suspend` 即可，不需要 Command 机制

服务函数 `services/kpilot/volcano.ts::sendCommand` 和 `applyManifest` 都走 `/api/v1/clusters/:id/apply` 端点（同款 SSA 路径）。

### 3.4 schedulerName

所有 Volcano Job 创建时的 task podSpec 自动注入 `schedulerName: 'volcano'`（见 `services/kpilot/volcano.ts::buildJobManifest`）。手写 YAML 的用户也得记得加，否则会被 default-scheduler 接管，绕过 Volcano 调度策略。

## 4. 路由 + 菜单结构

```
算力调度 (/compute)
├── 调度策略 (/compute/:id/scheduler)              ← 默认首屏
└── 调度资源 (group)
    ├── Queue       (/compute/:id/queues)
    ├── Job         (/compute/:id/jobs)
    ├── CronJob     (/compute/:id/cronjobs)
    ├── PodGroup    (/compute/:id/podgroups)
    └── HyperNode   (/compute/:id/hypernodes)
```

`/compute/:id` redirect 到 `/scheduler`。`/compute/:id/overview`（旧 GPU 仪表盘路径）也 redirect 到 `/scheduler`，避免老书签 404。

## 5. 历史 / 迁移

- **pre-Volcano-pivot**：使用独立 HAMi 部署 + `pkg/worker/proxy/gpu.go` 解析 `hami.io/*` annotation + 单页 GPU 仪表盘（`pages/Compute/Overview/`）。该路径已**全量删除**：parser、handler、informer 缓存、useGPUData hook、DepGate、CardBody、format.ts、locale 字符串都清理干净
- **当前**：算力调度 = Volcano 批量调度。GPU 视图缺失（`vgpu-device-plugin` 内置 + 仪表盘是后续 P2）
- **集群里既存的 HAMi Helm release**：KPilot 不会主动卸载，但 KPilot 内置插件注册表已没有 HAMi 行，新集群也不会再装 HAMi。用户想切换到 Volcano vGPU：手动 `helm uninstall hami`，然后 `kubectl apply -f volcano-vgpu-device-plugin.yml`（上游 YAML，没有 Helm chart）

## 6. 后续路线

| 阶段 | 内容 |
|---|---|
| P2 | volcano-vgpu-device-plugin 包成 wrapper Helm chart（go:embed）作为内置 + 重新激活 vGPU dashboard 子页 |
| P3 | DCGM Exporter 内置插件 + Grafana NVIDIA DCGM dashboard 嵌入 |
| P4 | Volcano queue 配额可视化 + 设备健康告警 + GPU-Hour 计费报表 |
