# 集群管理（`/clusters`）

> 上层文档：[CLAUDE.md](../CLAUDE.md)。本文档覆盖通用 K8s 管理面板的全部子页面。

通用 K8s 管理面板，不做 GPU / 模型相关的特殊化。

## 1. 集群列表（`/clusters`）

- 卡片网格 UI，每张卡显示集群状态 + 描述，整体可点 → 进入 K8s 详情
- 顶部 KPI 统计：总集群 / 在线 / 离线
- `tabular-nums` 防 10s 轮询时数字宽度抖动
- 卡片右上角 `...` Dropdown：编辑 / 重新生成 Token / 删除
- 删除集群级联清 `cluster_plugins` 行（事务，避免 FK 孤悬）
- 排序按 `created_at asc`，新加的不挤掉已有位置（用户按空间记忆）

## 2. 节点概览（`/clusters/:id/nodes`）

- 走通用 workloads proxy（`/workloads/nodes`，K8s Table API）
- 列定义直接来自 kubectl printer：NAME / STATUS / ROLES / AGE / VERSION / INTERNAL-IP / EXTERNAL-IP / OS-IMAGE / KERNEL-VERSION / CONTAINER-RUNTIME（跟 `kubectl get node -o wide` 对齐）
- STATUS 列识别 `Ready,SchedulingDisabled` 这种 kubectl 拼接格式，每段一个色 Tag
- ROLES 列 comma-split，每个角色单独 Tag
- COL_I18N map 把英文 printer header 翻译到 zh-CN
- **行操作四个按钮**：
  - **详情** → 调 describe，DescribeDrawer 显示文本 dump（事件、conditions、allocated 等）
  - **概览** → NodeDetailDrawer 结构化卡片：基本/网络/调度/资源/conditions/labels/annotations
  - **查看** → NodeYamlDrawer 只读 YAML
  - **禁用调度 / 启用调度** → cordon/uncordon
- **Node 写操作有专用 cordon 端点**：`POST /workloads/nodes/:name/cordon` body 仅 `{cordon: bool}`，Server 端构造 strategic merge patch `{"spec":{"unschedulable":<bool>}}`，客户端无法注入其他字段。语义比通用 PUT 更窄、更易审计；通用 PUT/DELETE 路径仍开放（写保护已下放给 K8s RBAC，见下文「写操作 protection」）

## 3. 工作负载（`/clusters/:id/workloads/:type`）

- 通过 Worker 代理 K8s API，支持完整 CRUD
- **菜单分组**：
  - 工作负载：Deployment / StatefulSet / DaemonSet / ReplicaSet / Pod / Job / CronJob / HPA
  - 网络：Service / EndpointSlice / Ingress / NetworkPolicy / GatewayClass / Gateway / HTTPRoute / GRPCRoute
  - 存储：PVC / PV / StorageClass
  - 配置：ConfigMap / Secret
  - 安全：ServiceAccount / Role / RoleBinding / ClusterRole / ClusterRoleBinding（RBAC 全套）
  - 策略：ResourceQuota / LimitRange / PodDisruptionBudget / PriorityClass / RuntimeClass（GPU / AI 调度场景下 PriorityClass + RuntimeClass 跟 Volcano 联动）
  - 扩展：CRD + DRA + 准入控制。DRA 子组含 ResourceClaim / ClaimTemplate / DeviceClass / ResourceSlice。准入控制子组含 ValidatingWebhookConfiguration / MutatingWebhookConfiguration / ValidatingAdmissionPolicy（K8s 1.30 GA）。三级嵌套缩进较深，全局 `siderWidth=220`（默认 208 会截断中文标签）
- **集群级资源**：`CLUSTER_SCOPED_TYPES`（`web/src/services/kpilot/workload.ts`）包含 `persistentvolumes` / `storageclasses` / `gatewayclasses` / `deviceclasses` / `resourceslices` / `customresourcedefinitions` / `clusterroles` / `clusterrolebindings` / `priorityclasses` / `runtimeclasses` / `validatingwebhookconfigurations` / `mutatingwebhookconfigurations` / `validatingadmissionpolicies` / `nodes`。这些资源的命名空间列与顶部 NamespacePicker 自动隐藏
- **DRA**：`resource.k8s.io/v1`（GA since K8s 1.34）。OrbStack 等发行版默认未开启 DRA feature gate，请求返回 `no matches for kind`；与 Gateway API 未安装 CRD 时为同款 graceful degradation
- 列表使用 K8s Table API（与 kubectl 默认展示一致），server 端计算列，仅传输元数据 + 单元格值
- 展示全部列（含 wide 列，等价于 `kubectl -o wide`）
- 服务端游标分页（`limit + continue` token）
- 工具栏：当前页客户端搜索（name + namespace + 所有动态列子串匹配）、手动刷新 + 定时刷新（5s/10s/30s/60s）
- **全局命名空间选择器**（顶部栏）：namespace-scoped 工作负载页面显示；cluster-scoped 资源自动隐藏；按集群独立保存；默认"全部命名空间"
- YAML 编辑器：CodeMirror 6，语法高亮，status 区块视觉变暗
- **编辑（kubectl-edit 语义）**：单条编辑使用 PUT（dynamic.Update），body 携带 `metadata.resourceVersion`；并发修改返回 409 → 前端展示 `WORKER_CONFLICT`
- **通用 Apply YAML 抽屉**：用户输入或拖拽 .yaml/.yml/.json，多文档以 `---` 分隔。两个按钮：
  - **应用**（POST `/apply`）：每条文档 SSA（`apply` action），kubectl-apply 语义
  - **删除**（POST `/delete-yaml`）：按 GVK + name + namespace 调用 `delete` action，kubectl-delete-f 语义；带 modal.confirm 二次确认
  - 失败列表支持「展开/收起」+ `maxHeight: 240px overflowY:auto`
  - 同款保护规则在 `validateDoc` 中基于解析 GVK 拦截（含 Node）
- **资源详情（Describe）**：操作栏「详情」按钮调用 `k8s.io/kubectl/pkg/describe`：内置 kind 走 `DescriberFor`（字段语义感知）；CRD/CR fallback 到 `GenericDescriberFor`。前端做最小化高亮（key 着色 + Events Type Normal/Warning 着色）
- **CR 实例浏览器**（CRD 行「查看实例」 → `/workloads/_cr?group=...&version=...&kind=...&scope=...`）：
  - 复用 WorkloadsContent，dynamic GVK 通过 URL query 传递，Worker 使用 `dynamic.Interface` + RESTMapper 解析
  - CRD 版本选择优先 storage version，否则首个 served version，最后 versions[0]
  - 标题 = Kind + 灰色 group/version 副标题，左侧带图标返回按钮
  - **菜单状态保持**：`/workloads/_cr` 在 `app.tsx buildClusterSubMenu` 注册为 CRDs 菜单的 `hideInMenu: true` 子路由
- **Pod 日志**：WebSocket 流式 follow，可选容器、tail 行数（100/500/1000/5000）、previous 实例；前端 rAF 节流避免高吞吐场景的渲染抖动；内置客户端 grep（200ms 防抖，字符串 / 正则双模式，匹配高亮 + "匹配 X / 共 Y 行" 计数）。`onclose` 区分 clean（code 1000/1005）vs abnormal，异常断开 Alert 带 **Reconnect** 按钮（bump `reloadKey` 重开 WS）
- **Pod 终端（Exec）**：xterm.js + FitAddon，Worker 端默认 `/bin/bash`，不存在时自动回退 `/bin/sh`；二进制 WS 帧（首字节为类型）。整个 Drawer 用 `React.lazy` code-split，xterm + addons + css ~150 KB gzip 只在首次打开终端时下载。WS abnormal close 同样带 Reconnect 按钮
- **Pod 即时指标**：Pods 行操作栏「指标」按钮 → `GET /api/v1/clusters/:id/pods/:namespace/:name/top`，Server 拉 `metrics.k8s.io/v1beta1 PodMetrics` 转成 `{containers: [{name, cpu_milli, memory_bytes}]}`。Drawer 自带 RefreshControl 风格的 off/5/10/30/60s 轮询 picker（默认 5s）；"no matches for kind PodMetrics" 与 "podmetrics ... not found" 都翻译成 404 / `RESOURCE_NOT_AVAILABLE`，前端显示「请确认 Metrics Server 插件已启用」+ 跳插件管理。**路由用 `/pods/...` 前缀而非 `/workloads/pods/...`**，避免 Gin v1.12 的 GET radix 树静态段 `pods` 抢走 `:type` 通配的所有 `/workloads/pods/...` 流量

### 运维调试端点

`GET /api/v1/metrics`（JWT 保护）返回当前进程的内部计数 snapshot：
- gateway：`workers` / `pending` (resource req) / `pendingHTTP` (proxy req) / `streams` 总数 + 按 cluster 分桶 / `pluginLogSessions`
- handler 缓存：`pluginResolve` / `proxySemaphores` / `vmResponse`（gpu-metrics + gpu-hour 共享 cache）
- runtime：`goroutines` / Go 版本

不是 Prometheus 文本格式，是给 operator 看的 JSON 调试面。生产想接 Prometheus 应该另开一个 OpenMetrics 端点（保持指标名稳定）。

### 写操作 protection

**没有**。早先版本在 `pkg/server/protect/` 维护过一组 7 类闸门（kube-system 命名空间 / kpilot CRD / Node 删除 / system: 前缀 RBAC / 默认 StorageClass / Helm-managed 资源），后来全部撤掉 —— 风险由管理员自行评估，server 不再代为兜底。前端 Workloads 操作列也无差别渲染 Edit / Delete 按钮。

K8s 自身的 RBAC + 各资源 controller 仍然是最后一道防线（删 `cluster-admin` 这类操作要么被 RBAC 拒，要么会被 controller 重建）。

Scoped action 端点的安全模式：
- 路径：`POST /api/v1/clusters/:id/workloads/<kind>/:name/<action>`
- Body：业务字段（如 `{cordon: bool}`），**不接受任意 patch / spec body**
- Server 端构造 patch JSON（如 `{"spec":{"unschedulable":<bool>}}`），通过 yamux STREAM_RESOURCE_REQUEST 下发 Worker
- Worker 通过 `patch` action（StrategicMergePatchType）应用

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
  - `patch`（Patch + StrategicMergePatchType，`fieldManager=kpilot`）—— **scoped 操作**（如 cordon），Server 端构造 patch body，客户端无法注入其他字段
  - `delete`（dynamic.Delete）—— Apply YAML 抽屉的删除按钮也走该 action
- **Describe**：优先 `describe.DescriberFor(gk, cfg)`（内置 kind 走专用 describer）；返回 `(nil, false)` 时 fallback 到 `describe.GenericDescriberFor(mapping, cfg)`（与 kubectl 自身的 fallback 一致）。kubectl 历史上对畸形 unstructured 有 panic 案例，所以 `describe()` 用命名返回 + `defer recover()` 把 panic 转成 fail 响应而不是杀 worker
- **RESTMapper 缓存**：controller-runtime 的 `apiutil.NewDynamicRESTMapper` 自带 `lazyRESTMapper`，遇到 `meta.NoMatchError` 会自动 reload + retry 一次。新安装 CRD 后首次查询 GVK 时自动刷新
- **操作超时拆分**：`readWorkerTimeout=120s`（list / get / describe / list-full）vs `writeWorkerTimeout=30s`（apply / update / patch / delete / cordon）。读路径放宽是因为大集群的 describe + 大 CRD list 在 30s 下经常 ctx.Err()；写路径保持紧因为它是有副作用的，admission webhook 卡住要尽快退出。Server handler 与 Worker proxy 两端用同一组数值，避免一端先放弃浪费另一端的工作
- **HTTP/WS 反代 URL scheme 校验**：`HTTPProxy.do` 和 `WSManager.Start` 入口校验 `req.Url` 必须是 http/https（WS 还允许 ws/wss），是防御纵深 —— Server 今天构造 FQDN 不会出问题，但 future regression 不应让 Worker 去 dial unix:// / file://
- **流式**（logs/exec/反代 WS）：分别由 `LogsManager` / `ExecManager` / `WSManager` 维护 sessionID → cancel func / pipe / chan 的映射，分发器的 stdin/resize/cancel handler 必须**快返回**。session ctx 派生自 `tunnel.Client.StreamContext()`，tunnel 断开时一并 cancel —— 不会等到下次 Send 失败才退出。Pod 日志另有 `maxLogBytes=64 MiB` 累计字节封顶，超过即 LogsEnd 关掉（chatty pod 长 follow 不会无限堆）；exec writer 写 tunnel 失败时调 onSendErr cancel 整个 session，避免 SPDY executor 在 Server 收不到的情况下继续跑用户 shell

## 4. 集群侧插件（`/clusters/:id/plugins`）

- 全局插件注册表的只读视图，每张卡片显示该集群上的 phase（Loading 转圈 / Running 绿勾 / Failed 红叉）
- 点击「启用」打开 drawer，可改 `version` 与 `values`；命名空间不可改（详见 [docs/plugins.md](plugins.md)）
- 详细启用机制见 [docs/plugins.md](plugins.md)

## 5. 监控 / 日志 / Grafana（`/clusters/:id/{monitoring,logging,grafana}`）

集群管理平台的可观测性三件套。两个**完全自绘**（监控 + 日志，直接打 VM / VictoriaLogs PromQL/LogsQL），一个 Grafana 反代兜底（escape hatch）。算力调度平台的 GPU / Volcano 相关页面同样走自绘形态；Grafana iframe 只保留给"power user 自定义任意 dashboard / datasource / alert"这个场景。

### 5.1 监控（`/clusters/:id/monitoring`）

自绘，**不嵌 Grafana**。**三 tab 结构** —— Cluster / Node / Pod —— 每 tab 内分组成多个 `LazySection`(IntersectionObserver 触发首次 mount,`usePollingRefresh` 只刷当前 tab + 已展开的 section)。硬依赖 `victoria-metrics`；`node-exporter` / `kube-state-metrics` / `cAdvisor (via kubelet)` 是软依赖,相应面板缺指标时走 Empty 状态,不阻塞页面。

- **后端四套端点**(`pkg/server/api/handler/{cluster,node,pod}_metrics.go` + `pod_health.go`),所有 metrics endpoint **接 `?groups=` filter**让前端按 section 独立 fetch:
  - `GET /cluster-metrics?range=1h|24h|7d|30d&groups=overview,capacity,workload`
    - **overview**:Snapshot KPIs(cpu/mem 百分比 + 绝对核数/字节 + nodesReady/Total + **podsByPhase + podsTotal + podsPending**)。**注意**:`podsByPhase` 必须在 overview 组,KPI 卡才能展示 phase 分布;早先放 workload 组导致 KPI 一直显示"KSM 未启用"
    - **capacity**:集群 CPU / mem / disk% 三条 trend series
    - **workload**:**pendingPods / restartRate / crashLooping** trend series。`pendingPods` 与 `crashLooping` 用 `sum(...gauge)` 而非 `count()` —— `kube_pod_status_phase` 是 0/1 gauge,count 数 series 条数(每 pod 都发一条 Pending series)而非真实 Pending pod 数;早先 count 写法导致"15 个 Pending"幻象
  - `GET /node-metrics?range=...&groups=cpu,mem,disk,network,storage` —— 每节点 series 按 5 个组拆分:
    - **cpu**:utilization、`load1` / `load5` / `load15` 原始负载、`loadPerCore`(按 core 归一)
    - **mem**:utilization% + `memUsed` 绝对字节
    - **disk**:utilization% + `diskPartitions` 按 mountpoint + inode%
    - **network**:net rx/tx、netErrors、`tcpConns`、tcpRetrans
    - **storage**:diskRead/Write 字节、diskReadOps/WriteOps、`diskIOWait` / `diskIOService` / `diskIOBusy` 按 device(单位 ms,前端 `unitScale=1000`)
    - server 端额外 `listNodeIPMap()` 一次 list Nodes 把 `instance="10.0.0.1:9100"` 翻译成 Kubernetes node 名字下发,所有 chart 统一显示 node 名(不是混 IP+hostname)
  - `GET /pod-metrics?range=...&namespace=...&podSearch=...&limit=20&groups=cpu,mem,network,io,throttle,memLimit` —— top-N pod series 按 6 组拆分。**关键**:`podSearch` 推到 PromQL `pod=~"(?i).*<q>.*"`,topk 在 search 结果集里取,避免"搜的 pod 不在 top-N → 客户端 filter 全空 → chart 空白"
  - `GET /pod-health?namespace=...&podSearch=...&limit=10` —— top-N 重启 / OOM 数表
- **共享层**:`pkg/server/api/handler/vm_query.go` 与 GPU 监控 / GPU-Hour / 设备健康同源;`vm_cache.go` 4s TTL response cache 跨 handler 共用 —— **三 tab 多 section 并发 fetch 在 4s 内自动 collapse 成单一上游 PromQL fan-out**
- **页面架构**(`pages/ClusterDetail/Monitoring/`):
  - `index.tsx` —— shell:range picker + RefreshControl + `<Tabs destroyOnHidden activeKey/>` + 共享 `MonitoringCtx`(clusterId / range / tick / activeTab / dark)
  - `MonitoringContext.tsx` —— context + `usePollingRefresh(refresh, active)` hook,只在 `tick` 变化且 section `active`(in active tab + 已展开)时调 refresh
  - `LazySection.tsx` —— Card 包裹器 + IntersectionObserver 触发首次 mount + Collapse 折叠态。`tab` prop 与 `activeTab` 比较决定 `active`,gate `polling refresh`
  - `ClusterTab.tsx` / `NodeTab.tsx` / `PodTab.tsx` —— 三 tab 实现:
    - **Cluster 三 section**:Overview(4 KPI 卡 `Progress.dashboard`)+ Capacity Trends(cpu/mem/disk 三图)+ Workload Health(pendingPods / restartRate / crashLooping)
    - **Node 五 section**(cpu / mem / disk / network / storage)+ 顶部**全局 multi-select 节点筛选**(取代旧版每 section 文本框)
    - **Pod 七 section**:Pod Health(table)置顶 + cpu/mem/network/io top-N + cpuThrottle/memLimit top-N。tab 顶部**全局 namespace picker + pod search**,通过 `podSearch` URL 参数推到 server 端
  - `MonitoringCharts.tsx` —— 共享 chart 组件,`React.lazy`,`@ant-design/plots` G2 runtime 不污染 cluster-detail 主 bundle。Legend 自绘 HTML(scrollable + click-toggle + 配色 pin)。chart 主标题 unit 为空时不渲染 `()`(避免"节点 Load Average（每核） ()"空括号)
- **antd Tabs `destroyOnHidden=true`**:切 tab 时整个子树 tear-down + 重新 mount。**绕开 G2 hidden-pane forceFit 污染** —— 早期版本切到其他 tab 后,新 tab 内容渲染让浏览器出垂直滚动条触发 `window.resize`,G2 在所有 chart 上跑 debounced forceFit,但 hidden chart container 的 `sizeOf` 返回 0,导致 chart 内部 layout 状态被污染,切回时无法恢复
- **首次加载占位**:早返回小 Spin 锚在页面顶部 48px 处,不用 body-spanning Spin。data 到了之后单卡 loading + RefreshControl 自带 indicator 接力

#### 跨 tab/页 scroll reset

监控页 + 日志页 + 模型调试 + GPU 监控页 mount 时遍历 ancestor 把 scrollTop 清零 + `window.scrollTo(0,0)` 兜底 —— 从其他可滚动页面切过来时,fixed-viewport 布局的 wrapper.top 用 `getBoundingClientRect()` 算高度,残留 scrollTop 会让 wrapper 出 viewport 之外。

### 5.2 日志（`/clusters/:id/logging`）

自绘 LogsQL 搜索 UI,**不嵌 Grafana**。硬依赖 `victoria-logs`;chart 自带 Vector DaemonSet 收集所有 Pod 日志,零额外插件。

- **后端两条端点**(`pkg/server/api/handler/logs.go`):
  - `GET /logs/search?query=...&from=...&to=...&limit=...` —— 匹配的日志行(默认 200,cap **50000**),**端到端真流式**(见下)
  - `GET /logs/histogram?query=...&from=...&to=...` —— 时间桶 count,桶宽 = `(to-from)/50` 自适应;非流式(数据小,~50 个 bucket)
  - **空 query**:后端默认转 `*`(=全部),与前端"留空 = 全部日志"一致;用户不用记得敲星号
- **`/logs/search` 真流式协议**(`vmlogs_stream.go::streamVMLogs` + `logs.go::GetLogsSearch`):
  - 走 `gateway.SendHTTPRequestStream`(共享 streaming 底座,见 [docs/models.md](models.md) OpenAI 兼容反代一节)接 VL `/select/logsql/query` 的 NDJSON 响应,**不全缓冲**。server 端 accumulator 按 `\n` 切完整行(跨 chunk 边界半截行留 buffer 等下一个),投影成 vmLogLine 后立刻 `sse.send("line", ...)` 流出
  - 单行 cap **1 MiB**(stack trace 异常长行的兜底),超限丢弃 + log,不影响后续解析
  - **SSE 事件 5 种**:`meta`(首发,query/from/to/limit) → `progress`(25s 一次心跳穿透 ingress idle timeout)→ `line`(每条日志一发) → `result`(终态总结 total/truncated/elapsedMs/endErr;**不带 lines[]**)→ `error`(dispatch 级失败)。前端 `services/kpilot/logs.ts::streamLogsSearch` 用 EventSource 解析,**按 50ms / 100 行 batch onLine** 给 virtuoso
  - **Stop 按钮**:`AbortController` → EventSource.close() → server `c.Request.Context().Done()` → ctx 撤销 → 已 defer 的 `stream.Close()` → yamux FIN → worker cancel-watcher 读 EOF → upstream HTTP ctx 撤销 → 立刻断 upstream,已加载的行保留显示
- **VL 未启用 / install 探测**:mount 时跑一个 60s 窗口的小直方图探测 RESOURCE_NOT_AVAILABLE,命中就走 `<NotInstalled>`

#### 前端 UX(`pages/ClusterDetail/Logging/`,11 项升级)

代码组织:`index.tsx`(page shell)+ `LoggingHistogram.tsx`(直方图 chart,lazy)+ `LogsQLHelp.tsx`(cheat-sheet popover)+ `queryUtils.ts`(query 解析 / merge / 关键词提取 / 转义 helper)。

- **顶部工具栏**:LogsQL 输入框(留空 = 全部 / 按 Enter 或点搜索 / suffix `?` 按钮 = LogsQL cheat-sheet)+ 命名空间 / Pod / **Container** 三级 picker + 时间范围 + 行数 Select(`100 / 500 / 1k / 5k / 10k / 50k` 六档替代原 free-form input)+ **Live tail** Toggle Button + Search/Stop + Reset
- **Live tail**:开关 ON 后每 2s 拉 `[lastLineTime+1ms, now]` 的新日志,新数据 **prepend 到顶部**(`kubectl logs -f` / `tail -f` 语义,VL 默认 newest-first 返回 batch 与 prepend 方向一致),并清空历史从头看;Stop 关掉 polling 也兼停 manual 搜索
- **直方图点击 zoom-in**:点 bar 自动把 range 改成 `{custom, from: bin.t, to: bin.t + step}` 并立即重 query(G2 `interval:click` 事件)。直方图默认折叠,title 行常显总匹配数 + 「展开 / 收起」link
- **行展开**:点击 log row 切 expanded —— message 是 JSON 时 `JSON.stringify(JSON.parse(m), null, 2)` pretty-print(只在 expanded 时 parse + useMemo cache,不浪费流式 append),`fields` map 渲染成 key/value 表
- **关键词高亮**:`extractHighlightTerms()` 从 LogsQL 剥 selector / `field:value` / 操作符 / 括号 / 引号后保留 word/phrase term,用 `<mark>` 包匹配文本(case-insensitive,phrase 优先)
- **Container picker**:pod 选定后 `getWorkload(clusterId, 'pods', name, ns)` 取 `spec.containers + spec.initContainers`,加第三级 Select。selector 自动补 `kubernetes.container_name="..."`
- **URL 持久化**:mount 时读 `?q=&range=&from=&to=&sinceNow=&limit=&ns=&pod=&container=`,有 query 类参数自动 auto-run;submit 后 `history.replaceState` 同步,不污染 back 栈
- **行级跳转**:row 内 pod tag 变 Dropdown(`筛选此 Pod` / `复制 Pod 名`)
- **LogsQL cheat-sheet popover**:`LogsQLHelp.tsx` —— 5 类共 17 条示例(文本 / 流标签 / 结构化字段 / 逻辑 / 管道),点击插入到 query 输入框 + 上游文档外链(https://docs.victoriametrics.com/victorialogs/logsql/)
- **stdout/stderr + log-level 高亮**:`stderr` Tag 是中性灰(Python logging / Go log / nginx 都默认 stderr,跟"错误"无关);红/橙 row 高亮改用应用的 `level` / `severity` / `lvl` 字段 —— `error / err / fatal / crit / critical / panic` 红边 + 浅红背景 + red Tag,`warn / warning` 橙边 + 浅橙背景 + orange Tag
- **Picker merge**:`mergeStreamSelector()` 只替换 query 头部 `{...}` 块,保留用户后续手写的 filter(早先无脑覆盖,用户加的 `| error` 子查询会被丢失)
- **Reset 按钮**:一键还原首次进页面状态(清 query / picker / lines / live tail / URL params)
- **结果列表**:virtuoso 虚拟列表(N 条行 DOM 恒定),每行带 timestamp + namespace Tag + pod Tag + container Tag + level Tag + message(等宽字体 + Markdown-style 关键词高亮)
- **截断 + partial-result banner**:仅在 result 事件 `truncated=true` 或 `endErr` 非空时显示

### 5.3 Grafana 兜底（`/clusters/:id/grafana`）

定位：power user 想直接进 Grafana 做任何事（自定义 dashboard / datasource / alert / 插件管理）的逃生通道。集群监控 / 日志走自绘页，普通用户用不到这个页。

- **iframe 反代**：浏览器看到 `/clusters/:id/grafana` 内嵌 iframe，src 指向 `/api/v1/clusters/:id/proxy/grafana/?theme=light|dark`。HTTP / WebSocket 请求都经 `pkg/server/api/handler/proxy.go` 走 worker tunnel
- **认证链**：浏览器 JWT → Server JWT middleware → `resolveUsername(c)` 提取用户名 → 反代时 inject `X-WEBAUTH-USER: <username>` + `X-WEBAUTH-ROLE: Admin` → Grafana auth.proxy 自动建账号 + 每请求重新读取角色。**`auth.proxy.headers: "Role:X-WEBAUTH-ROLE"` 是关键**：缺这行 Grafana 静默忽略 ROLE header，所有人卡在新建账号默认的 Viewer。`auto_assign_org_role: Admin` 是兜底新建账号也直接落 Admin，两道一致
- **主题同步**：KPilot 切主题 → effect 读 `iframe.contentWindow.location.href`（同源） → 改 `?theme=` 参数 → 写回 `iframe.src`
- **滚动隔离**：iframe 内 document 注入 `overscroll-behavior: contain`
- **`pluginResolveCache`**（30s TTL）：缓存 `(cluster, plugin) → release_namespace`，避免每个反代请求都 3 次 DB 查
- **Worker 反代**（`pkg/worker/proxy/http.go` + `ws.go`）：
  - `InClusterRouter` 24h TTL 缓存"直连 DNS dial / fallback K8s API service-proxy"决策。HTTP 与 WS 共用此 cache。Worker 在集群内 → 首请求后所有后续 in-cluster 流量直连 Service；本地 dev（worker 跨 kubeconfig/SSH tunnel）→ 缓存翻成 service-proxy，全后续走 apiserver 兜底
  - **service-proxy 回退踩过的两个坑**（已修）：
    1. client-go REST helper `rest.RESTClient.Do().Raw()` 只暴露 status + body，**所有上游 header 都吞掉**（Content-Type / Set-Cookie / Location 等）。前端表现：浏览器拿到 Grafana 响应没有 Content-Type → 当 octet-stream → 把 gzip 过的 HTML body 当 `.gz` 弹下载。修法：换成 `rest.HTTPClientFor` 构造的 `http.Client` + 手动 `http.Request`，正常 round-trip + 转发完整 header；同时 strip 浏览器的 `Accept-Encoding` 让 Go transport 自动解压
    2. K8s apiserver service-proxy transport（`apimachinery/pkg/util/proxy/transport.go`）**改写 text/html 响应 body**——给每个 URL 属性（`<base href>` / `<script src>` / `<link href>` 等）prepend `/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy`。K8s 写死的行为（为 `kubectl proxy --address` 工作模式服务），**没有 opt-out**。前端表现：base href 变成 `<apiserver-prefix><grafana-root-url>`，浏览器去加载 `/api/v1/namespaces/.../proxy/public/build/...`，kpilot 不路由 → "failed to load application files"。修法：worker 收响应后 `bytes.ReplaceAll(body, prefix, nil)` 反向擦掉前缀（仅 text/html，避免误伤 JSON / 二进制）
  - **Location 头不主动 strip**：apiserver 也改写 Location 头，但 Go 的 `http.Client` 默认 follow 重定向最多 10 跳，3xx 响应不会暴露给上游 —— 实际触发不到这条路径。结构上是缺陷，运行时被 Go transport 兜住
- **Grafana 配置要点**（`pkg/server/store/seed.go`，Grafana plugin row 的 `DefaultValues`）：
  - `auth.proxy` 启用 + `header_name: X-WEBAUTH-USER` + **`headers: "Role:X-WEBAUTH-ROLE"`**（必须） + `auto_sign_up=true`
  - `users.auto_assign_org_role: Admin`（与每请求 ROLE header 一致）
  - `serve_from_sub_path=true` + 相对 root_url 带 `${KPILOT_CLUSTER_ID}` 占位符
  - `[security] allow_embedding=true`
  - `[live] allowed_origins="*"` 让 Grafana Live WS 接受 KPilot 域 Origin
  - 预配 VictoriaMetrics（type=prometheus）+ VictoriaLogs（type=`victoriametrics-logs-datasource`，自动从 grafana.com 装 plugin）数据源 + 内置 dashboard overlay（`pkg/server/dashboards/`，NodeExporterFull / VL Explorer）
- **改 grafana.ini 生效**：seed.go 里的 DefaultValues 改了之后，**需要在插件管理页禁用再重新启用 Grafana**（或改 values_override 触发 Helm upgrade），ConfigMap 重写 → Pod 重启才能让新配置生效

## 集群详情导航（动态菜单）

- `app.tsx` 在 `@@initialState` 里跟踪 `currentClusterId`，`onPageChange` 监听 location 变化更新它
- `extractClusterId(pathname)` 同时识别 `/clusters/:id` 与 `/compute/:id`，单一 `currentClusterId` 状态驱动两个平台的 sider sub-menu 注入
- `menuDataRender` 读 `currentClusterId`，有值就调用 `buildClusterSubMenu(id)` / `buildComputeSubMenu(id)` 注入子菜单
- ProLayout 配置：`splitMenus: true`（顶栏只显示一层）+ `suppressSiderWhenMenuEmpty: true`（无子菜单时侧边栏自动隐藏）+ `siderWidth: 220`（默认 208 在三级嵌套下截字）
- 菜单 i18n：name 字段会自动拼接父级 locale → `menu.{parent}.{name}`
- `menuItemRender` 始终用 `<Link>` 包裹 `defaultDom`，避免 Umi 默认实现给选中项跳过 Link 包裹导致的 1px 抖动
