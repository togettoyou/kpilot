# 算力调度（`/compute`）

> 上层文档：[CLAUDE.md](../CLAUDE.md)。本文档覆盖基于 Volcano 的批量调度平台。

KPilot 的算力调度平台 = **Volcano 批量调度** 为核心，AI / HPC 作业编排为目标。

三层能力：

1. **作业调度层**（已实现）：Volcano 全套 CR（Queue / Job / CronJob / PodGroup / HyperNode / JobFlow / JobTemplate / Numatopology / NodeShard / ColocationConfiguration）的浏览 + 编辑（7 个 CR 走类型化表单 / JobFlow + JobTemplate 走 YAML-only / Numatopology 只读）+ 生命周期操作；`volcano-scheduler-configmap` 可视化编辑器；集群级 Volcano dashboard
2. **GPU 虚拟化层**（已实现）：`volcano-vgpu-device-plugin`（HAMi-core fork，Volcano scheduler 的 deviceshare 后端）打包为内置 chart，集群级 vGPU snapshot 页（每节点 → 每卡 → 占用 Pod）
3. **治理层**（远期）：Volcano queue 配额视图 + 设备健康告警 + GPU-Hour 计费

依赖插件：**Volcano**（必需，调度核心）+ **volcano-vgpu-device-plugin**（GPU 节点用，KPilot 内置）。

## 1. 集群选择（`/compute`）

- 顶级 landing 页，集群卡片网格，点击卡片进入算力调度面板
- 默认落地 **`/compute/:id/overview`**（Volcano dashboard）
- 不提供集群 CRUD 操作；本页仅用于选择集群上下文
- `pages/Compute/index.tsx`

## 2. Volcano Dashboard（`/compute/:id/overview`）

首屏。集群级 Volcano 健康度 + 资源情况一览：

- **KPI 卡片**：Queues / Running Jobs / Pending Jobs / Failed Jobs / CronJobs / PodGroups / HyperNodes 数量 + GPU 节点数 + 总 vGPU 切片
- **容量水平条**：每个 Queue 的 capacity vs allocated（CPU / memory / vGPU 一行一资源），有界资源按利用率排序，无界资源按负载排序（`a8bd696`），无界视觉与有界明显区分（`63446a4`）
- **饼图 / 列表**：Job phase 分布（点击切片可跳 `/compute/:id/jobs?state=Running`，URL-driven 过滤）+ 最近失败 Job 列表 + Queue 层级树（cpu + memory 同时展示，`51fe1fb`）
- **数据合并**：先做 cluster-side `getVolcanoStatus` 探测（worker 探 Queue CRD + ConfigMap field selector），未装就 throw `RESOURCE_NOT_AVAILABLE`-shape 触发 `<NotInstalled>`；安装的话并行拉 6 个 list 端点 + scheduler configmap（`Promise.allSettled`，可选 sub-CRD 缺失自动降级成空桶，不让整个 dashboard fail）
- **依赖检测**：Volcano 集群侧未装 → `NotInstalled`；装了但 CR 为空 → 空 dashboard 而非错误。判定不依赖 kpilot 插件注册表（用户手 `kubectl apply` / `helm install` 装的 Volcano 也能识别）
- 文件：`Overview.tsx`（~620 行 page 框架）+ `OverviewCharts.tsx`（~1300 行图表 / 卡片组件）

## 3. 调度策略（`/compute/:id/scheduler`）

`volcano-scheduler-configmap` 的可视化编辑器。

- **数据来源**：cluster-side 探测（worker `getVolcanoStatus`，metadata.name 字段选择器全 ns 找 `volcano-scheduler-configmap`），不依赖 kpilot 插件注册表的 namespace。内置 Volcano 插件默认装在 `volcano-system`；KPilot 内置 Volcano chart 的默认 scheduler 配置已经把 `deviceshare` 启用并 `ScheduleWeight=10`（与 volcano-vgpu-device-plugin 配套），开箱即用
- **默认只读**：进入页面表单 Select 全部 disabled、YAML 编辑器 readOnly。右上角 toolbar 「刷新」+「编辑」
- **编辑模式**：点「编辑」后右上角换成「取消」+「保存」；取消恢复到上次拉取快照
- **双视图**：
  - **表单**：actions 多选 + tier 卡片，每张 tier 卡里再多选 plugins；plugin block 支持 typed args + 25 个 enable\* 高级开关 + 未知字段 key/value 编辑器（含 `arguments` 子键，`8859e7c`）
  - **YAML**：完整 conf 可编辑（plugin args 等高级字段从这里改）
  - 切换 tab 自动同步：form → yaml 用 `yaml.dump(draft)`，yaml → form 用 `yaml.load(text)` + 同步回 draft
  - YAML 解析失败时不切换、不丢草稿，inline Alert 提示错误
- **保存**：构建新 ConfigMap manifest（保留其它 data key 如 `volcano-admission.conf`），走 `/apply` SSA。Volcano 调度器 watch configmap，秒级自动 reload
- **新手友好**：顶部 intro + 各 Select 项带 desc 双行展示 + Tag hover 显示 desc + 卡片标题 ⓘ 进阶提示 + 顶部 Collapse 调度阶段一览 / 调度插件一览
- **流程图**：右上角图标打开 `<SchedulerFlowDiagram>` 抽屉，按当前 actions + plugin tiers 渲染只读 DAG（节点 = action，每个 action 节点列出会被它触发回调的当前已配置 plugin），用 `@ant-design/graphs` FlowGraph 懒加载
- **Volcano 内置 actions / plugins 元数据**：维护在 `pages/Compute/Volcano/schedulerMeta.ts`。覆盖 **6 个 actions**（enqueue / allocate / preempt / reclaim / backfill / shuffle）+ **24 个 plugins**（priority / gang / conformance / drf / proportion / predicates / nodeorder / binpack / overcommit / deviceshare / tdm / numa-aware / network-topology-aware / task-topology / usage / extender / capacity / resourcequota / pdb / cdp / sla / nodegroup / resource-strategy-fit / rescheduling）。每个 plugin 标 `callbacks: string[]`（25 个 enable\* 中实际会被该 plugin 注册的子集），未识别的 fallback 到「自定义 plugin」描述
- 历史 review 校对默认值（`93bcf96`）：5 个 plugin args 默认值与 Volcano 源码对齐（task-topology.weight / numa-aware.weight / deviceshare.ScheduleWeight / network-topology-aware.hypernode.binpack.normal-pod.{enable,fading}）

## 4. vGPU 视图（`/compute/:id/vgpu`）

集群级 Volcano vGPU 切分实况。

- **数据流**：worker `pkg/worker/proxy/vgpu.go::VGPUTracker` 解析每个 Node 的 `volcano.sh/node-vgpu-register` annotation（device-plugin 注册的物理卡清单）+ 每个 Pod 的 `volcano.sh/vgpu-ids-new` annotation（scheduler 写回的分配信息，UUID,Type,Usedmem,Usedcores 序列）→ 在内存里聚合成「cluster → node → card → pod」树，JSON 序列化 → Server REST `/api/v1/clusters/:id/vgpu` 透传给前端
- **endpoint 单一**：一个 endpoint 返回完整 snapshot（cluster KPI + 节点 + 卡 + Pod），前端切片渲染三视图。snapshot 用 `kubernetes.Interface` 直接 List Node + Pod，不走 RESTMapping（cluster-scoped 合成查询，proxy 端在 RESTMapping 之前路由）
- **空状态**：snapshot.nodes 为空 → server 返回 `404 RESOURCE_NOT_AVAILABLE`，前端走 `NotInstalled` 变体，文案指向 device-plugin 而非 Volcano 本体（`titleId/subTitleId/actionId` override，`5d34988`）
- **页面布局**（无 ResourceIntro、紧凑信息密度）：
  - **顶部 KPI 行（4 张卡）**：物理卡数（含型号 chip `A10 × N`）+ 三个 `Progress.dashboard` 环形仪表 —— 切片利用率 / 显存利用率（GiB）/ 算力利用率（cores，跨所有卡客户端聚合）。仪表配色按通用阈值（≥85% 红 / ≥60% 黄 / 其余绿）
  - **告警 banner**：snapshot 内任意卡 `health=false` → 顶部聚合 Alert "N 张卡（M 个节点）报告异常"
  - **空集群 CTA**：装了 vGPU 但 0 个 Pod 在用 → 引导卡 + 跳 `/compute/:id/jobs`
  - **节点列表（card-per-node，无展开）**：每节点一张 Card 默认全展开 —— 节点头部三段聚合 bar（slots / memory / cores）+ 节点下每张物理卡一行：身份（`#idx` + Health Tag + 尾截 UUID `…hhhhhhhh` 带 copy + sharing mode）+ 三根 bar + Pods 列表（按 `ns/name` 折叠 + `× N` 切片计数 + hover tooltip 显示 mem/cores 聚合）。点击 Pod 名打开 `<DescribeDrawer>`（vGPU 排查通常关心 annotation / 节点分配 / 调度结果，而不是 stdout 日志）
  - **顶部表头**：搜索框（节点名 / Pod ns / Pod name 模糊）+ 节点数 + 健康分布 `● N 正常 / ● M 异常`（搜索激活的节点保留手动展开状态）+ 刷新控件
  - **drilldown**：节点名点击跳 `/clusters/:id/nodes`
- **共享类型**：`pkg/common/vgpu/types.go` 是 Worker / Server / Frontend 共用的 JSON 契约（Card / PodUsage / Node / Snapshot 四个 struct，hand-mirror 到前端 `services/kpilot/vgpu.ts`）
- **synthetic worker action**：`vgpu-snapshot` 是 worker 端 `pkg/worker/proxy/proxy.go::execute` 的 cluster-level 合成查询，路由在 RESTMapping 之前（不需要 GVK），同款模式还有 `volcano-status`

## 5. Volcano CR 浏览器（10 个）

每个 CR 一个独立路由，菜单分组在 sider 的「调度资源」下：

| 路由 | Kind | 范围 | GUI 操作 |
|---|---|---|---|
| `/compute/:id/queues` | `scheduling.volcano.sh/v1beta1 Queue` | Cluster | 创建 / 编辑表单（weight + priority + reclaimable + parent + 3 个 ResourceList，每个 ResourceList 都带原生 vGPU 三件套字段：`vgpuNumber / vgpuMemory / vgpuCores` + 4 槽 nodeGroup affinity） + Open/Close（bus.volcano.sh Command） |
| `/compute/:id/jobs` | `batch.volcano.sh/v1alpha1 Job` | Namespaced | 多任务创建 / 编辑表单（imagePullPolicy + 原生 vGPU 三件套字段：`vgpuNumber / vgpuMemory / vgpuCores`） + Resume/Abort/Restart/Complete/Terminate（Command）+ 编辑时显式提示 Volcano webhook 不可变字段（顶部 Alert + submit-time diff 兜底） |
| `/compute/:id/cronjobs` | `batch.volcano.sh/v1alpha1 CronJob` | Namespaced | 创建 / 编辑表单（同 JobForm，含 vGPU 三件套） + Suspend/Resume（直接 SSA patch `spec.suspend`） |
| `/compute/:id/podgroups` | `scheduling.volcano.sh/v1beta1 PodGroup` | Namespaced | 类型化表单（minMember / minResources / minTaskMember / networkTopology） |
| `/compute/:id/hypernodes` | `topology.volcano.sh/v1alpha1 HyperNode` | Cluster | 类型化表单（tier + tierName + 三态 selector 数组 exactMatch/regexMatch/labelMatch） |
| `/compute/:id/jobflows` | `flow.volcano.sh/v1alpha1 JobFlow` | Namespaced | YAML drawer（DAG / 探针结构复杂；默认 namespace 来自 NamespacePicker） |
| `/compute/:id/jobtemplates` | `flow.volcano.sh/v1alpha1 JobTemplate` | Namespaced | YAML drawer |
| `/compute/:id/numatopologies` | `nodeinfo.volcano.sh/v1alpha1 Numatopology` | Cluster | **只读**（volcano-resource-exporter DaemonSet 自动维护） |
| `/compute/:id/nodeshards` | `shard.volcano.sh/v1alpha1 NodeShard` | Cluster | 类型化表单（name + nodesDesired tags） |
| `/compute/:id/colocationconfigurations` | `config.volcano.sh/v1alpha1 ColocationConfiguration` | Namespaced | 类型化表单（3 个 memoryQos ratio + matchLabels key/value 列表，matchExpressions preserved 但不在表单中编辑） |

### 5.1 通用机制

- **专用列表端点**：每种 CR 一个 server handler（`pkg/server/api/handler/volcano.go`），通过 worker 的 `list-full` action 一次取齐 spec + status，server 端把字段投影成 slim row JSON 下发前端。**100 个 Queue 渲染 = 1 个 HTTP 请求**——不再是「1 list + 100 GET」N+1 模式
- **响应 shape**：10 个端点统一返回 `{ items: Row[], continue?: string, remainingItemCount?: number }`，承载 K8s list metadata 让前端能感知截断。Server 端默认 `limit=500`（同时是上限），客户端可以用 `?limit=N` 收紧但不能放大
- **超时**：跑在 `readWorkerTimeout=120s` 下（与 worker 端 read 路径对齐）
- **Worker `list-full` action**（`pkg/worker/proxy/proxy.go::listFull`）：dynamic.List 返回完整对象，每个 item marshal 前 strip `metadata.managedFields`（kubectl 同款做法）。按需添加新 GVK 时只需在 server 端加 handler，worker 不动
- **页面结构**：所有 list 页都直接渲染 `<ProTable>`（不包 `WorkloadsContent`），列定义按 kind 单独写，cell 全部 props-driven 纯渲染（无 per-row fetch）。共享 helper 在 `pages/Compute/Volcano/shared/Layout.tsx`：
  - `<NotInstalled>` / `isResourceNotAvailable` —— RESOURCE_NOT_AVAILABLE 兜底（接受 `titleId/subTitleId/actionId` override 覆盖默认 Volcano 文案，vGPU 页用此对 device-plugin 命名）
  - `<ResourceIntro id>` —— CR 浏览器页顶部一句"这是啥 + 谁用 + 前置依赖"的 info Alert，10 个 CR 页都有；vGPU 页与 Overview 页因为已有自身顶部解释（KPI / banner）不再叠加。文案在 `pages.compute.intro.<resource>` i18n key
  - `useAutoRefresh` —— 用户可控的轮询 interval（5/10/30/60s）
  - `<RefreshControl>` —— 图标 reload + 间隔 Dropdown 紧凑组（`Space.Compact`），关掉 ProTable 自带 reload（`options={{ reload: false }}`）避免叠加
  - `<TruncatedBanner shown count>` —— 响应带 `continue` token 时渲染 Alert 提示结果被截断
  - `useStaggeredRefresh(refresh)` —— 返回 `fire(delays[])`，内部用 useRef 跟踪 setTimeout id 并在 unmount 时清理。Queue Open/Close、CronJob Suspend/Resume 这类异步生命周期操作触发后用它做 staggered refresh
  - `formatAge` —— kubectl 风格的 `5m / 3h / 2d` age 字符串
- **错误兜底**：list 端点在 CRD 不存在时返回 `404 / RESOURCE_NOT_AVAILABLE`，页面切换为 `<NotInstalled>`。Server 端同时打 `[handler] volcano CRD not available: cluster=... kind=...` 日志
- **NamespacePicker**：顶部命名空间选择器识别 namespaced CR 页面（jobs / cronjobs / podgroups / jobflows / jobtemplates / colocationconfigurations）；cluster-scoped 页（queues / hypernodes / numatopologies / nodeshards / scheduler / vgpu / overview）自动隐藏
- **写操作**：edit / delete 走通用 `/workloads/_cr` PUT/DELETE（带 GVK query），form drawer 走 `/apply` SSA。集群侧写操作没有 KPilot-side protection（`pkg/server/protect/` 已删除），K8s RBAC + 各资源 controller 是唯一防线

### 5.2 表单 drawer（类型化）

| 表单 | 特殊机制 |
|---|---|
| `QueueForm` | priority + nodeGroupAffinity / nodeGroupAntiAffinity 各 required / preferred 共 4 槽 Select tags；`editOriginalRef` 镜像 `extendClusters` / `dequeueStrategy` 不丢失 |
| `JobForm` | 每个 task 暴露 imagePullPolicy（Always / IfNotPresent / Never / Auto）；编辑模式下 dirty-diff 监听 immutable 字段（Volcano webhook 仅接受改 `minAvailable / tasks[*].replicas / priorityClassName`），改了别的字段 inline Alert 提示；`editOriginalRef` 镜像 plugin args / 每 task 的 template.spec 完整副本 + dependsOn + partitionPolicy + 全 job 级 volumes / policies / 自定义 schedulerName |
| `CronJobForm` | JobForm 同款 + schedule / concurrencyPolicy / history limits / suspend |
| `PodGroupForm` / `HyperNodeForm` / `NodeShardForm` / `ColocationConfigurationForm` | 各自 typed 表单 + YAML tab |
| `JobFlowForm` / `JobTemplateForm` | YAML-only drawer（DAG / 探针太复杂，typed 表单不划算） |

**表单 ↔ YAML 双视图共同模式**（每个表单都有）：

- **创建 vs 编辑**：同一个 drawer，靠 `editing?: { name, namespace? }` prop 区分。编辑模式下 fetch 现有资源、回填表单、name + namespace 输入框 disabled
- **切换 tab**：form → yaml 走 `buildXxxManifest(fvToInput(formValues))` → `yaml.dump`；yaml → form 走 `yaml.load` → `formValuesFromManifest`（每个表单各自实现一份提取器）。失败时显示 inline Alert，保留草稿
- **提交**：依据当前激活 view —— 表单走 `validateFields + buildManifest`，YAML 走原始 `yaml.load`。最后都走 `/apply` SSA
- **YAML 视图**整体保留所有字段；**表单视图**走 builder 函数，丢未建模字段；为了 edit 路径不抹掉用户原本设置的内容，每个 form 都用 `editOriginalRef` 镜像已知会被 SSA 抹掉的字段、submit 时重新合入

### 5.3 生命周期操作（lifecycle）

Volcano 提供两套机制：

- **`bus.volcano.sh/v1alpha1 Command` CR**：drop 一条 Command 指 target，Volcano 控制器消费并删除。用于：
  - Queue: `OpenQueue` / `CloseQueue`
  - Job: `ResumeJob` / `AbortJob` / `RestartJob` / `CompleteJob` / `TerminateJob`
- **直接 SSA patch**：CronJob 的暂停 / 恢复改 `spec.suspend` 即可，不需要 Command 机制

服务函数 `services/kpilot/volcano.ts::sendCommand` 和 `applyManifest` 都走 `/api/v1/clusters/:id/apply` 端点（同款 SSA 路径）。

### 5.4 schedulerName

所有 Volcano Job 创建时的 task podSpec 自动注入 `schedulerName: 'volcano'`（见 `services/kpilot/volcano.ts::buildJobManifest`）。手写 YAML 的用户也得记得加，否则会被 default-scheduler 接管，绕过 Volcano 调度策略。

## 6. GPU 监控（`/compute/:id/gpu-monitoring`）

物理 GPU 健康度面板。**vGPU 视图的姊妹页**：vGPU 视图看切片分配（哪张卡上有谁、占了多少 slot / 显存 / cores），GPU 监控看硬件层指标（温度 / 功耗 / 实际利用率 / framebuffer / SM clock / tensor 核心活跃度）。

- **数据流**：NVIDIA DCGM Exporter 内置插件（`pkg/server/store/seed.go` 中 `dcgm-exporter` 一行，sort_order 27，chart 来源 `https://nvidia.github.io/dcgm-exporter/helm-charts`，DaemonSet 部署）→ 暴露 `:9400` 上的 Prometheus 指标 → VictoriaMetrics 按 `prometheus.io/{scrape,port}` 服务注解抓取 → Grafana 渲染面板
- **Dashboard**：Grafana ID 12239（NVIDIA 官方 DCGM Exporter Dashboard，UID `Oxed_c6Wz`），完整 JSON 落在 `pkg/server/dashboards/builtin/nvidia-dcgm.json`，通过 `embed.go::buildGrafanaOverlay` 注入到 Grafana plugin 的 values。**JSON 预处理**：从 grafana.com 拉到的原 JSON 包含 `__inputs` / `__requires` 块（Grafana 导入向导用）和 `${DS_PROMETHEUS}` 占位符；保存前用 `jq` 把前者 `del`、把后者 `gsub` 成字面量 `VictoriaMetrics`（与 grafana 插件 default_values 里 datasource name 对齐），让文件级 provisioning 直接 load 不走 import flow
- **页面**：`pages/Compute/Volcano/GPUMonitoring.tsx` —— 复用 `<GrafanaEmbed>`，`required=['grafana', 'victoria-metrics', 'dcgm-exporter']`，无 recommended；缺依赖时复用现有 `pages.gpuMonitoring.{missing,installing,failed}.{title,subTitle}` 文案
- **前置条件**：每个 GPU 节点要装 **NVIDIA driver + nvidia-container-runtime**（与 volcano-vgpu-device-plugin 共用同一套基础设施）。DCGM Exporter 容器需要 `SYS_ADMIN` cap 才能读 profiling 指标（`DCGM_FI_PROF_*`），chart 默认 securityContext 已配齐
- **节点选择**：默认无 nodeSelector —— exporter 在无 GPU 的节点上探针失败，pod 不会重新调度（无伤大雅但占 pod slot）。用 NFD / GPU Operator 的环境可在 EnableDrawer 里加 `nodeSelector.nvidia.com/gpu.present: "true"`

## 7. 路由 + 菜单结构

```
算力调度 (/compute)
├── Volcano 概览     (/compute/:id/overview)        ← 默认首屏
├── 调度策略        (/compute/:id/scheduler)
├── vGPU            (/compute/:id/vgpu)
├── GPU 监控        (/compute/:id/gpu-monitoring)
└── 调度资源 (group)
    ├── Queue                       (/compute/:id/queues)
    ├── Job                         (/compute/:id/jobs)
    ├── CronJob                     (/compute/:id/cronjobs)
    ├── PodGroup                    (/compute/:id/podgroups)
    ├── HyperNode                   (/compute/:id/hypernodes)
    ├── JobFlow                     (/compute/:id/jobflows)
    ├── JobTemplate                 (/compute/:id/jobtemplates)
    ├── Numatopology                (/compute/:id/numatopologies)
    ├── NodeShard                   (/compute/:id/nodeshards)
    └── ColocationConfiguration     (/compute/:id/colocationconfigurations)
```

`/compute/:id` redirect 到 `/overview`。

## 8. 后续路线

| 阶段 | 内容 |
|---|---|
| P14 | Volcano queue 配额可视化深化 + 设备健康告警 + GPU-Hour 计费报表 |
