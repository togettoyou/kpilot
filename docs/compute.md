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

## 4. GPU 视图（`/compute/:id/vgpu`）

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
- **响应 shape**：10 个端点统一返回 `{ items: Row[], continue?: string, remainingItemCount?: number }`，承载 K8s list metadata 让前端能感知截断 + 翻页。Server 端默认 `limit=500`（同时是上限），客户端可以用 `?limit=N` 收紧但不能放大。`continue` token 由前端 `useVolcanoList` 累积——见 5.1 下方
- **超时**：跑在 `readWorkerTimeout=120s` 下（与 worker 端 read 路径对齐）
- **Worker `list-full` action**（`pkg/worker/proxy/proxy.go::listFull`）：dynamic.List 返回完整对象，每个 item marshal 前 strip `metadata.managedFields`（kubectl 同款做法）。按需添加新 GVK 时只需在 server 端加 handler，worker 不动
- **页面结构**：所有 list 页都直接渲染 `<ProTable>`（不包 `WorkloadsContent`），列定义按 kind 单独写，cell 全部 props-driven 纯渲染（无 per-row fetch）。数据走 `web/src/hooks/useVolcanoList.ts`（cursor 累积器，返回 `{ items, loading, error, refresh, loadMore, hasMore, total }`）。共享 helper 在 `pages/Compute/Volcano/shared/Layout.tsx`：
  - `<NotInstalled>` / `isResourceNotAvailable` —— RESOURCE_NOT_AVAILABLE 兜底（接受 `titleId/subTitleId/actionId` override 覆盖默认 Volcano 文案，vGPU 页用此对 device-plugin 命名）
  - `<ResourceIntro id>` —— CR 浏览器页顶部一句"这是啥 + 谁用 + 前置依赖"的 info Alert，10 个 CR 页都有；vGPU 页与 Overview 页因为已有自身顶部解释（KPI / banner）不再叠加。文案在 `pages.compute.intro.<resource>` i18n key
  - `useAutoRefresh` —— 用户可控的轮询 interval（5/10/30/60s），内部用 ref 镜像 `refresh` 函数，避免 useRequest 每渲染新 closure 导致 timer 反复 tear-down
  - `<RefreshControl>` —— 图标 reload + 间隔 Dropdown 紧凑组（`Space.Compact`），关掉 ProTable 自带 reload（`options={{ reload: false }}`）避免叠加
  - `<TruncatedBanner shown total onLoadMore loading>` —— 响应带 `continue` token 时渲染 Alert：当 `onLoadMore` 传入时附带「加载更多」按钮，点击调用 `useVolcanoList.loadMore` 取下一页 500 行追加到 items 累积器；`total = items.length + remainingItemCount` 显示"已加载 N / 共约 M 行"
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

物理 GPU 健康度面板。**完全自绘 —— 不嵌入 Grafana**。GPU 视图的姊妹页：GPU 视图看切片分配（哪张卡上有谁、占了多少 slot / 显存 / cores），GPU 监控看硬件层指标（温度 / 功耗 / 实际利用率 / framebuffer / SM clock / tensor 核心活跃度）。

> 定位说明：算力调度平台所有可视化页全部自实现、Volcano 专用形态；Grafana 嵌入只保留给「集群管理」做通用监控（NodeExporterFull / VictoriaLogs Explorer）。这样升级 dashboard JSON / 调整面板布局 / 加 Volcano 联动 drill-down 不需要绕 Grafana。

- **数据流**：NVIDIA DCGM Exporter 内置插件（`pkg/server/store/seed.go` 中 `dcgm-exporter` 一行，sort_order 27，chart 来源 `https://nvidia.github.io/dcgm-exporter/helm-charts`，DaemonSet 部署）→ 暴露 `:9400` 上的 Prometheus 指标 → VictoriaMetrics 按 `prometheus.io/{scrape,port}` 服务注解抓取 → server `pkg/server/api/handler/gpu_metrics.go::GetGPUMetrics` 通过 `gw.SendHTTPRequest` 走 worker tunnel 并发跑 6 条 PromQL 范围查询 → 前端 `<Line>` 图表渲染
- **后端 `/api/v1/clusters/:id/gpu-metrics?range=1h|24h|7d|30d`**：
  - 6 条 PromQL 并发：`DCGM_FI_DEV_GPU_UTIL` / `_TEMP` / `_POWER_USAGE` / `_FB_USED` / `_FB_TOTAL` / `_SM_CLOCK` / `DCGM_FI_PROF_PIPE_TENSOR_ACTIVE`
  - 单查询失败仅 log，对应 metric 返回空，前端只少一张图
  - 响应 shape `{ range, from, to, generatedAt, stepSeconds, snapshot, series: { util, temp, power, fbUsed, fbTotal, sm, tensor: [{ hostname, gpu, uuid, points: [{ts,value}] }] } }`，每条 series 按 (hostname, gpu) 稳定排序
  - **snapshot** 服务端预算：activeGPUs / avgTempC / maxTempC / totalPowerW / avgUtilPct / fbUsedMiB / fbTotalMiB / fbUsagePct / avgTensorActPct，取每条 series 最右点 reduce，前端 KPI 不重复 walk
  - range step 表：1h=30s / 24h=5m / 7d=30m / 30d=2h（比 GPU-Hour 的 step 粗一档；line chart 没必要保留 30s 粒度走 30 天）
- **VM 查询共享层**：`pkg/server/api/handler/vm_query.go` 抽出 `resolveVMQueryURL` / `queryVM` / `queryVMRange` / `urlQueryEscape`，DeviceHealth / GPUHour / GPUMetrics 三个 handler 共用
- **worker 自动路由 in-cluster Service URL**：worker `pkg/worker/proxy/http.go` 检测 host 匹配 `*.svc.*` 时,改走 K8s API server 的 service proxy 端点(`/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/<path>`)而不是直接 dial。生产部署(worker 跑集群里)+ 本地 dev(worker 跨 kubeconfig/SSH tunnel 拿不到 cluster.local DNS)都能通,不需要给 server 端配置不同 URL 形态
- **页面**：`pages/Compute/Volcano/GPUMonitoring.tsx` ——
  - 顶部 Radio.Group range picker + RefreshControl（default off）
  - 4 KPI 卡：activeGPUs / 平均利用率（`Progress.dashboard` + 阈值配色） / 平均温度（dashboard，max 90℃ 标 ↑）/ 总功耗 + 显存占用混合卡
  - 6 张 Line chart 网格（响应式 `xs=24 xl=12`）—— 每张多 series（按 hostname · GPU index 标签），暗色主题切换 `theme="classicDark"`；FB 自动 MiB → GiB，Tensor 0-1 → %
  - 单图无数据走 `Empty.PRESENTED_IMAGE_SIMPLE` 占位，整页全空走 EmptyCard CTA
- **VM 未启用**：`resolveVMQueryURL` 返回 `RESOURCE_NOT_AVAILABLE` → 前端 `<NotInstalled>` 引导启用 VM + DCGM Exporter（**不再依赖 Grafana**）
- **前置条件**：每个 GPU 节点要装 **NVIDIA driver + nvidia-container-runtime**（与 volcano-vgpu-device-plugin 共用同一套基础设施）。DCGM Exporter 容器需要 `SYS_ADMIN` cap 才能读 profiling 指标（`DCGM_FI_PROF_*`），chart 默认 securityContext 已配齐
- **节点选择**：默认无 nodeSelector —— exporter 在无 GPU 的节点上探针失败，pod 不会重新调度（无伤大雅但占 pod slot）。用 NFD / GPU Operator 的环境可在 EnableDrawer 里加 `nodeSelector.nvidia.com/gpu.present: "true"`

## 7. 队列配额（`/compute/:id/queue-quota`）

单 Queue 多资源配额深化视图。**Overview 的姊妹页**：Overview 显示集群级 capability vs allocated 三资源横向条；队列配额页选定一个 Queue 后展开 **全部资源类型** × **四状态**（capability / guarantee / allocated / deserved）+ **子 Queue 卡片递归**。**默认选中 `root` 队列**——Volcano 总有 root 节点（隐式父队列），新装集群上 root 是唯一观察对象，首屏就有内容而不是空 CTA。

- **数据流**：复用现有 `/api/v1/clusters/:id/volcano/queues` 列表端点（list-full 已经把 spec.{capability, guarantee, deserved, priority} + status.allocated 都投影出来）；一次拉全集群队列，子树关系在前端按 `spec.parent` 重组。**无新端点**
- **后端字段扩展**：`pkg/server/api/handler/volcano.go::queueRow` 加 `Priority` / `Guarantee` / `Deserved` 三个字段。`spec.guarantee` 在 Volcano 里嵌套写成 `{ resource: ResourceList }`，server 端 unwrap 内层 `resource` 直接下发
- **页面布局**：
  - **顶部 selector**：缩进树形 option list 的 Queue Select（父子层级靠前缀 `│   ├─` 可视化，避免引入 Cascader 重组件），右侧统计「共 N 个 Queue」+ RefreshControl 间隔下拉（默认 off）
  - **主卡片**（选中 Queue 之后）：header bar 列名称 + state Tag + 父队列 Tag + priority/weight Badge + reclaimable 反向 Tag + extra 处运行/等待/排队 job 计数 Badge。body 内逐资源行：
    - **resource header**：人类化名（CPU / 内存 / GPU 整卡 / vGPU 切片数 / vGPU 显存 / vGPU 算力，其他键 raw 显示）+ 已分配 / 保障 / 上限 / 应得 数字串
    - **bar**：纯 CSS 自绘 —— 横向 track = capability，填充 = allocated（颜色按状态切：超 capability 红 / 未达 guarantee 橙 / 正常蓝），guarantee 用 2px 绿色竖线 tick（hover Tooltip），deserved 用 2px 紫色竖线 tick（仅 capacity 插件启用时下发）。antd Progress 不支持多 marker 叠加，所以走 absolute-positioned div。**未设上限的资源**走斜纹空轨道（与 Overview CapacityRow 一致），不填充——曾经按 max(alloc, guar, des) 当分母会让条永远 100%「看起来满」，现在用 `repeating-linear-gradient(45deg)` + 隐藏 tick 表达「无上限」
    - **超限 / 未达保障**：Alert（error / warning）渲染在 bar 下方
  - **子 Queue 区**：用同款 QueueDetailCard 紧凑模式（`primary=false`，size=small）递归渲染直属子 Queue
- **首屏默认选中**：`root` 队列（Volcano 隐式根），无 root 时回退到 `items[0]`
- **轮询**：复用 `useAutoRefresh` + `<RefreshControl>`，default off
- **hooks 顺序**：所有 `useMemo` / `useEffect` 必须在 RESOURCE_NOT_AVAILABLE early-return 之前调用。曾经把 early-return 插在 hooks 之间 → 集群无 Volcano 时报「Rendered fewer hooks than expected」
- **文件**：`pages/Compute/Volcano/QueueQuota.tsx`；`parseQuantity` / `shortUUID` / `usageColor` 共享于 `pages/Compute/Volcano/shared/utils.ts`

## 8. GPU 告警（`/compute/:id/device-health`）

把 DCGM Exporter 采集到的硬件故障信号 server 侧聚合成单一告警列表。**GPU 视图的姊妹页**：GPU 视图看切片分配状态，GPU 告警看硬件故障状态。

- **数据流**：server `pkg/server/api/handler/device_health.go::GetDeviceHealth` 通过 `resolveVMQueryURL` 拿到 victoria-metrics 在该集群的 Service FQDN（chart 命名 `<release>-victoria-metrics-single-server.<release-ns>.svc.<cluster-domain>:8428`），通过 `gw.SendHTTPRequest` 走 worker tunnel 并发跑 4 条 PromQL 查询：
  - `DCGM_FI_DEV_XID_ERRORS > 0` —— XID 故障（critical）
  - `increase(DCGM_FI_DEV_ECC_DBE_VOL_TOTAL[30m]) > 0` —— 30 分钟内出现的不可恢复 ECC（critical）
  - `DCGM_FI_DEV_GPU_TEMP > 85` —— 过热（≥90 critical，否则 warning）
  - `(DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL) > 0.95` —— 显存即将耗尽（warning）
- **单查询失败不阻塞**：4 条 PromQL goroutine 内 `recover` 各自的 error，失败时 log 跳过，前端只少一类告警，不空白
- **响应 shape**：`{ alerts: [{severity, kind, hostname, instance, gpu, uuid, value, message}], generatedAt, counts: {critical, warning, info} }`，counts 服务端预算，前端 KPI 不重复 walk
- **VM 未启用**：`resolveVMQueryURL` 检测 victoria-metrics plugin row 缺失 / 未启用 / Phase != Running，返回 `RESOURCE_NOT_AVAILABLE`；前端走 `<NotInstalled>` 引导启用
- **页面**：`pages/Compute/Volcano/DeviceHealth.tsx` —— 3 KPI 卡（critical / warning / info 数字 + 配色）+ 单一 ProTable（无论有无告警都渲染：有数据走表格、空数据走 `locale.emptyText` 的绿色对勾 Empty），RefreshControl 放在 ProTable `toolBarRender` 里。severity 列 filter 多选，hostname 列点击跳 `/clusters/:id/nodes`，UUID 尾截 `…hhhhhhhh` 复制完整 UUID。**alert 句子全部前端 i18n**（zh-CN / en-US 双套 message 模板，server 只下发 `kind` + `value`）
- **未来扩展**：可在同一响应里合并 vGPU snapshot 的 `Card.Health=false` 与 Volcano Job event 失败聚合，结构兼容（kind 新增即可，前端 unknown kind 走 fallback）

## 9. GPU-Hour 用量（`/compute/:id/gpu-hour`）

历史 GPU 利用率积分报表。**v1 仅按节点 × 物理卡聚合**——按 Queue / Namespace / Pod 的细分需要 worker 周期性快照持久化到 server DB（见 §11 后续路线），文档明示。

- **数据流**：server `gpu_hour.go::GetGPUHour` 接 `?range=1h|24h|7d|30d`，跑 PromQL `avg_over_time((DCGM_FI_DEV_GPU_UTIL / 100)[<range>:<step>])` 拿到每条 (Hostname, gpu) 序列的平均利用率，乘以窗口 hours 得 GPU-Hour 值（例：4 张卡满载 1 小时 = 4.0）
- **为什么 avg_over_time 而不是 query_range 拉点再求和**：VM 没有梯形积分，两种近似都失精度；avg_over_time 仅 1 vector sample / 序列，worker tunnel 流量小且 PromQL 内部一次扫描——把 trapezoidal pull-and-sum 留作 `//nolint:unused` stub，未来需要毫秒级精度再切换
- **range step 表**：1h=1m / 24h=5m / 7d=15m / 30d=15m；step 太大会模糊掉短周期使用、太小会拖慢 VM
- **30d 上限**：与 victoria-metrics-single chart 默认 retention 对齐，超过期的查询自动得 0 而非报错——前端在 30d range 时显示 retention 提示 banner
- **响应**：`{ range, from, to, generatedAt, rows: [{hostname, instance, gpu, uuid, hours}], total }`，rows 服务端按 hours 倒序
- **页面**：`pages/Compute/Volcano/GPUHour.tsx` —— 顶部 Radio.Group range picker + RefreshControl，下方双 Statistic（总 GPU-Hours / 活跃 GPU 数）+ ProTable 按 hours 倒序，share 列用 `<Progress size="small">` 按 topN/total 渲染占比；page 顶部固定一条「v1 聚合粒度」提示 Alert，30d range 多挂一条 retention warning

## 10. 路由 + 菜单结构

```
算力调度 (/compute)
├── 调度概览       (/compute/:id/overview)         ← 默认首屏
├── 调度策略       (/compute/:id/scheduler)
├── 队列配额       (/compute/:id/queue-quota)      ← 紧挨调度策略,二者都是 policy 视角
├── GPU 视图       (/compute/:id/vgpu)
├── GPU 监控       (/compute/:id/gpu-monitoring)
├── GPU 告警       (/compute/:id/device-health)
├── GPU-Hour 用量  (/compute/:id/gpu-hour)
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

## 11. 后续路线

| 主题 | 内容 |
|---|---|
| GPU-Hour 细分 | GPU-Hour 报表按 Queue / Namespace / Pod 细分：worker 周期性快照 `volcano.sh/vgpu-*` 分配状态推送 server DB 表，配合时间维度积分；解锁租户计费视图 |
