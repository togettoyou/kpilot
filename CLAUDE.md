# KPilot

**A Kubernetes-native GPU orchestration pilot.**

核心架构：Server（中心控制面）+ Worker（集群侧 Operator），通过 gRPC 双向流连接。

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
  │  controller-runtime (Watch)
  ▼
K8s Cluster
```

---

## Worker 注册流程

1. 管理员在 Server UI 创建集群条目
2. Server 生成唯一 ClusterToken（只展示一次，可在 UI 重新生成）
3. 管理员将 ClusterToken + Server gRPC 地址配置到目标集群，部署 Worker（部署 YAML 待补充）
4. Worker 启动，携带 Token 发起 gRPC 连接
5. Server 验证 Token，将连接与集群绑定，标记集群 Online

---

## gRPC 协议

单条双向流，用 `request_id` 实现请求-响应配对，同时支持 Worker 主动 Push。

**Worker → Server（WorkerMessage）：**
- `Register`（携带 Token） / `Heartbeat`
- `NodeListPush`（Node 变更事件驱动上报；重连注册成功后立即推送一次全量）
- `ResourceResponse`（list/get/apply/delete/describe 共用）
- `PluginStatusPush`
- `LogsChunk` / `LogsEnd`（Pod 日志流）
- `ExecOutput` / `ExecEnd`（Pod 终端流）

**Server → Worker（ServerMessage）：**
- `RegisterAck`
- `ResourceRequest`（list/get/apply/delete/describe）
- `PluginCommand`（enable / disable）
- `LogsStartRequest` / `LogsCancelRequest`
- `ExecStartRequest` / `ExecStdin` / `ExecResize` / `ExecCancelRequest`

三种通信模式：
- **Push**：Worker 主动上报（`request_id` 为空），事件驱动或重连触发（如 NodeListPush、PluginStatusPush）
- **Request-Response**：Server 带 `request_id` 发请求，Worker echo 同 ID 回去（list/get/apply/delete/describe）
- **流式会话**：`request_id` 复用为 sessionID，双向多消息往返直到 `*End` 或显式 cancel（Pod 日志 / 终端）

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

**内置插件**（6 个，category 维度组织）：

| 插件            | 分类       | Chart 来源 | 用途                                          |
|-----------------|-----------|-----------|------------------------------------------------|
| HAMi            | gpu       | repo      | GPU 虚拟化，给 Node 打 GPU 标签，支持 vGPU 管理     |
| VictoriaMetrics | monitoring| repo      | 单节点 TSDB，自带 Web UI + scrape 配置             |
| Node Exporter   | monitoring| repo      | 节点级硬件 + OS 指标（搭 VM 用）                  |
| Grafana         | monitoring| **oci**   | 可视化前端，反代嵌入 + 内置 dashboard + auth.proxy  |
| VictoriaLogs    | logging   | repo      | 日志存储 + 自带 Vector DaemonSet 采集             |
| Envoy Gateway   | networking| **oci**   | Gateway API 实现，演示 OCI registry chart 装载    |

---

## 功能模块

### 1. 集群管理
- 创建集群条目，生成并展示 ClusterToken（仅创建时显示一次）
- **卡片网格 UI**（不是表格）：每个集群一张可点卡片，整体可点 → 跳节点页；右上角 `...` Dropdown 装编辑 / 重新生成 Token / 删除三个动作
- **顶部 KPI 统计**：总集群数 / 在线 / 离线，三个色块图标（蓝 / 绿 / 灰）+ 大数字。`tabular-nums` 防 10s 轮询时数字宽度抖动
- **稳定排序**：DB 按 `created_at asc`（老的在前），新增集群追加到网格末尾，不挤掉已有的位置（用户按空间记忆）
- 编辑集群名称和描述、重新生成 Token（旧 Token 立即失效）、删除集群
- 删除集群级联清 `cluster_plugins` 行（事务，避免 FK 孤悬）

### 2. 节点概览
- 展示集群所有节点信息
- 数据来源：Worker 读取 K8s Node 对象（标准字段 + HAMI 写入的 GPU 标签）
- 字段：CPU（可分配/总量）、内存（可分配/总量）、GPU 型号、GPU 数量

### 3. 工作负载管理
- 通过 Worker 代理 K8s API，支持完整 CRUD（列表、查看 YAML、编辑、删除）
- **菜单分组**（在「集群管理 / 集群详情」下动态注入）：
  - 工作负载：Deployment / StatefulSet / DaemonSet / Pod / Job / CronJob / HPA
  - 网络：Service / Ingress / GatewayClass / Gateway / HTTPRoute / GRPCRoute
  - 存储：PVC / PV / StorageClass
  - 配置：ConfigMap / Secret
  - 扩展：CRD（菜单缩写「CRD」，跟 PVC/PV 同风格）
- **集群级资源**：`CLUSTER_SCOPED_TYPES`（在 `web/src/services/kpilot/workload.ts` 共享给页面 + NamespacePicker）目前包含 `persistentvolumes` / `storageclasses` / `gatewayclasses` / `customresourcedefinitions`。这类资源命名空间列和顶部命名空间选择器都自动隐藏
- 列表使用 K8s Table API（同 kubectl 默认展示，server 端计算列，仅传输元数据+单元格值，不传输完整 YAML）
- 展示全部列（含 wide 列，等价于 `kubectl -o wide`）
- 服务端游标分页（limit + continue token），支持前后翻页
- 工具栏：当前页客户端搜索（name + namespace + 所有动态列子串匹配）、手动刷新 + 定时刷新（5s/10s/30s/60s）
- **全局命名空间选择器**（顶部栏）：namespace-scoped 工作负载页面显示；cluster-scoped 资源（PV / SC / GatewayClass / CRD / Cluster CR）自动隐藏；按集群独立保存；默认"全部命名空间"，支持客户端搜索 + 刷新。判定逻辑跟页面 `isClusterScoped` 同源（CR 实例浏览器读 URL `?scope=` query）
- **三层保护**（前端隐藏按钮，后端 403 兜底）：
  - 命名空间：`kube-*` / `kpilot-*` 只读（`NAMESPACE_PROTECTED`）。`kube-*` 防误删控制面；`kpilot-*` 是内置插件安装的命名空间（gpu / monitoring / logging / networking），管理走插件页
  - CRD 定义：`*.kpilot.io` 名结尾的 CRD 拒绝改/删（`CRD_PROTECTED`），删了 `plugins.kpilot.io` 整套 reconciler 就废了
  - CR 实例：`*.kpilot.io` group 的 CR（如 `Plugin`）也是 reconciler-managed，单条 PUT/DELETE 和批量 Apply YAML / Delete YAML 都拒绝
- YAML 编辑器：CodeMirror 6，有语法高亮，status 区块视觉变暗（不可改）
- **编辑（Update / kubectl-edit 语义）**：单条编辑走 PUT（dynamic `Update`，body 携带 `metadata.resourceVersion`），并发改返 409 → 翻成 `WORKER_CONFLICT`。最初实现是 SSA + force=true，但 HPA 字段抢权 + 无并发保护跟用户预期不符
- **通用 Apply YAML 抽屉**：用户输入或拖拽上传 .yaml/.yml/.json，多文档 `---` 分隔。两个按钮：
  - **应用**（POST `/apply`）：每条 SSA（`apply` action），kubectl-apply 语义
  - **删除**（POST `/delete-yaml`）：按 GVK + name + namespace 调 `delete` action，kubectl-delete-f 语义。带 modal.confirm 二次确认
  - 失败列表带「展开/收起」+ `maxHeight: 240px overflowY:auto`，否则 13 条失败一堆能把编辑器挤出可视区
- **资源详情（Describe）**：所有工作负载操作栏带"详情"按钮，调用 `k8s.io/kubectl/pkg/describe`：内置 kind 用 `DescriberFor`（专用，字段语义感知）；CRD/CR fallback 到 `GenericDescriberFor`（同 kubectl 行为，反射打印 + 事件块）。前端做最小化高亮（key 着色 + Events Type Normal/Warning 着色）
- **CR 实例浏览器**（CRD 行「查看实例」 → `/workloads/_cr?group=...&version=...&kind=...&scope=...`）：
  - 复用 WorkloadsContent，dynamic GVK 通过 URL query 透传，Worker 用现成的 `dynamic.Interface` + RESTMapper 解析
  - 选 CRD 版本时优先 storage version，fallback 到首个 served version，最后 versions[0]
  - 标题 = Kind + 灰色 group/version 副标题，左边图标返回按钮（Tooltip 提示），三个 Text 元素都 `nowrap`
  - **菜单状态保持**：`/workloads/_cr` 在 `app.tsx buildClusterSubMenu` 里登记成 CRDs 菜单的 `hideInMenu: true` 子路由，ProLayout 即可保留 Extensions 分组打开 + CRDs 高亮
- **Pod 日志**：WebSocket 流式 follow，可选容器、tail 行数（100/500/1000/5000）、previous 实例；前端 rAF 节流避免高吞吐场景的渲染抖动；自带客户端 grep（200ms 防抖，纯字符串/正则双模式，匹配高亮 + "匹配 X / 共 Y 行" 计数）
- **Pod 终端（Exec）**：xterm.js + FitAddon，Worker 端默认 `/bin/bash`，不存在自动回退 `/bin/sh`；二进制 WS 帧（首字节为类型）

### 4. 插件管理
两层界面，全局 + 集群侧分工明确：
- **全局插件管理**（顶部菜单 `/plugins`）：Helm Chart 注册表的 CRUD。卡片按 category 分组（gpu / scheduling / networking / storage / monitoring / logging / security / serving / custom）。内置插件只读（带「内置」金色 tag），自定义可编辑/删除/查看
- **集群侧插件管理**（侧边菜单 `/clusters/:id/plugins`）：注册表的只读视图，每张卡显示该集群上的 phase（带动态 icon：spinning Loading / 绿勾 Running / 红叉 Failed），点「启用」打开 drawer 配置 values/version/namespace 后下发 Helm install
- **添加插件**：name (DNS-1123) + 分类 + Helm chart 来源 + 默认 values（YAML 编辑器）+ 默认安装命名空间。Chart 三种来源（前端 Radio 三选项 + 后端 ChartType enum，对称色 tag：cyan / geekblue / purple）：
  - `repo` —— 传统 HTTPS Helm 仓库（`chart_repo` + `chart_name` + 版本，需要 index.yaml）
  - `oci` —— OCI registry（Helm 3.8+，`chart_repo` 存完整 `oci://` URL，`chart_name` 不用）。Helm 内部走 `registry.NewClient()` + `cfg.RegistryClient`，**v1 只支持公开 registry**，私有 auth 之后再加
  - `local` —— 上传 .tgz blob，sha256 内容 dedupe
- **启用流程**：Server merge 注册表默认 + 集群覆盖 → PluginCommand 经 gRPC 推 Worker → Worker manager SSA 写 Plugin CRD → controller-runtime Reconciler 跑 Helm install/upgrade（Wait + Atomic + 5min Timeout）→ PluginStatusPush 实时回报状态
- **死循环防护**：CRD status 带 AttemptHash（输入指纹），同输入 Failed 不再自动重试，避免持续 rollback。要重试改 values 或 disable+re-enable
- **离线保护**：handler 提交前 pre-flight 检查 Worker 是否在线，离线直接 503 不污染 DB；handleDisable 找不到 CRD 时主动 push Disabled 兜底卡死的 Uninstalling
- **重连补发**（`gateway.replayPendingPluginCommands`）：Worker 重新注册后扫 `cluster_plugins`，对 `phase=Uninstalling && enabled=false` 重发 disable，对 `phase ∈ {Pending,Installing,Upgrading,Failed} && enabled=true` 重发 enable。两个分支都查 `enabled` 防 race（用户在 worker offline 时改了状态）
- **Uninstalling 期间禁止 Enable**（`existing.Enabled == false` → 409 / `PLUGIN_UNINSTALLING`）：避免在带 deletionTimestamp 的 CRD 上 SSA 改 spec → finalizer 删除 → 行卡 `enabled=true, phase=Pending` 但集群上没 CRD
- **AttemptHash gate 命中也推 status**：reconciler 进入 `Phase=Running/Failed && AttemptHash 匹配` 分支时，return 之前主动 push 一次 status。覆盖"Worker 装完但 push 没出去 → 重连后 SSA no-op → reconciler gate 命中静默退出 → Server 永远卡在 Pending"的边角
- **删除保护**：自定义插件被任意集群启用中（phase != Disabled）时 DELETE 返回 409 / `PLUGIN_IN_USE`
- **Namespace 锁**：`helm_revision > 0` 后改 release_namespace_override 返回 400 / `PLUGIN_NAMESPACE_LOCKED`，避免 Helm release 在旧 ns 孤悬
- **失败错误展示**：Failed phase tag hover 弹 Popover（不是 Tooltip，可滚动 + 复制按钮 + `overscroll-behavior: contain` 防屏抖）
- **重置默认**：Enable drawer 左下角「重置为默认」按钮，按当前注册表 default_values 重新 prefill
- **内置插件**（6 个，详见上方"支持的插件"表）：HAMi（GPU，repo）/ VictoriaMetrics（monitoring，repo）/ Node Exporter（monitoring，repo）/ Grafana（monitoring，**oci**）/ VictoriaLogs（logging，repo）/ Envoy Gateway（networking，**oci**）。Envoy Gateway 是 OCI 类型的演示，引用 `oci://docker.io/envoyproxy/gateway-helm v1.7.2`；Grafana 引用 `oci://ghcr.io/grafana-community/helm-charts/grafana 12.3.0`，预配 auth.proxy + sub-path embed + VL/VM datasource + 两个内置 dashboard
- **Server 侧 values 占位符**（`pkg/server/gateway/plugin.go::expandKPilotVars`）：插件启用前 Server 把 values YAML 里的 `${KPILOT_*}` token 替换掉。两个变量：
  - `${KPILOT_CLUSTER_ID}` —— 集群 UUID。反代插件用它构造 sub-path（如 Grafana root_url=`/api/v1/clusters/${KPILOT_CLUSTER_ID}/proxy/grafana/`）
  - `${KPILOT_CLUSTER_DOMAIN}` —— K8s DNS suffix（默认 `cluster.local`，Worker 在 register 时上报）。chart 默认 values 写死 in-cluster Service FQDN 时用它
  - 加新变量：`BuildEnableCommand` 里 `expandKPilotVars` 的 map 加一行就够。token 必须 `[A-Z0-9_]+`（regex 强制大写）
- **Server 侧 dashboard overlay**（`pkg/server/dashboards/`）：Grafana 的两个内置 dashboard JSON（NodeExporterFull ~660KB / VictoriaLogs Explorer ~30KB）通过 `//go:embed` 编译进 Server 二进制，在 `BuildEnableCommand` 里 deep-merge 到 Grafana plugin 的 values（仅 Grafana 走这条路径）。**没塞进 default_values** 因为 700KB 会让 EnableDrawer 的 CodeMirror 卡死；用户 values 优先级高，可以覆盖任意 dashboard
- **Reconcile-on-Watch 防抖**（`pkg/worker/plugin/reconciler.go::reconcileTriggerPredicate`）：controller-runtime watch 加了 predicate，只有 spec generation 变化、Create、Delete、新设 DeletionTimestamp 才触发 Reconcile。status-only 写入和 finalizer add/remove 不触发——避开了"reconcile 自己写 status → 触发自己 → cache 没同步 → race"的 install-then-immediate-upgrade bug

### 5. GPU 管理
- 依赖 HAMI 插件
- 管理 vGPU 分配，查看 GPU 使用详情（已分配/总量算力、显存）

### 6. 模型管理
- LLM 部署管理（创建/查看/删除推理服务）
- 后续结合 KServe

### 7. 监控中心 / 日志中心
两个页面共享 `web/src/components/GrafanaEmbed/`，区别只在依赖列表 + dashboard UID + i18n 前缀。
- **路由**：`/clusters/:id/monitoring`（依赖 Grafana + VictoriaMetrics，dashboard UID `rYdddlPWk`）；`/clusters/:id/logging`（依赖 Grafana + VictoriaLogs，dashboard UID `g6mvjz`）
- **依赖检查**：拉 `/api/v1/clusters/:id/plugins`，按 phase 分四桶（ready / installing / failed / missing）。allReady → 渲染 iframe；其他状态显示 antd `Result` 提示对应错误，installing 期间每 5s 自动 poll 直到完成
- **iframe URL**：`/api/v1/clusters/:id/proxy/grafana/d/<dashboardUID>/?theme=light|dark`。`<dashboardUID>` 直接打开对应面板，`?theme=` 跟随 KPilot 当前主题（`useThemeMode().isDarkMode`），覆盖 Grafana 自身的 default_theme
- **主题同步**：KPilot 切主题 → effect 读 `iframe.contentWindow.location.href`（同源所以可读）→ 改 `?theme=` 参数 → 写回 `iframe.src` → iframe 重载但保持当前 dashboard 路径
- **滚动隔离**：iframe 内部 document（同源）的 `documentElement` 和 `body` 注入 `overscroll-behavior: contain`，从根上让 scroll-chain 死在 iframe 文档里，宿主页 footer 不动；wrapper 高度 = `window.innerHeight - rect.top`（loop-free 测量）
- **Worker 反代后端**（`pkg/server/api/handler/proxy.go`）：所有 grafana 流量走 KPilot Server 反代→gRPC tunnel→Worker→集群内 Service。HTTP 请求/响应走 `SendHTTPRequest`（一次性，body ≤31MB），WebSocket 走 `OpenStream`（复用 Pod logs/exec 的 Stream 框架）。`proxiableServices` map 是反代白名单（目前只 grafana）
- **认证链**：浏览器带 KPilot JWT → Server JWT middleware 验证 → `resolveUsername(c)` 提取用户名 → 反代时 inject `X-WEBAUTH-USER` header → Grafana auth.proxy 模块自动建用户登录（auto_sign_up=true，role=Viewer 只读）。`kpilot_token` cookie 通过 `filterKPilotCookies` 精确剥离，Grafana 自己的 session cookie 保留以维护 CSRF / org context
- **`proxyResolveCache`**（30s TTL）：反代 handler 走热路径时不查 DB，缓存 `(cluster, plugin) → (release_namespace, Phase=Running)`。Grafana dashboard 加载会 fan-out 30+ 并发资源请求，没 cache 每个都 3 次 DB 查。Enable/Disable handler 显式 invalidate
- **Grafana 配置要点**（`pkg/server/store/seed.go::Grafana`）：
  - `auth.proxy` 启用 + auto_sign_up + Viewer 角色（只读 embed）
  - `serve_from_sub_path=true` + 相对 root_url 带 `${KPILOT_CLUSTER_ID}` 占位符
  - `[security] allow_embedding=true` 让 iframe 嵌入不被 X-Frame-Options 拦
  - `[live] allowed_origins="*"` 让 Grafana Live WS 接受 KPilot 域的 Origin
  - `[users] default_theme=system` 跟随 OS 偏好（被 `?theme=` URL 参数覆盖）
  - 预配 VictoriaMetrics（type=prometheus，走 VM 的 Prometheus API 兼容）和 VictoriaLogs（type=`victoriametrics-logs-datasource`，需要 chart 的 plugins 列表自动从 grafana.com 装 plugin）datasource
- **Worker 上报 cluster_domain**：`RegisterRequest.cluster_domain` 字段，默认 `cluster.local`，可通过 worker 端 `CLUSTER_DOMAIN` env 覆盖。Server 不在 K8s 也能正确构 FQDN

### 反代 proto 消息（`proto/pilot.proto`）

| 消息 | 方向 | 说明 |
|------|------|------|
| `HTTPRequest` | Server→Worker | 一次性反代，body inline |
| `HTTPResponse` | Worker→Server | 配 request_id 回包 |
| `WSStartRequest` | Server→Worker | 启动 WS 反代 session |
| `WSFrame` | 双向 | 数据帧（opcode + bytes），browser↔upstream |
| `WSEnd` | 双向 | RFC 6455 close code + reason |

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
│   │   │   ├── handler/     # Gin Handler（auth、cluster、node、workload、pod、ws helper、errors）
│   │   │   ├── middleware/  # JWT 中间件
│   │   │   └── router.go    # 路由注册
│   │   ├── service/         # 业务逻辑层（待实现，目前 handler 直接调 store + gateway）
│   │   ├── store/           # PostgreSQL CRUD（GORM）
│   │   ├── dashboards/      # 内置 Grafana dashboard JSON（go:embed）+ values overlay 合并器
│   │   └── gateway/         # gRPC Server + Worker 连接管理 + 一次性请求路由 + 流式会话路由 + BuildEnableCommand
│   ├── worker/
│   │   ├── apis/v1alpha1/   # Plugin CRD Go 类型 + DeepCopy（注册到 controller-runtime scheme）
│   │   ├── collector/       # 节点信息采集（controller-runtime Watch）
│   │   ├── plugin/          # Plugin CRD reconciler + Helm SDK + chart cache + manager
│   │   ├── proxy/           # K8s 资源代理（list/get/apply/delete/describe + LogsManager + ExecManager + HTTPProxy + WSManager）
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
| 前端 | React + TypeScript + Ant Design Pro（UmiJS Max） |

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
| `CORS_ORIGINS` | 空（开发宽松模式） | 生产环境设置前端域名，逗号分隔，如 `https://kpilot.example.com` |

### Worker 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SERVER_ADDR` | `localhost:9090` | Server gRPC 地址（Worker 视角） |
| `CLUSTER_TOKEN` | 空 | 必填，集群创建时 UI 一次性展示的 token |
| `DATA_DIR` | `/var/lib/kpilot` | 持久化根目录。`charts/` 放 Helm chart .tgz cache，`helm/` 放 Helm 仓库配置 + cache。生产挂 PVC，本地 dev 改 `./data` |
| `CLUSTER_DOMAIN` | `cluster.local` | K8s 集群 DNS 域。register 时上报给 Server，Server 反代构 FQDN 时用。kubelet 用了非默认 `--cluster-domain` 才需要改 |
| `HELM_REPOSITORY_CONFIG` / `HELM_REPOSITORY_CACHE` | 空 | Helm SDK 自身的 env 变量，设了优先于 `DATA_DIR` 派生路径（高级场景） |

### `.env` 加载
Server / Worker 启动时自动加载 cwd 下的 `.env`（godotenv），shell / pod env 优先（不会覆盖）。`.env.example` 在仓库根，`.env` 在 `.gitignore`。本地 dev 把 `.env.example` 拷成 `.env` 改改就能跑。

### gRPC 配置
- Server 和 Worker 最大消息收发均为 **32 MB**（默认 4 MB 不够大集群 Table API 响应 + 大 chart .tgz blob）

---

## 后端开发规范

### 错误返回（Server HTTP handler）
统一用 `pkg/server/api/handler/errors.go` 的三个 helper，**不手写** `c.JSON(500, ...)`：
- `apiErr(c, status, code)` —— 已知错误码，前端按 `errors.{CODE}` 查表展示
- `apiErrInternal(c, err)` —— 服务器内部错误：实际错误打 log，对外只返回 500 + `INTERNAL_ERROR`，**不泄漏内部信息**
- `apiErrWorker(c, errMsg)` —— Worker / K8s API 返回的错误（如 validation、409 conflict）：透传消息给前端，码为 `WORKER_ERROR`

新增错误码：在 `errors.go` 的 `Code*` 常量加一个，**同时**在 `web/src/locales/{zh-CN,en-US}/pages.ts` 的 `errors.{CODE}` 加翻译。

### 日志格式
统一 `log.Printf("[component] msg: key=value", ...)`：
- component 用小写横线（`gateway`、`pod-logs`、`pod-exec`、`proxy`、`tunnel`、`handler` 等）
- 数据用 `key=value` 风格便于 grep
- 错误用 `err=%v`

### 用户输入字段长度限制（三层一致）
任何用户输入的 string 字段，**DB 列类型 / 服务端 validator / 前端 maxLength** 三处必须配齐且数值一致——不允许任何一层漏。
- DB 列：用 `varchar(N)` 而不是 `text`，让 PostgreSQL 强制兜底；裸 INSERT 也越不过
- 服务端：在请求 struct 的 `validate()` 方法里 `len(field) > maxXxxLen` 检查，失败返回 `CodeInvalidRequest`
- 前端：antd `<Input maxLength={N}>` / `<Input.TextArea maxLength={N} showCount>`，用户敲到上限会被卡住，不用等 server 400

新增字段时**同一个 commit 里把三层一起配好**，不要先 ship `text` "稍后再 cap"。

YAML / values blob（`plugin.default_values`、`cluster_plugin.values_override`）特例：服务端 64 KiB cap 兜底，前端 YAML 编辑器不加 `maxLength`（Helm values 复杂的也就 10KB 量级）。

参考现有数值：DNS-1123 label（plugin name / namespace）= 63；display name = 100；description = 500（配合 3-line 截断）；URL = 512；version 字符串 = 64。

### gRPC 与 Worker 通信
- **gRPC stream 写入必须串行化**：`grpc.ClientStream` / `grpc.ServerStream` 的 `Send` 不是并发安全的。Server 端用 `ConnectedWorker.sendMu`，Worker 端用 `Client.sendMu`。任何并发 Send 都要先拿锁
- **一次性请求-响应**（list/get/apply/delete K8s 资源）：用 `gateway.SendResourceRequest(ctx, clusterID, req)`，内部按 request_id 注册 pending channel，超时由 ctx 控制
- **流式会话**（Pod 日志 / exec）：用 `gateway.OpenStream(clusterID)` 拿到 `*Stream`，`Stream.Send(payload)` 写、`<-Stream.Recv()` 读、`Stream.Close()` 关。Stream 的 send-on-closed 防御已在 `Stream.deliver` 内做了 closeMu 保护，**新增流类型时套这个模式**
- **Worker 断开时**：gateway `unregister` 会自动 `closeClusterStreams` 清理所有该集群的活跃 stream，WS handler 会从 `<-stream.Recv()` 拿到 `ok=false` 退出

### K8s 资源代理（Worker 端）
- **列表**：用 K8s Table API（`Accept: application/json;as=Table;v=v1;g=meta.k8s.io`），仅传元数据 + 单元格值，不传完整 spec/status
- **GVK 来源**：server handler 的 `resolveGVK(c)` 把 URL `:type` 解析成 GVK：
  - 内置 kind：从 `resourceGVK` 白名单查
  - `_cr` 哨兵：从 query param `?group=&version=&kind=` 拿，让 CR 实例浏览器走同一套 list/get/apply/update/delete/describe 路径
  - 一处加 GVK 全部联通；新增内置 kind 加进 `resourceGVK` map 即可
- **资源客户端选择**（worker `proxy.resourceClient(mapping, namespace)`）：根据 `mapping.Scope` 自动决定 namespace-scoped 还是 cluster-scoped 路径，**不依赖调用方传不传 namespace**。namespace-scoped + 空 namespace → fallback 到 `"default"`（同 kubectl 行为，避免用户粘贴的 YAML 没写 metadata.namespace 时打到 cluster-scoped 路径上 K8s 404）
- **写入有两种动作，分别对应两种用户意图**：
  - `update`（PUT，dynamic.Update）—— 用于**单条资源 Edit YAML 保存**（kubectl-edit 语义）。body 必须含 `metadata.resourceVersion`，K8s 拒绝过期版本（409 conflict），用户得到"资源已被修改"提示。HPA 等 controller 管理的字段照样会被覆盖（用户显式编辑了），但至少有并发保护
  - `apply`（Patch + ApplyPatchType，SSA，`fieldManager=kpilot`，`force=true`）—— 用于**通用 Apply YAML 抽屉**（kubectl apply 语义）。无需 resourceVersion，幂等，新建 / 现有都行，用于多文档批量提交
  - `delete`（dynamic.Delete）—— Apply YAML 抽屉的删除按钮也走这个 action，每文档独立调一次
  - **新增写动作时先想清楚是哪种语义**：用户在编辑器里改一份 → update；用户黏贴一坨 manifest → apply
- **Describe**：`describe.DescriberFor(gk, cfg)` 优先（内置 kind 走专用 describer）；返回 `(nil, false)` 时 fallback 到 `describe.GenericDescriberFor(mapping, cfg)`（同 kubectl 自身的 fallback）。CRD / Gateway API / Envoy Gateway policies / 自定义 CR 都靠这个 fallback
- **RESTMapper 缓存**：controller-runtime 的 `apiutil.NewDynamicRESTMapper` 自带 `lazyRESTMapper` —— 遇到 `meta.NoMatchError` 自动 reload + retry 一次。新装 CRD 后第一次查 GVK 它自己刷新，不需要在 proxy 层再写 reset 逻辑
- **流式**（logs/exec）：单独的 manager（`LogsManager`、`ExecManager`），按 sessionID 维护 cancel func / pipe / chan，分发器的 stdin/resize/cancel handler 必须**快返回**（不要在 handler 里阻塞）

### WebSocket（Server 端）
所有 WS 端点统一用 `pkg/server/api/handler/ws.go` 的 `wsConn` helper：
- `wsConn.WriteMessage` / `wsConn.WriteControl` 带 writeMu，**多 goroutine 并发写必须用它**（gorilla/websocket 写不是并发安全的）
- `wsConn.startHeartbeat(ctx)` 启动 ping/pong（pongWait 60s，pingPeriod 54s），半开连接 60s 内能感知
- handler 退出时 `defer hbCancel()` 停止 pinger goroutine

### 配置
- 全部走环境变量，集中在 `pkg/server/config/config.go` 的 `Load()`
- 默认值用 `getEnv(key, default)` 风格
- 列表型（如 `CORS_ORIGINS`）逗号分隔，解析时 trim space + 去空
- 本地开发支持 `.env`：Server / Worker 启动时自动加载 cwd 下的 `.env`（godotenv），shell / pod 的 env 变量优先级高于 `.env`（不会被覆盖）。`.env.example` 为示例文件；`.env` 在 `.gitignore` 中

### CORS
- 白名单制，从 `cfg.CORSOrigins` 读取
- 空列表 = dev 模式（任意 origin），生产必须显式设置
- 永远带 `Access-Control-Allow-Credentials: true`（前端依赖 cookie）

### 包组织
（具体目录树见上文 "项目结构" 节）核心约束：
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
- UmiJS Max (`@umijs/max`) 作为框架
- antd v6 基础组件，`@ant-design/pro-components` v3 高阶组件
- Tailwind v4 布局，`antd-style` CSS-in-JS（需要主题 token 时用）
- 国际化：zh-CN / en-US

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

### 表格约定（必须遵守）
- 所有 `ProTable` 都加 `scroll={{ x: 'max-content' }}`：列宽超过容器时横向滚动，避免中文 header 被压成一字一行
- "操作"列必须 `fixed: 'right'`：横滚时按钮始终可见，且必须显式给 `width`（fixed 列不能没宽度）

### Drawer 约定
- 用 `size`（v6.2+ 接 `number | string | 'default' | 'large'`），不要用已废弃的 `width`
- 必须加 `maskClosable={false}`：编辑/终端/日志类 Drawer 误点遮罩关掉损失太大（YAML 改了一半、终端会话丢、日志缓冲清空）。统一禁用，强制走右上角关闭按钮或取消按钮

查组件 props 用 `npx antd info <Component>`，获取示例用 `npx antd demo <Component> <name>`。

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
- 所有路径使用相对路径，dev 环境通过 `config/proxy.ts` 代理到 `http://localhost:8080`
- 认证依赖 HTTP-only cookie，不需要手动传 token

### i18n
所有用户可见字符串必须走 `useIntl().formatMessage({ id: '...' })`，不硬编码中文或英文。

### 目录结构
```
web/src/
├── pages/
│   ├── user/login/              # 登录页
│   ├── Clusters/                # 集群管理（卡片网格 + KPI 统计）
│   ├── ClusterDetail/
│   │   ├── Nodes/               # 节点概览
│   │   ├── Workloads/           # 工作负载（YamlEditor / ApplyYamlDrawer / DescribeDrawer / PodLogsDrawer / PodExecDrawer）；CRD 行 + CR 实例浏览器（`/workloads/_cr` 路由）也在这里
│   │   ├── Plugins/             # 集群侧插件管理（启用 / 禁用 / 状态）
│   │   ├── Monitoring/          # 监控页（NodeExporterFull dashboard，依赖 Grafana + VictoriaMetrics）
│   │   └── Logging/             # 日志页（VictoriaLogs Explorer K8S dashboard，依赖 Grafana + VictoriaLogs）
│   ├── Plugins/                 # 全局插件注册表 CRUD（PluginCard / PluginEditDrawer）
│   └── exception/404/           # 404 页
├── services/kpilot/             # API 服务（auth、cluster、node、workload、pod、plugin）；workload.ts 同时导出 `WorkloadResourceType` / `CRRef` / `CLUSTER_SCOPED_TYPES` / `isProtectedCRDName`
├── models/                      # Umi model 全局状态（namespace 等）
├── components/                  # 公共组件（Footer、HeaderDropdown、RightContent、NamespacePicker、GrafanaEmbed）
├── locales/                     # zh-CN / en-US（menu.ts、pages.ts）
├── global.less                  # 全局样式 + ProLayout CSS 覆盖
└── app.tsx                      # 全局布局、动态菜单注入（含 Extensions / 网络 GW API 等子项 + 隐藏 `_cr` 子路由）、认证初始化、顶部栏 actionsRender（语言/头像/命名空间选择器）
```

### 集群详情导航（动态菜单）

集群详情页（`/clusters/:id/*`）**不使用独立 Layout**，而是复用全局 ProLayout 框架。
进入某个集群时，把"节点 / 工作负载 / 网络 / 存储 / 配置"动态注入到顶部"集群管理"菜单的 children，路径里带真实 cluster id：

- `app.tsx` 在 `@@initialState` 里跟踪 `currentClusterId`，`onPageChange` 监听 location 变化更新它
- `menuDataRender` 读 `currentClusterId`，有值就调用 `buildClusterSubMenu(id)` 注入子菜单
- ProLayout 配置：`splitMenus: true`（顶栏只显示一层）+ `suppressSiderWhenMenuEmpty: true`（无子菜单时侧边栏自动隐藏，比如集群列表页）
- 菜单 i18n：name 字段会自动拼接父级 locale → `menu.clusters.{name}`，比如 `name: 'nodes'` 解析为 `menu.clusters.nodes`
- PVC/PV 这种长资源名用 kubectl 标准缩写（i18n value 直接写 `PVC`/`PV`）

`menuItemRender` 也在 app.tsx 里 override 了：始终用 `<Link>` 包裹 `defaultDom`，避免 Umi 默认实现给选中项跳过 Link 包裹导致的 DOM 嵌套不一致（会引起切换 tab 时 1px 抖动）。

### 工作负载页关键设计说明

- **Table API**：`listWorkloads` 使用 `Accept: application/json;as=Table;v=v1;g=meta.k8s.io`，Worker 的 `proxy.listTable` 通过 `rest.HTTPClientFor(cfg)` 构建带认证的 HTTP 客户端直接请求 K8s API Server。`includeObject=Metadata` 确保只传输元数据。
- **列定义**：前端动态解析 Table API 的 `columnDefinitions`，所有列（含 priority>0 wide 列）均展示。列名通过 `COL_I18N` 映射到 i18n key。
- **集群级资源**：`CLUSTER_SCOPED` 集合（目前含 `persistentvolumes`）控制是否显示命名空间列和命名空间筛选器。
- **编辑（Update / kubectl-edit 语义）**：使用 K8s **PUT**（dynamic `Update`，`fieldManager=kpilot`），body 携带 `metadata.resourceVersion`。两个用户同时改同一对象时，后保存的会被 K8s 拒绝并返回 409 → server 翻译成 `WORKER_CONFLICT` 错误码（中文"资源已被其他人修改，请关闭后重新打开重试"）。最初实现是 SSA + force=true，但语义跟 kubectl edit 不同（HPA 字段抢权、无并发保护），换成 Update 后行为符合用户对"编辑 YAML"的预期。
- **错误透传**：K8s 操作失败用 `apiErrWorker`（HTTP 400，code=WORKER_ERROR，message=K8s 原始错误），区别于服务器内部错误（500）。
- **通用 Apply YAML**：`POST /api/v1/clusters/:id/apply`，body 是纯文本（`Content-Type: text/plain`）。Server 端用 `apimachinery/pkg/util/yaml.NewYAMLOrJSONDecoder` 流式解析多文档，逐条提取 GVK + name + namespace 后走与单资源相同的 SSA 通道。响应 `{results: [...]}` 一份文档一条结果，前端按 `success` 渲染部分失败。
- **Describe**：Worker 端走 `k8s.io/kubectl/pkg/describe` 的 `DescriberFor(GVK.GroupKind(), cfg)`（`ShowEvents: true`），返回纯文本经 gRPC 透传给 Server，再以 `text/plain` 返回前端。前端只做两类高亮：行内 `key:` 着色（lookahead 排除 taint 表达式如 `node.kubernetes.io/unreachable:NoExecute`），Events 段内 Type 列 Normal/Warning 着色。
- **Pod 日志**：WS 端点 `/api/v1/clusters/:id/workloads/pods/:name/logs`。Server 通过 `gateway.OpenStream` 拿 sessionID 双向流，发 `LogsStartRequest` 给 Worker；Worker 用 `clientset.CoreV1().Pods(ns).GetLogs(...).Stream(ctx)` 4 KiB chunk 转发，EOF 发 `LogsEnd`。前端用 rAF 批量 flush 行缓冲，避免每条消息触发 React re-render。
- **Pod 终端（Exec）**：WS 端点 `/api/v1/clusters/:id/workloads/pods/:name/exec`，二进制帧首字节为类型（client→server: 0=stdin / 1=resize JSON；server→client: 1=stdout / 2=stderr / 3=end）。Worker 端 `ExecManager` 维护 sessionID → `{cancel, stdinW, resizeCh, closed, closeMu}`，dispatcher handler 必须快返回（实际 IO 在管理器 goroutine 里做）。Shell 选择由 Worker 决定：先探测 `/bin/bash`，不存在静默回退 `/bin/sh`，前端无须传参。

### 插件系统关键设计说明

- **数据切分（三表）**：`Plugin`（全局注册表，是 Helm chart 元数据）/ `PluginBlob`（本地 .tgz 字节，sha256 dedupe）/ `ClusterPlugin`（集群侧启用状态 + 用户 override + 反映 PluginStatusPush 的 phase / observed_*）。删除注册表行会级联删 ClusterPlugin。
- **Plugin CRD**（`pkg/worker/apis/v1alpha1`）：cluster-scoped。spec 含 chart 来源（`type=repo|oci|local`，repo URL / sha256 / OCI 引用按 type 取舍）+ release identity + values YAML。status 含 phase / observed_version / observed_values_hash / **AttemptHash（输入指纹，防 hot-loop）** / helm_revision。CRD 定义由 Worker 启动时 `EnsurePluginCRD` 自动 install 到目标集群。Printer columns（`kubectl get plugins.kpilot.io`）：Source（`.spec.chart.type`，三种 chart_type 都有值）/ Namespace（`.spec.release.namespace`）/ Phase / Version / Age
- **gRPC 协议**：`PluginCommand`（Server→Worker）action ∈ `{enable, disable}` + spec；`PluginStatusPush`（Worker→Server）含 phase + observed_* + helm_revision。**Push 模式（无 request_id）**，火焰发射，状态由 PluginStatusPush 异步回报。
- **Worker reconciler**：controller-runtime watches Plugin CRD。Add finalizer 后跑 Helm；删除走 finalizer pattern（先 helm uninstall 再清 finalizer）。**install/upgrade 都用 `Wait + WaitForJobs + Atomic + 5min Timeout`**——Wait 解决 chart 内子组件依赖（如 victoria-metrics-k8s-stack 的 webhook race），Atomic 失败回滚不留半装状态。
- **AttemptHash 防死循环**：每次 reconcile 前算 `sha256(chart.type + repo + name + version + sha256 + release.name + release.namespace + canonical(values))`。`Phase=Running && AttemptHash 匹配` 跳过；`Phase=Failed && AttemptHash 匹配` 也跳过（不再自动重试），永久失败靠用户改 spec / disable+re-enable 触发。
- **Manager SSA**：处理 PluginCommand 时用 `client.Apply` + `FieldOwner("kpilot")` + `ForceOwnership` 写 CRD，不用 Get-then-Update（会跟 reconciler 加 finalizer 抢 ResourceVersion）。
- **离线 / 重连保护**：handler 提交前 `gw.GetWorker()` pre-flight；离线返回 503 不写 DB。`handlePluginStatus` 用 upsert（不是 update），自愈"push 成功 DB 写失败"的 corner case。`Manager.handleDisable` 找不到 CRD 时 push 一个空 phase（→ Server 翻成 Disabled），让卡死的 Uninstalling 行能恢复。
- **Helm chart cache**：本地 chart .tgz 存 `$DATA_DIR/charts/<sha256>.tgz`，atomic write（tempfile + rename）+ 内容校验 sha256。Repo chart 也在 `$DATA_DIR/helm/cache/` 缓存 .tgz，`LoadChart` 命中缓存就跳过 Pull（Helm v3.20 的 action.NewPull 即使 RepositoryCache 配了也会重下，所以这一层手动检查必要）。
- **Helm release storage**：用 secrets driver（v3 默认），keyed by (release_name, release_namespace)。**release_namespace 锁**：`helm_revision > 0` 后改 namespace 直接拒绝（400 + `PLUGIN_NAMESPACE_LOCKED`），否则会在新 ns fresh install + 旧 ns release 孤悬。
- **删除保护**：自定义 plugin 被任意集群启用中（`phase != Disabled`）时拒绝删除（409 + `PLUGIN_IN_USE`），避免 cascade 把 ClusterPlugin 行删了导致 Helm release 在集群上孤悬。
- **Worker 注册 TOCTOU 保护**：`gateway.Connect` 的 occupied 检查 + slot 写入合并到单次 `g.mu.Lock()`，避免两个 worker 用同 token 并发连入时双方都过 RLock 检查、第二个 silently 覆盖第一个。
- **⚠️ Helm SDK 陷阱：不要 `RunWithContext` + `defer cancel()`**：曾尝试给 Helm install 装 ctx 取消（disable 期间立即 abort 安装），install 成功后 deferred `cancel()` 会污染 K8s client transport，导致后续无关的 K8s 读（甚至 cached client / APIReader / 全新 `client.New`）全部静默挂死。改回 `Run()` 不带 ctx，disable 期间的 install 等 Helm 自己 timeout（10min 上限），靠重连补发兜底卡死的命令。详见 memory `feedback_helm_run_with_context.md`。

---

## 开发阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| P1 | 项目脚手架 + Proto 设计 + gRPC 连接/注册 + PostgreSQL schema + JWT 认证 | ✅ 完成 |
| P2 | 集群管理 UI + 节点概览（Worker 采集上报） | ✅ 完成 |
| P3 | 工作负载管理（CRUD 代理 + 通用 Apply YAML + Describe + Pod 日志/终端 + 全局命名空间选择器 + Pod 日志客户端 grep） | ✅ 完成 |
| P4 | 插件系统（Plugin CRD + Helm SDK + Server 注册表 + 集群启用/禁用 + 状态同步 + 4 个内置插件） | ✅ 完成 |
| P5 | GPU 管理（HAMI 集成） | 待开始 |
| P6 | 监控中心 + 日志中心（Grafana iframe + auth.proxy + HTTP/WS 反代 + 内置 dashboard overlay） | ✅ 完成 |
| P7 | 模型管理（LLM + KServe） | 待开始 ← 下一步 |
