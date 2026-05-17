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
- Server 端构造 patch JSON（如 `{"spec":{"unschedulable":<bool>}}`），通过 gRPC 下发 Worker
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

自绘，**不嵌 Grafana**。三层下钻：集群 KPI / 节点级趋势 / Pod 级 top-N。硬依赖 `victoria-metrics`；`node-exporter` / `kube-state-metrics` / `cAdvisor (via kubelet)` 是软依赖，相应面板缺指标时走 Empty 状态，不阻塞页面。

- **后端四套端点**（`pkg/server/api/handler/{cluster,node,pod}_metrics.go` + `pod_health.go`）：
  - `GET /cluster-metrics?range=1h|24h|7d|30d` —— Snapshot（cpu/mem 百分比 + 绝对核数 / 字节 + nodesReady/Total + podsByPhase + podsTotal + **podsPending**）+ trend series（cluster cpu / mem / **pendingPods**）
  - `GET /node-metrics?range=...` —— 每节点 series：cpu / mem / disk% / **disk read/write 字节** / **diskReadOps / diskWriteOps** / net rx tx / **loadPerCore** / **netErrors** / **inodeUtil** / **tcpRetrans**
  - `GET /pod-metrics?range=...&namespace=...&limit=20` —— top-N pod series：cpu cores / mem bytes / net rx tx / **cpuThrottle %** / **fsRead / fsWrite** / **memLimitRatio %**
  - `GET /pod-health?namespace=...&limit=10` —— top-N 重启 / OOM 数表（`kube_pod_container_status_restarts_total` + `container_oom_events_total` 两路 PromQL 并发，按 (ns, pod) 合并，行=0 的 pod filter 掉）
- **共享层**：`pkg/server/api/handler/vm_query.go`（`resolveVMQueryURL` + `queryVM`/`queryVMRange`）与 GPU 监控 / GPU-Hour / 设备健康同源；`vm_cache.go` 4s TTL response cache 跨这几个 handler 共用，cache key 用 `tag + clusterID + 子键` 防碰撞
- **VM 未启用**：`resolveVMQueryURL` 返回 `RESOURCE_NOT_AVAILABLE` → 前端走共享 `<NotInstalled>`
- **页面布局**（`pages/ClusterDetail/Monitoring/index.tsx`）：
  - 顶部 range picker（1h/24h/7d/30d）+ RefreshControl
  - **4 KPI 卡**（共享 `KPICard` 容器，flex-column-justify-between body 保证 4 张卡等高）：节点就绪 / 集群 CPU 利用率（+ 绝对核数）/ 集群内存（+ GiB）/ Pod 数（按 phase 拆分 + Pending 数字 Tag）。每张卡 `Progress.dashboard` 环形仪表盘，配色按通用阈值
  - **集群趋势区**：CPU / 内存 / Pending Pod 三张时序图
  - **Pod 健康表**：top-10 重启 / OOM 一表，无异常时走 Empty
  - **节点区**：节点名搜索框（客户端筛选）+ 10 张图（cpu/mem/disk% + disk I/O + IOPS + net + load/core + net errors + inode + TCP retrans）
  - **Pod 区**：**本地命名空间 picker**（不连全局 `useModel('namespace')`，进页面默认全部 ns）+ pod 名搜索框（**只匹配 pod 部分**，ns/pod 前缀作为 legend 区分）+ 6 张图（cpu/mem/net + cpuThrottle/mem-limit ratio/fs read+write）
- **首次加载占位**：早返回小 Spin 锚在页面顶部 48px 处，**不**用 body-spanning Spin（否则在长页面纵向居中要滚屏才看到）。data 到了之后单卡 loading + RefreshControl 自带 indicator 接力
- **chart 组件**：`MonitoringCharts.tsx` 走 `React.lazy`，`@ant-design/plots` G2 runtime 不污染 cluster-detail 主 bundle。Legend 是自绘 HTML（scrollable + click-toggle + 配色 pin），不用 G2 自带 legend（many-series 时 G2 内置布局会截断到前 5 个）

### 5.2 日志（`/clusters/:id/logging`）

自绘 LogsQL 搜索 UI，**不嵌 Grafana**。硬依赖 `victoria-logs`；chart 自带 Vector DaemonSet 收集所有 Pod 日志，零额外插件。

- **后端两条端点**（`pkg/server/api/handler/logs.go`）：
  - `GET /logs/search?query=...&from=...&to=...&limit=...` —— 匹配的日志行（默认 200，cap 1000）
  - `GET /logs/histogram?query=...&from=...&to=...` —— 时间桶 count，桶宽 = `(to-from)/50` 自适应
  - **空 query**：后端默认转 `*`（=全部），与前端"留空 = 全部日志"一致；用户不用记得敲星号
- **VL 未启用 / install 探测**：mount 时跑一个 60s 窗口的小直方图探测 RESOURCE_NOT_AVAILABLE，命中就走 `<NotInstalled>`，用户不用先敲 query 才知道未启用
- **页面布局**（`pages/ClusterDetail/Logging/index.tsx`）：
  - **顶部 LogsQL 输入框**：留空 = 全部，placeholder 给示例。按 Enter 或点搜索触发
  - **命名空间 + Pod 选择器**：**本地 state**（不连全局 namespace model），自动构建 LogsQL stream selector 并**回填到输入框**（用户能继续在末尾加管道过滤如 `| error`）。字段名用 `kubernetes.pod_namespace` / `kubernetes.pod_name`，与 Vector kubernetes_logs source 默认 schema + 内置 dashboard JSON 同款。Pod 列表来自 `/workloads/pods`，**注意它返回 K8s Table 表示**（`rows[].object.metadata.name`），不是 List with `.items`
  - **range** preset：5m / 15m / 1h / 6h / 24h
  - **行数 limit**：默认 200，cap 1000
  - **直方图**：上方一张 Vector + 总数 caption（`LoggingHistogram.tsx` lazy load）
  - **结果列表**：每行带 timestamp + namespace Tag + pod Tag + container Tag + message，等宽字体，垂直滚动 600px

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
