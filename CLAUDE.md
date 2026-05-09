# KPilot

**Kubernetes 上的 GPU + 模型一体化平台。**

定位：装一个 KPilot + 选要的插件，从看 GPU、调度任务、部署模型到聊天测试一站打通。差异化点是「**GPU 资源 / 调度 / 模型服务**」垂直专门做，不跟 Lens / Headlamp 那类通用 K8s UI 卷宽度。

四个顶级平台：

| 平台 | 定位 |
|---|---|
| 集群管理 (`/clusters`) | 通用 K8s 资源管理（节点 / 工作负载 / 监控 / 日志），commodity，不投入差异化 |
| 算力管理 (`/compute`) | GPU 资源运营 + 任务调度（HAMi vGPU + DCGM 监控 + Volcano 调度 + 配额计费） |
| 模型管理 (`/models`) | 模型仓库 + 推理部署 + 调试 + 路由 + 训练任务（P7+ 落地） |
| 插件管理 (`/plugins`) | Helm chart 市场，前三个平台的能力底座 |

Server（中心控制面）+ Worker（集群侧 Operator），通过 gRPC 双向流连接。

Go module：`github.com/togettoyou/kpilot`

---

## 架构原则

- Server 的所有运行时数据 **100% 来自 Worker**，Server 不持有任何集群的 kubeconfig
- Worker 主动连接 Server（适合跨网络场景）
- 所有 K8s 操作由 Worker 代理执行

---

## 整体数据流

```
浏览器
  │  REST API
  ▼
Server (Go + PostgreSQL)
  │  gRPC 双向流（Worker 主动连入）
  ▼
Worker (K8s Operator, Go)
  │  controller-runtime + client-go (Watch / dynamic / Helm SDK)
  ▼
K8s Cluster
```

---

## Worker 注册流程

1. 管理员在 Server UI 创建集群条目
2. Server 生成唯一 ClusterToken（只展示一次，可在 UI 重新生成）
3. 管理员将 ClusterToken + Server gRPC 地址配置到目标集群，部署 Worker
4. Worker 启动，携带 Token 发起 gRPC 连接
5. Server 验证 Token，将连接与集群绑定，标记集群 Online

---

## gRPC 协议

单条双向流，用 `request_id` 实现请求-响应配对，同时支持 Worker 主动 Push。

**Worker → Server（WorkerMessage）：**
- `Register`（携带 Token） / `Heartbeat`
- `ResourceResponse`（list/get/apply/update/patch/delete/describe/gpu-summary 共用）
- `PluginStatusPush`
- `LogsChunk` / `LogsEnd`（Pod 日志流）
- `ExecOutput` / `ExecEnd`（Pod 终端流）
- `HTTPResponse`（反代一次性请求回包）
- `WSFrame` / `WSEnd`（反代 WebSocket 帧）

**Server → Worker（ServerMessage）：**
- `RegisterAck`
- `ResourceRequest`（同上 action 集合）
- `PluginCommand`（enable / disable）
- `LogsStartRequest` / `LogsCancelRequest`
- `ExecStartRequest` / `ExecStdin` / `ExecResize` / `ExecCancelRequest`
- `HTTPRequest`（反代一次性）
- `WSStartRequest` / `WSFrame` / `WSEnd`（反代 WS）

三种通信模式：
- **Push**（`request_id` 为空）：Worker 主动上报，事件驱动（PluginStatusPush）
- **Request-Response**：Server 带 `request_id` 发请求，Worker echo 同 ID 回去（ResourceRequest / HTTPRequest）
- **流式会话**：`request_id` 复用为 sessionID，双向多消息往返直到 `*End` 或显式 cancel（Pod 日志、终端、反代 WebSocket）

---

## 插件系统

插件本质是 Helm Chart，通过 CRD 驱动部署。

**启用流程：**
```
用户点击启用插件
  → Server 发 PluginEnable 命令（含插件配置）给 Worker
  → Worker 在集群创建 Plugin CRD
  → Worker Controller 监听 CRD，调用 Helm install/upgrade
  → Worker 通过 PluginStatusPush 回报状态
  → Server 持久化状态到 PostgreSQL
```

**Plugin CRD 示例：**
```yaml
apiVersion: kpilot.io/v1alpha1
kind: Plugin
metadata:
  name: hami
spec:
  type: hami
  version: "v2.4.0"
  values: {}
status:
  phase: Running  # Pending / Installing / Running / Failed
```

**已内置插件**（6 个，category 维度组织）：

| 插件            | 分类       | Chart 来源 | 用途                                          |
|-----------------|-----------|-----------|------------------------------------------------|
| HAMi            | gpu       | repo      | GPU 虚拟化，给 Node 打 GPU 标签，支持 vGPU 管理     |
| VictoriaMetrics | monitoring| repo      | 单节点 TSDB，自带 Web UI + scrape 配置             |
| Node Exporter   | monitoring| repo      | 节点级硬件 + OS 指标（搭 VM 用）                  |
| Grafana         | monitoring| **oci**   | 可视化前端，反代嵌入 + 内置 dashboard + auth.proxy  |
| VictoriaLogs    | logging   | repo      | 日志存储 + 自带 Vector DaemonSet 采集             |
| Envoy Gateway   | networking| **oci**   | Gateway API 实现，演示 OCI registry chart 装载    |

**计划新增**（按 dev 阶段）：

| 插件        | 分类       | 阶段  | 用途                                               |
|-------------|-----------|-------|---------------------------------------------------|
| DCGM Exporter | monitoring | P5b | NVIDIA GPU 指标采集（利用率 / 温度 / 功耗 / 显存等）  |
| Volcano       | scheduling | P5c | Batch 调度器，gang scheduling + Queue + drf 公平共享 |

---

## 平台与功能

### 1. 集群管理（`/clusters`）

通用 K8s 管理面板。**故意不做 GPU / 模型差异化**——这块是 commodity，做得跟 Lens / Headlamp 一样就行。

#### 1.1 集群列表
- 卡片网格 UI，每张卡显示集群状态 + 描述，整体可点 → 进入 K8s 详情
- 顶部 KPI 统计：总集群 / 在线 / 离线
- `tabular-nums` 防 10s 轮询时数字宽度抖动
- 卡片右上角 `...` Dropdown：编辑 / 重新生成 Token / 删除
- 删除集群级联清 `cluster_plugins` 行（事务，避免 FK 孤悬）
- 排序按 `created_at asc`，新加的不挤掉已有位置（用户按空间记忆）

#### 1.2 节点概览（`/clusters/:id/nodes`）
- 走通用 workloads proxy（`/workloads/nodes`，K8s Table API），不再走 push 模式
- 列定义直接来自 kubectl printer：NAME / STATUS / ROLES / AGE / VERSION / INTERNAL-IP / EXTERNAL-IP / OS-IMAGE / KERNEL-VERSION / CONTAINER-RUNTIME（跟 `kubectl get node -o wide` 对齐）
- STATUS 列识别 `Ready,SchedulingDisabled` 这种 kubectl 拼接格式，每段一个色 Tag
- ROLES 列 comma-split，每个角色单独 Tag
- COL_I18N map 把英文 printer header 翻译到 zh-CN
- **行操作四个按钮**：
  - **详情** → 调 describe，DescribeDrawer 显示文本 dump（事件、conditions、allocated 等）
  - **概览** → NodeDetailDrawer 结构化卡片：基本/网络/调度/资源/conditions/labels/annotations
  - **查看** → NodeYamlDrawer 只读 YAML
  - **禁用调度 / 启用调度** → cordon/uncordon
- **Node 写操作收敛到专用端点**：`POST /workloads/nodes/:name/cordon` body 只 `{cordon: bool}`，Server 自己拼 strategic merge patch `{"spec":{"unschedulable":<bool>}}`，客户端无法塞别的字段
- **通用 PUT/DELETE 对 Node 一律 403 NODE_PROTECTED**——Edit YAML 改 Node 太危险，scoped action 是唯一路径

#### 1.3 工作负载（`/clusters/:id/workloads/:type`）
- 通过 Worker 代理 K8s API，支持完整 CRUD
- **菜单分组**：
  - 工作负载：Deployment / StatefulSet / DaemonSet / Pod / Job / CronJob / HPA
  - 网络：Service / Ingress / GatewayClass / Gateway / HTTPRoute / GRPCRoute
  - 存储：PVC / PV / StorageClass
  - 配置：ConfigMap / Secret
  - 扩展：CRD + DRA（DRA 是 sub-group，含 ResourceClaim / ClaimTemplate / DeviceClass / ResourceSlice）。三级嵌套吃缩进，全局 `siderWidth=220`（默认 208 会截字）
- **集群级资源**：`CLUSTER_SCOPED_TYPES`（`web/src/services/kpilot/workload.ts`）= `persistentvolumes` / `storageclasses` / `gatewayclasses` / `deviceclasses` / `resourceslices` / `customresourcedefinitions` / `nodes`。命名空间列和顶部 NamespacePicker 自动隐藏
- **DRA**：`resource.k8s.io/v1`（GA since K8s 1.34）。OrbStack 等发行版默认没开 DRA feature gate，请求返 `no matches for kind`，跟 Gateway API 没装 CRD 同款 graceful degradation
- 列表用 K8s Table API（同 kubectl 默认展示），server 端计算列，仅传输元数据 + 单元格值
- 展示全部列（含 wide 列，等价于 `kubectl -o wide`）
- 服务端游标分页（`limit + continue` token）
- 工具栏：当前页客户端搜索（name + namespace + 所有动态列子串匹配）、手动刷新 + 定时刷新（5s/10s/30s/60s）
- **全局命名空间选择器**（顶部栏）：namespace-scoped 工作负载页面显示；cluster-scoped 资源自动隐藏；按集群独立保存；默认"全部命名空间"
- **写操作保护**（基于已解析的 GVK，`_cr` URL 也无法绕过）：
  - 命名空间：`kube-*` / `kpilot-*` 只读（`NAMESPACE_PROTECTED`）
  - CRD 定义：`*.kpilot.io` 名结尾的 CRD 拒绝改/删（`CRD_PROTECTED`）
  - CR 实例：`*.kpilot.io` group 的 CR（如 `Plugin`）拒绝（`CRD_PROTECTED`）
  - Node：所有通用 PUT/DELETE 拒绝（`NODE_PROTECTED`），cordon 走专用端点
- YAML 编辑器：CodeMirror 6，语法高亮，status 区块视觉变暗
- **编辑（kubectl-edit 语义）**：单条编辑走 PUT（dynamic.Update，body 携带 `metadata.resourceVersion`），并发改返 409 → 前端展示 `WORKER_CONFLICT`
- **通用 Apply YAML 抽屉**：用户输入或拖拽 .yaml/.yml/.json，多文档 `---` 分隔。两个按钮：
  - **应用**（POST `/apply`）：每条 SSA（`apply` action），kubectl-apply 语义
  - **删除**（POST `/delete-yaml`）：按 GVK + name + namespace 调 `delete`，kubectl-delete-f 语义。带 modal.confirm 二次确认
  - 失败列表带「展开/收起」+ `maxHeight: 240px overflowY:auto`
  - 同款保护规则在 `validateDoc` 里基于解析 GVK 做拦截（含 Node）
- **资源详情（Describe）**：操作栏「详情」按钮，调 `k8s.io/kubectl/pkg/describe`：内置 kind 用 `DescriberFor`（专用，字段语义感知）；CRD/CR fallback 到 `GenericDescriberFor`。前端做最小化高亮（key 着色 + Events Type Normal/Warning 着色）
- **CR 实例浏览器**（CRD 行「查看实例」 → `/workloads/_cr?group=...&version=...&kind=...&scope=...`）：
  - 复用 WorkloadsContent，dynamic GVK 通过 URL query 透传，Worker 用 `dynamic.Interface` + RESTMapper 解析
  - 选 CRD 版本时优先 storage version，fallback 到首个 served version，最后 versions[0]
  - 标题 = Kind + 灰色 group/version 副标题，左边图标返回按钮
  - **菜单状态保持**：`/workloads/_cr` 在 `app.tsx buildClusterSubMenu` 里登记成 CRDs 菜单的 `hideInMenu: true` 子路由
- **Pod 日志**：WebSocket 流式 follow，可选容器、tail 行数（100/500/1000/5000）、previous 实例；前端 rAF 节流避免高吞吐场景的渲染抖动；自带客户端 grep（200ms 防抖，纯字符串/正则双模式，匹配高亮 + "匹配 X / 共 Y 行" 计数）
- **Pod 终端（Exec）**：xterm.js + FitAddon，Worker 端默认 `/bin/bash`，不存在自动回退 `/bin/sh`；二进制 WS 帧（首字节为类型）

#### 1.4 集群侧插件（`/clusters/:id/plugins`）
- 全局插件注册表的只读视图，每张卡显示该集群上的 phase（spinning Loading / 绿勾 Running / 红叉 Failed）
- 点「启用」打开 drawer 配置 values/version/namespace 后下发 Helm install
- 详细启用机制见 [§ 插件系统](#插件系统)

#### 1.5 监控 / 日志（`/clusters/:id/monitoring` `/clusters/:id/logging`）
- 共享 `web/src/components/GrafanaEmbed/`，区别只在依赖列表 + dashboard UID + i18n 前缀
- **依赖检查**：拉 `/api/v1/clusters/:id/plugins`，按 phase 分四桶（ready / installing / failed / missing）。allReady → 渲染 iframe；其他状态显示 antd `Result`，installing 期间每 5s 自动 poll
- **iframe URL**：`/api/v1/clusters/:id/proxy/grafana/d/<dashboardUID>/?theme=light|dark`
- **主题同步**：KPilot 切主题 → effect 读 `iframe.contentWindow.location.href`（同源） → 改 `?theme=` 参数 → 写回 `iframe.src`
- **滚动隔离**：iframe 内部 document（同源）的 `documentElement` 和 `body` 注入 `overscroll-behavior: contain`
- **Worker 反代后端**（`pkg/server/api/handler/proxy.go`）：HTTP 请求/响应走 `SendHTTPRequest`，WebSocket 走 `OpenStream`（复用 Pod logs/exec 的 Stream 框架）。`proxiableServices` map 是反代白名单（目前只 grafana）
- **认证链**：浏览器带 KPilot JWT → Server JWT middleware 验证 → `resolveUsername(c)` 提取用户名 → 反代时 inject `X-WEBAUTH-USER` → Grafana auth.proxy 自动建用户登录（`auto_sign_up=true`，role=Viewer 只读）
- **`proxyResolveCache`**（30s TTL）：缓存 `(cluster, plugin) → (release_namespace, Phase=Running)`，避免每个反代请求都 3 次 DB 查
- **Grafana 配置要点**（`pkg/server/store/seed.go::Grafana`）：
  - `auth.proxy` 启用 + auto_sign_up + Viewer 角色
  - `serve_from_sub_path=true` + 相对 root_url 带 `${KPILOT_CLUSTER_ID}` 占位符
  - `[security] allow_embedding=true`
  - `[live] allowed_origins="*"` 让 Grafana Live WS 接受 KPilot 域 Origin
  - 预配 VictoriaMetrics（type=prometheus）+ VictoriaLogs（type=`victoriametrics-logs-datasource`，自动从 grafana.com 装 plugin）
- **dashboard UID**：monitoring=`rYdddlPWk`（NodeExporterFull）、logging=`g6mvjz`（VL Explorer K8S）

### 2. 算力管理（`/compute`）

GPU 资源运营 + 任务调度平台。三层能力：
1. **观测层**（已有）：资源概览、节点/卡/任务利用率、GPU 监控（DCGM, P5b）
2. **调度层**（计划）：基于 Volcano 的任务调度——Queue（资源池）/ PodGroup / Job CRD 视图，gang scheduling、优先级、抢占
3. **治理层**（计划）：基于 Volcano queue + K8s ResourceQuota 联合的配额、设备健康告警、GPU-Hour 计费

依赖插件：HAMi（必需，vGPU 切分）+ DCGM Exporter（监控）+ Volcano（调度）—— 全部走 `插件管理` 启用，未启用的 sub-page 走 DepGate 走相应提示。

#### 2.1 集群选择（`/compute`）
- 顶级 landing 页，集群卡片网格，点击进入算力面板
- **不带 CRUD 动作**——增删改集群在「集群管理」做，这里只选集群上下文

#### 2.2 资源概览（`/compute/:id/overview`）
单页 dashboard，自上而下：
- **页头**：标题 + 副标题展示集群规模（"X 个 GPU 节点 · Y 张物理卡"）+ 刷新按钮
- **KPI 三联仪表盘**：vGPU / 显存 / 算力，三张等宽 dashboard-style Progress（3/4 弧 gauge）
- **型号分布 + Top 5 显存占用**：两栏可视化，每行一个 Progress 条 + 标签 + 实际值
- **节点利用率网格**：每个节点一张 mini-card（节点名 + 状态徽章 + 卡数 + 三轴 mini progress + 详情按钮），点详情打开 `NodeDetailDrawer`：节点级 gauges + 每张物理卡 inline + 卡上 pods
- **Tabs 详情**：底部 Tabs 切换「显卡明细」/「任务明细」两个表格。显卡表带 `CardDetailDrawer`，任务表带 namespace/phase/node 列过滤 + 客户端排序分页

依赖 HAMi 插件（`DepGate` 跟监控页同款 dep-check）。

#### 2.3 算力关键设计

- **数据获取**：单端点 `/api/v1/clusters/:id/gpu` → Worker `gpu-summary` action 聚合返回。`useGPUData` hook 一份 fetch + dep check + 自动轮询，HAMi Running 时每 10s 重拉
- **后端解析**（`pkg/worker/proxy/gpu.go`）：
  - **节点端**：`hami.io/node-nvidia-register` annotation，**先尝试 colon-comma 编码格式**（HAMi <= 2.4，7 或 9 字段）**再 fallback JSON**（新版本）
  - **Pod 端**：`hami.io/vgpu-devices-allocated` annotation 解出每容器/每卡的 (UUID, type, mem, cores) 元组，attribute 到具体物理卡。`cores=0 → 100%` 跟 HAMi-WebUI 同款约定
  - **Pod 元数据**：`createdAt` / `startedAt` 走 PodScheduled / PodInitialized condition；`appName` 取 `app.kubernetes.io/name` 或 `app` label；`resourcePool` / `flavor` / `priority` 各取对应 annotation。终止态 pod (Succeeded/Failed) 不计入占用
  - **Init container** 取 max 不取 sum，跟 K8s 调度器 effective-request 一致
- **KPI 优先 cards 求和**：`rollupKPIs` / `NodeTile` / `NodeDetailDrawer` 都先看 `node.cards[]`，从每张卡的 `slots / devmem / devcore / used*` 累加。**只有 cards 为空才回落 node 级 `allocatable / capacity`**。原因：HAMi 在 Node 上报的 `nvidia.com/gpu` 是物理卡数（不是 slot 数），kwok mock + 部分 HAMi 配置完全没在 capacity 里塞 `nvidia.com/gpumem` / `nvidia.com/gpucores`，靠 node 级读会出 `0/2` 或 `0/0` 这种不直观结果——per-card 视图才是真值
- **缓存**（`pkg/worker/snapshot/`）：client-go SharedInformerFactory，启动时 List 一次 + watch 长连接，WaitForCacheSync 阻塞到 ready 才进 tunnel.Run。`gpuSummary` 从 lister 读（微秒级，zero API call）
- **Worker clientset 单例**：snapshot / logs manager / exec manager 共享一份 `kubernetes.NewForConfig`，避免每个 consumer 各自维护一套 http.Transport 连接池
- **客户端分页**：GPU pod 数量天花板 = 集群总 vGPU 切片数（典型几百，极端几千），ProTable 客户端分页/排序/列过滤足以应对
- **节点页解耦**：K8s 节点概览（`pages/ClusterDetail/Nodes/`）只管 K8s 原语（CPU / 内存 / 状态），GPU 信息全去算力管理。避免 K8s 节点页随加速器种类（后续可能加 TPU / FPGA）持续膨胀

### 3. 模型管理（`/models`，P7 落地中）

全局模型平台（不绑特定集群）。Phase 0 只有 placeholder landing 页，4 张 feature 卡推介 P7 内容。

设计方向：
- **模型仓库**：全局 `Model` 表（name / runtime=`vllm|sglang|tgi` / image / default_args / recommended_gpu）。内置预设若干（Qwen / DeepSeek / Llama 等）
- **模型部署**：选模型 + 选集群 + GPU 数 + 副本数 → 后端拼 Deployment + Service manifest → SSA 到目标集群。可选启用 KPilot 反代（路径 `/api/v1/clusters/:id/proxy/inference/<deploy-name>`）暴露 OpenAI-compat API
- **调试 chat**：抽屉打开简易 chat UI → 调部署好的 endpoint → 流式返回
- **模型路由**：OpenAI 兼容网关，根据 model 参数路由不同后端，支持灰度 / A/B
- 不上 KServe（Knative 依赖太重），直接 Deployment + Service

> ⚠️ **路径命名**：组件落在 `pages/ModelHub/` 而非 `pages/Models/`。Umi 的 plugin-model 自动扫描 `src/pages/**/models/**` 当 state-hook 文件，macOS 大小写不敏感 FS 上 `Models` 会命中 glob 触发 CaseSensitivePathsPlugin 报错

### 4. 插件管理（`/plugins`）

全局 Helm chart 注册表的 CRUD：
- 卡片按 category 分组（gpu / scheduling / networking / storage / monitoring / logging / security / serving / custom）
- 内置插件只读（带「内置」金色 tag），自定义可编辑/删除/查看
- **添加插件**：name (DNS-1123) + 分类 + Helm chart 来源 + 默认 values（YAML 编辑器）+ 默认安装命名空间
- Chart 三种来源（前端 Radio + 后端 ChartType enum，对称色 tag：cyan / geekblue / purple）：
  - `repo` —— 传统 HTTPS Helm 仓库（`chart_repo` + `chart_name` + 版本，需要 index.yaml）
  - `oci` —— OCI registry（Helm 3.8+，`chart_repo` 存完整 `oci://` URL，`chart_name` 不用）。**v1 只支持公开 registry**
  - `local` —— 上传 .tgz blob，sha256 内容 dedupe
- **删除保护**：自定义插件被任意集群启用中（`phase != Disabled`）→ 409 / `PLUGIN_IN_USE`
- **Namespace 锁**：`helm_revision > 0` 后改 `release_namespace_override` → 400 / `PLUGIN_NAMESPACE_LOCKED`，避免 Helm release 在旧 ns 孤悬

#### 4.1 启用机制

- **数据切分**：`Plugin`（全局注册表）/ `PluginBlob`（本地 .tgz 字节，sha256 dedupe）/ `ClusterPlugin`（集群侧启用状态 + 用户 override）
- **Plugin CRD**（`pkg/worker/apis/v1alpha1`）：cluster-scoped。spec 含 chart 来源（`type=repo|oci|local`）+ release identity + values YAML。status 含 phase / observed_version / observed_values_hash / `AttemptHash` / helm_revision。CRD 由 Worker 启动时 `EnsurePluginCRD` 自动 install
- **Worker reconciler**：controller-runtime watches Plugin CRD。Add finalizer 后跑 Helm；删除走 finalizer pattern。**install/upgrade 都用 `Wait + WaitForJobs + Atomic + 5min Timeout`**——Wait 解决 chart 内子组件依赖（如 victoria-metrics-k8s-stack 的 webhook race），Atomic 失败回滚不留半装状态
- **AttemptHash 防死循环**：每次 reconcile 前算 `sha256(chart.type + repo + name + version + sha256 + release.name + release.namespace + canonical(values))`。Phase=Running/Failed && AttemptHash 匹配 → 跳过。永久 Failed 改 spec / disable+re-enable 触发
- **Manager SSA**：处理 PluginCommand 时用 `client.Apply` + `FieldOwner("kpilot")` + `ForceOwnership` 写 CRD
- **离线 / 重连**：handler 提交前 `gw.GetWorker()` pre-flight；离线返 503 不写 DB。`handlePluginStatus` 用 upsert 自愈"push 成功 DB 写失败"。`Manager.handleDisable` 找不到 CRD 时 push 空 phase（→ Server 翻成 Disabled）
- **重连补发**（`gateway.replayPendingPluginCommands`）：Worker 重连后扫 `cluster_plugins`，对 `phase=Uninstalling && enabled=false` 重发 disable，对 `phase ∈ {Pending,Installing,Upgrading,Failed} && enabled=true` 重发 enable
- **Uninstalling 期间禁止 Enable**：`existing.Enabled == false` → 409 / `PLUGIN_UNINSTALLING`，避免在带 deletionTimestamp 的 CRD 上 SSA 改 spec
- **Helm chart cache**：本地 .tgz 存 `$DATA_DIR/charts/<sha256>.tgz`，atomic write + sha256 校验。Repo chart 在 `$DATA_DIR/helm/cache/` 缓存，`LoadChart` 命中跳过 Pull
- **Helm release storage**：secrets driver（v3 默认），keyed by (release_name, release_namespace)
- **失败错误展示**：Failed phase tag hover 弹 Popover（不是 Tooltip，可滚动 + 复制按钮 + `overscroll-behavior: contain`）
- **Reconcile-on-Watch 防抖**（`pkg/worker/plugin/reconciler.go::reconcileTriggerPredicate`）：只有 spec generation 变化、Create、Delete、新设 DeletionTimestamp 才触发 Reconcile。status-only 写入和 finalizer add/remove 不触发
- **Worker 注册 TOCTOU 保护**：`gateway.Connect` 的 occupied 检查 + slot 写入合并到单次 `g.mu.Lock()`
- **⚠️ Helm SDK 陷阱**：不要 `RunWithContext` + `defer cancel()`——install 成功后 deferred cancel 会污染 K8s client transport，后续无关 K8s 读全部静默挂死。用 `Run()` 不带 ctx，disable 期间的 install 等 Helm 自己 timeout（10min）

#### 4.2 Server 侧 values 占位符

`pkg/server/gateway/plugin.go::expandKPilotVars`——插件启用前 Server 把 values YAML 里的 `${KPILOT_*}` token 替换掉。token 必须 `[A-Z0-9_]+`（regex 强制大写）。

| Token | 含义 |
|---|---|
| `${KPILOT_CLUSTER_ID}` | 集群 UUID。反代插件用它构造 sub-path（如 Grafana root_url=`/api/v1/clusters/${KPILOT_CLUSTER_ID}/proxy/grafana/`） |
| `${KPILOT_CLUSTER_DOMAIN}` | K8s DNS suffix（默认 `cluster.local`，Worker register 时上报）。chart 默认 values 写死 in-cluster Service FQDN 时用 |

加新变量在 `expandKPilotVars` 的 map 加一行即可。

#### 4.3 Server 侧 dashboard overlay

`pkg/server/dashboards/`——Grafana 内置 dashboard JSON（NodeExporterFull ~660KB / VictoriaLogs Explorer ~30KB）通过 `//go:embed` 编译进 Server，在 `BuildEnableCommand` 里 deep-merge 到 Grafana plugin 的 values。**没塞进 default_values** 因为 700KB 会让 EnableDrawer 的 CodeMirror 卡死；用户 values 优先级高，可以覆盖任意 dashboard。

---

## 项目结构

```
kpilot/
├── cmd/
│   ├── server/              # Server 入口
│   └── worker/              # Worker 入口
├── pkg/
│   ├── server/
│   │   ├── api/
│   │   │   ├── handler/     # Gin Handler（auth、cluster、workload、plugin、proxy、gpu、ws helper、errors）
│   │   │   ├── middleware/  # JWT 中间件
│   │   │   └── router.go    # 路由注册
│   │   ├── store/           # PostgreSQL CRUD（GORM）
│   │   ├── dashboards/      # 内置 Grafana dashboard JSON（go:embed）+ overlay 合并器
│   │   ├── config/          # Server 环境变量
│   │   └── gateway/         # gRPC Server + Worker 连接管理 + ResourceRequest 路由 + 流式会话路由 + BuildEnableCommand
│   ├── worker/
│   │   ├── apis/v1alpha1/   # Plugin CRD Go 类型 + DeepCopy
│   │   ├── snapshot/        # client-go SharedInformerFactory（Node + Pod 缓存，给 gpu-summary 同步读用）
│   │   ├── plugin/          # Plugin CRD reconciler + Helm SDK + chart cache + manager
│   │   ├── proxy/           # K8s 资源代理（list/get/apply/update/patch/delete/describe + gpu-summary）+ LogsManager + ExecManager + HTTPProxy + WSManager
│   │   ├── config/          # Worker 环境变量
│   │   └── tunnel/          # gRPC Client（注册、心跳、消息分发）
│   └── common/
│       ├── proto/           # protobuf 生成代码（不手动编辑）
│       └── types/           # 共享类型
├── proto/                   # .proto 源文件
├── web/                     # 前端（见下方前端规范）
├── deploy/
│   ├── server/              # Server K8s manifests
│   └── worker/              # Worker Helm Chart
└── hack/                    # 脚本（proto 生成等）
```

```
web/src/
├── pages/
│   ├── user/login/          # 登录页
│   ├── Clusters/            # 集群管理 landing（卡片网格 + KPI + CRUD）
│   ├── ClusterDetail/       # 集群管理子页面（每个集群一份）
│   │   ├── Nodes/           # 节点概览：表格 + Detail/Yaml/Describe drawers + cordon
│   │   ├── Workloads/       # 工作负载：YamlEditor / ApplyYamlDrawer / DescribeDrawer / PodLogsDrawer / PodExecDrawer + CR 实例浏览器
│   │   ├── Plugins/         # 集群侧插件管理（启用 / 禁用 / 状态）
│   │   ├── Monitoring/      # 监控页（NodeExporterFull dashboard）
│   │   └── Logging/         # 日志页（VictoriaLogs Explorer K8S dashboard）
│   ├── Compute/             # 算力管理 — 顶级 landing（picker）+ Overview detail + 共享 useGPUData / DepGate / CardBody / format
│   ├── ModelHub/            # 模型管理 landing（P7 placeholder）
│   ├── Plugins/             # 全局插件注册表 CRUD
│   └── exception/404/
├── services/kpilot/         # API 服务（auth、cluster、node、workload、pod、plugin、gpu）
├── models/                  # Umi useModel 全局状态（namespace 等）
├── components/              # Footer、HeaderDropdown、RightContent、NamespacePicker、GrafanaEmbed
├── locales/                 # zh-CN / en-US（menu.ts、pages.ts）
└── app.tsx                  # 全局布局、动态菜单注入、认证初始化、顶部栏 actionsRender
```

---

## 技术栈

| 层 | 技术 |
|----|------|
| 后端语言 | Go 1.22+ |
| HTTP 框架 | Gin |
| gRPC | google.golang.org/grpc |
| ORM | GORM + PostgreSQL |
| K8s SDK | controller-runtime + client-go |
| Helm SDK | helm.sh/helm/v3 |
| 前端 | React + TypeScript + Ant Design Pro v6（UmiJS Max v4） |

### 认证
- JWT HS256，存储在 HTTP-only cookie `kpilot_token`，24h TTL
- 单租户：用户名/密码来自 Server 配置文件

### Server 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTP_ADDR` | `:8080` | HTTP 监听地址 |
| `GRPC_ADDR` | `:9090` | gRPC 监听地址 |
| `DSN` | `postgres://...` | PostgreSQL 连接串 |
| `ADMIN_USERNAME` | `kpilot` | 管理员用户名 |
| `ADMIN_PASSWORD` | `kpilot123` | 管理员密码 |
| `JWT_SECRET` | 随机 | JWT 签名密钥，未设置则每次重启失效 |
| `CORS_ORIGINS` | 空（开发宽松模式） | 生产环境设置前端域名，逗号分隔 |

### Worker 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SERVER_ADDR` | `localhost:9090` | Server gRPC 地址（Worker 视角） |
| `CLUSTER_TOKEN` | 空 | 必填，集群创建时 UI 一次性展示的 token |
| `DATA_DIR` | `/var/lib/kpilot` | 持久化根目录。`charts/` 放 Helm chart .tgz cache，`helm/` 放 Helm 仓库配置 + cache |
| `CLUSTER_DOMAIN` | `cluster.local` | K8s 集群 DNS 域。register 时上报给 Server，反代构 FQDN 时用 |
| `HELM_REPOSITORY_CONFIG` / `HELM_REPOSITORY_CACHE` | 空 | Helm SDK 自身 env，设了优先于 `DATA_DIR` 派生路径 |

### `.env` 加载
Server / Worker 启动时自动加载 cwd 下的 `.env`（godotenv），shell / pod env 优先（不会覆盖）。`.env.example` 在仓库根，`.env` 在 `.gitignore`。

### gRPC 配置
- Server 和 Worker 最大消息收发均为 **32 MB**

---

## 后端开发规范

### 错误返回（Server HTTP handler）
统一用 `pkg/server/api/handler/errors.go` 的三个 helper：
- `apiErr(c, status, code)` —— 已知错误码，前端按 `errors.{CODE}` 查表展示
- `apiErrInternal(c, err)` —— 服务器内部错误：实际错误打 log，对外只 500 + `INTERNAL_ERROR`
- `apiErrWorker(c, errMsg)` —— Worker / K8s API 返回的错误（validation、409 conflict 等）：透传消息，码为 `WORKER_ERROR`

新增错误码：在 `errors.go` 的 `Code*` 常量加一个，**同时**在 `web/src/locales/{zh-CN,en-US}/pages.ts` 的 `errors.{CODE}` 加翻译。

### 日志格式
统一 `log.Printf("[component] msg: key=value", ...)`：
- component 用小写横线（`gateway`、`pod-logs`、`pod-exec`、`proxy`、`tunnel`、`handler`）
- 数据用 `key=value` 风格便于 grep
- 错误用 `err=%v`

### 用户输入字段长度限制（三层一致）
任何用户输入的 string 字段，**DB 列类型 / 服务端 validator / 前端 maxLength** 三处必须配齐且数值一致：
- DB 列：用 `varchar(N)` 而不是 `text`，让 PostgreSQL 强制兜底
- 服务端：在请求 struct 的 `validate()` 方法里 `len(field) > maxXxxLen` 检查
- 前端：antd `<Input maxLength={N}>` / `<Input.TextArea maxLength={N} showCount>`

参考数值：DNS-1123 label（plugin name / namespace）= 63；display name = 100；description = 500；URL = 512；version = 64。

YAML / values blob（`plugin.default_values`、`cluster_plugin.values_override`）特例：服务端 64 KiB cap 兜底，前端 YAML 编辑器不加 `maxLength`。

### gRPC 与 Worker 通信
- **gRPC stream 写入必须串行化**：`grpc.ClientStream` / `grpc.ServerStream` 的 `Send` 不是并发安全的。Server 端用 `ConnectedWorker.sendMu`，Worker 端用 `Client.sendMu`
- **一次性请求-响应**（list/get/apply/update/patch/delete K8s 资源）：用 `gateway.SendResourceRequest(ctx, clusterID, req)`
- **流式会话**（Pod 日志 / exec / 反代 WebSocket）：用 `gateway.OpenStream(clusterID)` 拿 `*Stream`，`Stream.Send(payload)` 写、`<-Stream.Recv()` 读、`Stream.Close()` 关
- **Worker 断开时**：gateway `unregister` 自动 `closeClusterStreams` 清理所有该集群的活跃 stream

### K8s 资源代理（Worker 端）
- **列表**：用 K8s Table API（`Accept: application/json;as=Table;v=v1;g=meta.k8s.io`），仅传元数据 + 单元格值
- **GVK 来源**：server handler 的 `resolveGVK(c)` 把 URL `:type` 解析成 GVK：
  - 内置 kind：从 `resourceGVK` 白名单查
  - `_cr` 哨兵：从 query param `?group=&version=&kind=` 拿
  - 一处加 GVK 全部联通；新增内置 kind 加进 `resourceGVK` map 即可
- **资源客户端选择**（worker `proxy.resourceClient(mapping, namespace)`）：根据 `mapping.Scope` 自动决定 namespace-scoped 还是 cluster-scoped 路径。namespace-scoped + 空 namespace → fallback 到 `"default"`
- **写动作语义**（按用户意图选）：
  - `update`（PUT，dynamic.Update）—— **单条 Edit YAML 保存**（kubectl-edit）。body 必须含 `metadata.resourceVersion`，K8s 拒绝过期版本（409 conflict）
  - `apply`（Patch + ApplyPatchType，SSA，`fieldManager=kpilot`，`force=true`）—— **批量 Apply YAML 抽屉**（kubectl-apply 语义）。无需 resourceVersion，幂等
  - `patch`（Patch + StrategicMergePatchType，`fieldManager=kpilot`）—— **scoped 操作**（如 cordon），Server 端构造 patch body，客户端无法塞别字段
  - `delete`（dynamic.Delete）—— Apply YAML 抽屉的删除按钮也走这个
- **Describe**：`describe.DescriberFor(gk, cfg)` 优先（内置 kind 走专用 describer）；返回 `(nil, false)` 时 fallback 到 `describe.GenericDescriberFor(mapping, cfg)`（同 kubectl 自身的 fallback）
- **RESTMapper 缓存**：controller-runtime 的 `apiutil.NewDynamicRESTMapper` 自带 `lazyRESTMapper`，遇到 `meta.NoMatchError` 自动 reload + retry 一次。新装 CRD 后第一次查 GVK 它自己刷新
- **流式**（logs/exec）：单独的 manager（`LogsManager`、`ExecManager`），按 sessionID 维护 cancel func / pipe / chan，分发器的 stdin/resize/cancel handler 必须**快返回**

### 写操作 protection（基于已解析 GVK）
关键：**所有 protection 检查必须基于解析后的 GVK，不能依赖 URL `:type` 段**——`_cr` URL 同样可以指向任意 GVK，靠 `:type` 判断会被绕过。

四道闸门（在 `ApplyWorkload` PUT、`DeleteWorkload` DELETE、`validateDoc` 批量 YAML 三处统一应用）：

| 检查 | 触发条件 | 返回码 |
|---|---|---|
| `isProtectedNamespace(ns)` | namespace 以 `kube-` / `kpilot-` 开头 | 403 / `NAMESPACE_PROTECTED` |
| `isProtectedCRDDefinitionGVK(gvk, name)` | `apiextensions.k8s.io/v1 CRD` + `*.kpilot.io` 名 | 403 / `CRD_PROTECTED` |
| `isProtectedCRGroup(gvk.group)` | group `kpilot.io` 或 `*.kpilot.io` | 403 / `CRD_PROTECTED` |
| `isNoGenericWriteGVK(gvk)` | core `Node`（cordon 走专用端点） | 403 / `NODE_PROTECTED` |

Scoped action 端点的安全模式：
- 路径：`POST /api/v1/clusters/:id/workloads/<kind>/:name/<action>`
- Body：业务字段（如 `{cordon: bool}`），**不接受任意 patch / spec body**
- Server 自己拼 patch JSON（如 `{"spec":{"unschedulable":<bool>}}`）下发 Worker
- Worker 通过 `patch` action（StrategicMergePatchType）应用

### WebSocket（Server 端）
所有 WS 端点统一用 `pkg/server/api/handler/ws.go` 的 `wsConn` helper：
- `wsConn.WriteMessage` / `wsConn.WriteControl` 带 writeMu，**多 goroutine 并发写必须用它**（gorilla/websocket 写不是并发安全的）
- `wsConn.startHeartbeat(ctx)` 启动 ping/pong（pongWait 60s，pingPeriod 54s）
- handler 退出时 `defer hbCancel()` 停止 pinger goroutine

### 配置
- 全部走环境变量，集中在 `pkg/server/config/config.go` 的 `Load()`
- 默认值用 `getEnv(key, default)` 风格
- 列表型（如 `CORS_ORIGINS`）逗号分隔，解析时 trim space + 去空

### CORS
- 白名单制，从 `cfg.CORSOrigins` 读取
- 空列表 = dev 模式（任意 origin），生产必须显式设置
- 永远带 `Access-Control-Allow-Credentials: true`（前端依赖 cookie）

### 包组织
- `handler` 是纯 HTTP 转换层，**不直接写 SQL / 不调 K8s API**，所有外部依赖通过 `store` / `gateway` 接入
- `gateway` 既是 gRPC Server 又是 Worker 连接 + 流式会话的注册中心；HTTP handler 通过它发请求/开 stream，永远不要直连 Worker
- `proxy`（worker 端）所有 K8s 操作都走 controller-runtime / client-go 构建的 cfg，不要在 handler 层重新构造

### Proto 改动
1. 改 `proto/pilot.proto`
2. 跑 `bash hack/gen-proto.sh` 重新生成 `pkg/common/proto/*.pb.go`
3. 生成的文件**不手动编辑**

新增 oneof 变体时同步更新：
- gateway 的 `handleWorkerMessage` switch（如果 Worker → Server）
- worker tunnel 的 `handleServerMessage` switch（如果 Server → Worker）
- 流式消息：还要更新 `Stream.Send` 的 type switch、`tunnel.SendStreamMessage` 的 type switch

---

## 前端开发规范（web/）

### 技术栈
- UmiJS Max v4（`@umijs/max`）
- antd v6 + `@ant-design/pro-components` v3
- Tailwind v4（布局）+ `antd-style`（CSS-in-JS，需要主题 token 时）
- 国际化：zh-CN / en-US

### 4 平台路由结构

| 路径 | 名称 | 说明 |
|---|---|---|
| `/clusters` | 集群管理 | landing = 集群列表；进入集群后 `/clusters/:id/...` 注入 K8s 子菜单 |
| `/compute` | 算力管理 | landing = 集群 picker；进入集群后 `/compute/:id/overview` |
| `/models` | 模型管理 | landing = placeholder（P7 落地） |
| `/plugins` | 插件管理 | 全局 Helm 插件注册表 |

`extractClusterId(pathname)` 同时识别 `/clusters/:id` 和 `/compute/:id`，单一 `currentClusterId` 状态驱动两个平台的 sider sub-menu 注入（`menuDataRender`）。

### 新增页面三步
1. `src/pages/` 下新建组件
2. `config/routes.ts` 加路由
3. `src/locales/zh-CN/menu.ts` 和 `en-US/menu.ts` 加菜单翻译；页面内字符串加到对应的 `pages.ts`

### 常用组件
- 页面容器：`PageContainer`
- 表格：`ProTable`
- 表单：`ProForm` / antd `Form`
- 详情：`ProDescriptions`
- 卡片：`ProCard` / antd `Card`
- 弹窗：antd `Modal`、`Drawer`

查组件 props 用 `npx antd info <Component>`，获取示例用 `npx antd demo <Component> <name>`。

### 表格约定（必须遵守）
- 所有 `ProTable` 都加 `scroll={{ x: 'max-content' }}`：避免中文 header 被压成一字一行
- "操作"列必须 `fixed: 'right'`：横滚时按钮始终可见，且必须显式给 `width`

### Drawer 约定
- 用 `size`（v6.2+ 接 `number | string | 'default' | 'large'`），不要用已废弃的 `width`
- 必须加 `maskClosable={false}`：编辑/终端/日志类 Drawer 误点遮罩关掉损失太大；统一禁用，强制走右上角关闭按钮或取消按钮

### API 请求模式
```ts
// src/services/kpilot/xxx.ts
export function listXxx() {
  return request<XxxItem[]>('/api/v1/xxx', { method: 'GET' });
}
```
```tsx
// 页面组件 —— 必须加 formatResult: (res) => res
// @umijs/max 的 useRequest 默认会做 result?.data 提取，
// 而我们的 API 直接返回数组/对象（不是 { success, data } 包装格式），
// 不加这个选项数据会永远是 undefined。
const { data, loading } = useRequest(listXxx, {
  formatResult: (res) => res,
});
```

> ⚠️ **动态轮询**：`useRequest` 的 `pollingInterval` 在初始化后不响应 state 变更，不能用于运行时切换间隔。需要动态轮询时用 `useEffect + setInterval`：
> ```tsx
> useEffect(() => {
>   if (interval <= 0) return;
>   const t = setInterval(refresh, interval);
>   return () => clearInterval(t);
> }, [interval, refresh]);
> ```

> ⚠️ **抽屉 / 模态条件 fetch**：`useRequest({ ready, refreshDeps })` 在 deps 变化时**仍然触发一次**（即使 ready=false）。抽屉关闭时 props 从 `name='foo'` 变 `null`，会用 `null` 拼出 `/workloads/nodes/null` URL → K8s 404。改用 `manual: true` + 显式 `useEffect` 调 `run()`：
> ```tsx
> const { data, run, mutate } = useRequest(getNode, { manual: true });
> useEffect(() => {
>   if (open && name) run(clusterId, name);
>   else mutate(undefined);
> }, [open, name, clusterId]);
> ```

- 所有路径使用相对路径，dev 环境通过 `config/proxy.ts` 代理到 `http://localhost:8080`
- 认证依赖 HTTP-only cookie，不需要手动传 token

### i18n
所有用户可见字符串必须走 `useIntl().formatMessage({ id: '...' })`，不硬编码中文或英文。

### 集群详情导航（动态菜单）
- `app.tsx` 在 `@@initialState` 里跟踪 `currentClusterId`，`onPageChange` 监听 location 变化更新它
- `menuDataRender` 读 `currentClusterId`，有值就调用 `buildClusterSubMenu(id)` / `buildComputeSubMenu(id)` 注入子菜单
- ProLayout 配置：`splitMenus: true`（顶栏只显示一层）+ `suppressSiderWhenMenuEmpty: true`（无子菜单时侧边栏自动隐藏）+ `siderWidth: 220`（默认 208 在三级嵌套下截字）
- 菜单 i18n：name 字段会自动拼接父级 locale → `menu.{parent}.{name}`
- `menuItemRender` 始终用 `<Link>` 包裹 `defaultDom`，避免 Umi 默认实现给选中项跳过 Link 包裹导致的 1px 抖动

---

## 开发阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| P1 | 项目脚手架 + Proto 设计 + gRPC 连接/注册 + PostgreSQL schema + JWT 认证 | ✅ 完成 |
| P2 | 集群管理 UI + 节点概览（Table API proxy） | ✅ 完成 |
| P3 | 工作负载管理（CRUD 代理 + 通用 Apply YAML + Describe + Pod 日志/终端 + 全局命名空间选择器 + DRA 资源 v1） | ✅ 完成 |
| P4 | 插件系统（Plugin CRD + Helm SDK + Server 注册表 + 集群启用/禁用 + 状态同步 + 6 个内置插件） | ✅ 完成 |
| P5a | 算力管理：单页 dashboard（KPI 仪表盘 + 型号分布 + Top 占用 + 节点利用率网格 + 显卡/任务 Tabs）+ HAMi annotation 双格式解析 + Pod-to-card 归属 + Snapshot informer 缓存 | ✅ 完成 |
| P6 | 监控中心 + 日志中心（Grafana iframe + auth.proxy + HTTP/WS 反代 + 内置 dashboard overlay） | ✅ 完成 |
| P0' | 4 平台拆分（集群/算力/模型/插件 顶级化）+ Node 写操作收敛（cordon scoped 端点 + `_cr` URL 绕过修复 + 所有 protection 切到 GVK-based） | ✅ 完成 |
| P5b | 算力管理 → GPU 监控（DCGM Exporter 内置插件 + Grafana NVIDIA DCGM dashboard） | 待开始 ← 下一步 |
| P5c | 算力管理 → 任务调度（Volcano 内置插件 + Queue / Job / PodGroup CR 浏览器子页） | 待开始 |
| P5d | 算力管理 → 资源治理（Volcano queue 配额 + 设备健康告警 + GPU-Hour 计费报表） | 待规划 |
| P7a | 模型管理 → 模型仓库 + 内置预设（Qwen / DeepSeek / Llama 等 vLLM 启动模板） | 待开始 |
| P7b | 模型管理 → 推理部署 + 内置 chat 调试 + 可选反代 endpoint | 待开始 |
| P7c | 模型管理 → OpenAI 兼容路由（按 model 参数路由后端，灰度 / A/B） | 待规划 |
| P8  | 模型管理 → 训练任务（基于 Volcano，分布式 fine-tune 的 gang scheduling） | 待规划 |
