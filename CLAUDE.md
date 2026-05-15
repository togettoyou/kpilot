# KPilot

**Kubernetes 上的 GPU + 模型一体化平台。**

四个顶级平台：

| 平台 | 范围 | 详细文档 |
|---|---|---|
| 集群管理 (`/clusters`) | 通用 K8s 资源管理：节点、工作负载、监控、日志 | [docs/clusters.md](docs/clusters.md) |
| 算力调度 (`/compute`) | 基于 Volcano 的批量调度：Queue / Job / PodGroup CR 浏览，调度策略，vGPU 切分（volcano-vgpu-device-plugin），GPU-Hour 治理 | [docs/compute.md](docs/compute.md) |
| 模型服务 (`/models`) | 模型仓库、推理部署、调试、路由、训练任务 | [docs/models.md](docs/models.md) |
| 插件管理 (`/plugins`) | Helm chart 注册表，前三个平台的能力底座 | [docs/plugins.md](docs/plugins.md) |

Server（中心控制面）+ Worker（集群侧 Operator），通过 gRPC 双向流连接。

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
- `ResourceResponse`（list/get/apply/update/patch/delete/describe 共用）
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

## 项目结构

```
kpilot/
├── cmd/
│   ├── server/              # Server 入口
│   └── worker/              # Worker 入口
├── pkg/
│   ├── server/
│   │   ├── api/
│   │   │   ├── handler/     # Gin Handler（auth、cluster、workload、volcano、plugin、proxy、pod (logs/exec)、pod_top、system、ws helper、errors）
│   │   │   ├── middleware/  # JWT 中间件
│   │   │   └── router.go    # 路由注册
│   │   ├── store/           # PostgreSQL CRUD（GORM）+ 启动 seed（内置插件 + 本地 chart blob upsert）
│   │   ├── dashboards/      # 内置 Grafana dashboard JSON（go:embed）+ overlay 合并器
│   │   ├── plugins/         # 内置 Helm chart 源（charts/<name>/，go:embed）+ 启动时 helm package 出 .tgz 写 PluginBlob
│   │   ├── config/          # Server 环境变量
│   │   └── gateway/         # gRPC Server + Worker 连接管理 + ResourceRequest 路由 + 流式会话路由 + BuildEnableCommand
│   ├── worker/
│   │   ├── apis/v1alpha1/   # Plugin CRD Go 类型 + DeepCopy
│   │   ├── plugin/          # Plugin CRD reconciler + Helm SDK + chart cache + manager
│   │   ├── proxy/           # K8s 资源代理（list/get/apply/update/patch/delete/describe）+ LogsManager + ExecManager + HTTPProxy + WSManager + VGPUTracker（解析 Volcano vGPU annotation）
│   │   ├── config/          # Worker 环境变量
│   │   └── tunnel/          # gRPC Client（注册、心跳、消息分发）
│   └── common/
│       ├── proto/           # protobuf 生成代码（不手动编辑）
│       └── vgpu/            # vGPU snapshot 共享 JSON 类型（worker 投影 → server 透传 → 前端渲染）
├── proto/                   # .proto 源文件
├── web/                     # 前端（见下方前端规范）
├── deploy/
│   ├── server/              # Server K8s manifests
│   └── worker/              # Worker Helm Chart
├── docs/                    # 4 平台详细文档
└── hack/                    # 脚本（proto 生成等）
```

```
web/src/
├── pages/
│   ├── user/login/          # 登录页
│   ├── Clusters/            # 集群管理 landing（卡片网格 + KPI + CRUD）
│   ├── ClusterDetail/       # 集群管理子页面（每个集群一份）
│   │   ├── Nodes/           # 节点概览：表格 + Detail/Yaml/Describe drawers + cordon
│   │   ├── Workloads/       # 工作负载：YamlEditor / ApplyYamlDrawer / DescribeDrawer / PodLogsDrawer / PodExecDrawer / PodTopDrawer + CR 实例浏览器（WorkloadsContent 已 export 给 Compute 复用）
│   │   ├── Plugins/         # 集群侧插件管理（启用 / 禁用 / 状态）
│   │   ├── Monitoring/      # 监控页（NodeExporterFull dashboard）
│   │   └── Logging/         # 日志页（VictoriaLogs Explorer K8S dashboard）
│   ├── Compute/             # 算力调度
│   │   ├── index.tsx        # 顶级 landing（集群 picker，进入 → /scheduler）
│   │   └── Volcano/         # 5 个 CR 页（Queues / Jobs / CronJobs / PodGroups / HyperNodes）+ Scheduler + 对应 Form drawer + schedulerMeta + shared/Layout（NotInstalled / isResourceNotAvailable / useAutoRefresh / useStaggeredRefresh / RefreshControl / TruncatedBanner / formatAge）
│   ├── ModelHub/            # 模型服务 landing（P7 占位）
│   ├── Plugins/             # 全局插件注册表 CRUD
│   └── exception/404/
├── services/kpilot/         # API 服务（auth、cluster、node、workload、pod、plugin、volcano）
├── models/                  # Umi useModel 全局状态（namespace 等）
├── components/              # Footer、HeaderDropdown、RightContent、NamespacePicker、GrafanaEmbed
├── locales/                 # zh-CN / en-US（menu.ts、pages.ts）
└── app.tsx                  # 全局布局、动态菜单注入、认证初始化、顶部栏 actionsRender
```

---

## 技术栈

| 层 | 技术 |
|----|------|
| 后端语言 | Go 1.26+ |
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

GORM 启用 `TranslateError: true`：唯一索引冲突等驱动错误会被翻译成 `gorm.ErrDuplicatedKey` 等 sentinel，handler 用 `errors.Is` 翻译到对应业务错误码（如 `CLUSTER_NAME_EXISTS`），不要 string-match 原始 pq.Error。

### 日志格式
统一 `log.Printf("[component] msg: key=value", ...)`：
- component 用小写横线（`gateway`、`pod-logs`、`pod-exec`、`proxy`、`tunnel`、`handler`）
- 数据用 `key=value` 风格便于 grep
- 错误用 `err=%v`

### 用户输入字段长度限制（三层一致）
任何用户输入的 string 字段，**DB 列类型 / 服务端 validator / 前端 maxLength** 三处必须配齐且数值一致：
- DB 列：用 `varchar(N)` 而不是 `text`，让 PostgreSQL 强制兜底
- 服务端：在请求 struct 的 `validate()` 方法里 `utf8.RuneCountInString(field) > maxXxxLen` 检查（**用 rune 计数**，PostgreSQL 的 `varchar(N)` 也是按 codepoint 算的；用 `len()`(byte) 会让中文字符过早被拒）
- 前端：antd `<Input maxLength={N}>` / `<Input.TextArea maxLength={N} showCount>`

参考数值：DNS-1123 label（plugin name / namespace）= 63；display name / cluster name = 255；description = 500；URL = 512；version = 64。

YAML / values blob（`plugin.default_values`、`cluster_plugin.values_override`）特例：服务端 64 KiB cap 兜底，前端 YAML 编辑器不加 `maxLength`。

### gRPC 与 Worker 通信
- **gRPC stream 写入必须串行化**：`grpc.ClientStream` / `grpc.ServerStream` 的 `Send` 不是并发安全的。Server 端用 `ConnectedWorker.sendMu`，Worker 端用 `Client.sendMu`
- **`ConnectedWorker` 共享字段并发访问**：被多 goroutine 读写的字段（如 `LastSeen`）必须用 `sync/atomic` 或 mutex 保护。当前 `lastSeenNS atomic.Int64`，提供 `markSeen()` / `lastSeen()` helper
- **一次性请求-响应**（list/get/apply/update/patch/delete K8s 资源）：用 `gateway.SendResourceRequest(ctx, clusterID, req)`
- **流式会话**（Pod 日志 / exec / 反代 WebSocket）：用 `gateway.OpenStream(clusterID)` 拿 `*Stream`，`Stream.Send(payload)` 写、`<-Stream.Recv()` 读、`Stream.Close()` 关
- **Worker 断开时**：gateway `unregister` 自动 `closeClusterStreams` 清理所有该集群的活跃 stream
- **Worker 端流式会话**：`tunnel.Client.StreamContext()` 暴露 per-connection ctx，`connect()` 退出（含心跳超时、网络断、reconnect）时 defer cancel。`LogsManager` / `ExecManager` 的 session ctx 都派生自它——tunnel 一断 K8s 侧的 SPDY exec / log Stream 立刻 unwind，不会等到下次 Send 失败才退出

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

> K8s 资源代理（Worker 端）的写动作语义、Describe fallback、RESTMapper 缓存等细节见 [docs/clusters.md](docs/clusters.md) 的「K8s 资源代理」一节。
> 写操作 protection 的五道闸门见 [docs/clusters.md](docs/clusters.md) 的「写操作 protection」一节。

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
| `/compute` | 算力调度 | landing = 集群 picker；进入集群后 `/compute/:id/scheduler` 是首屏，sider 注入「调度策略」+「调度资源」(Queue/Job/CronJob/PodGroup/HyperNode) |
| `/models` | 模型服务 | landing = 占位页（P7 落地） |
| `/plugins` | 插件管理 | 全局 Helm 插件注册表 |

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

> ⚠️ **动态轮询**：`useRequest` 的 `pollingInterval` 在初始化后不响应 state 变更，不能用于运行时切换间隔。需要动态轮询时用 `useEffect + setInterval`，并把 `refresh` 走 `useRef` 镜像 —— 直接把 `refresh` 写进 deps 会让 timer 每次 render 都被 tear-down + recreate（useRequest 每次 render 给一个新的函数引用），实际触发不到 interval：
> ```tsx
> const refreshRef = useRef(refresh);
> useEffect(() => { refreshRef.current = refresh; }, [refresh]);
> useEffect(() => {
>   if (interval <= 0) return;
>   const t = setInterval(() => refreshRef.current(), interval);
>   return () => clearInterval(t);
> }, [interval]);
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

### 全局错误处理
`src/requestErrorConfig.ts` 的 `errorHandler` 把响应 `data.code` 翻译成 `errors.{CODE}` 并 toast。少数业务上预期可处理的错误码（如 `RESOURCE_NOT_AVAILABLE`，K8s 集群没启用某 feature gate / CRD）放进 `SILENT_CODES` set，错误会 re-throw 不弹 toast，让页面级 catch 渲染友好的 Result 占位。

> 4 平台子菜单注入 / `extractClusterId` / ProLayout 配置等动态导航细节见 [docs/clusters.md](docs/clusters.md) 的「集群详情导航」一节。

---

## 开发阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| P1 | 项目脚手架 + Proto 设计 + gRPC 连接/注册 + PostgreSQL schema + JWT 认证 | ✅ 完成 |
| P2 | 集群管理 UI + 节点概览（Table API proxy） | ✅ 完成 |
| P3 | 工作负载管理（CRUD 代理 + 通用 Apply YAML + Describe + Pod 日志/终端 + 全局命名空间选择器 + DRA 资源 v1） | ✅ 完成 |
| P4 | 插件系统（Plugin CRD + Helm SDK + Server 注册表 + 集群启用/禁用 + 状态同步 + 6 个内置插件） | ✅ 完成 |
| P5a | 算力管理：单页 dashboard（KPI 仪表盘 + 型号分布 + Top 占用 + 节点利用率网格 + 显卡 / 任务 Tabs）+ HAMi annotation 双格式解析 + Pod-to-card 归属 + Snapshot informer 缓存 | ✅ 完成 |
| P6 | 监控中心 + 日志中心（Grafana iframe + auth.proxy + HTTP/WS 反代 + 内置 dashboard overlay） | ✅ 完成 |
| 重构 | 4 平台拆分（集群 / 算力 / 模型 / 插件 顶级化）+ Node 写操作收敛（cordon scoped 端点 + `_cr` URL 绕过修复 + 所有 protection 改为基于 GVK） | ✅ 完成 |
| 集群管理收尾 | Pod 即时指标 (`kubectl top` 等价) + Metrics Server / kube-state-metrics / Volcano 内置插件 + 全栈 review 修复（DeleteCluster 404、LastSeen atomic、polling timer ref、UpdateCluster 唯一性 race、ListPluginsBrief、replay 不补 Failed 等 6 项）+ 详细文档拆分到 `docs/` | ✅ 完成 |
| Volcano 转向 P0 | 平台改名（算力管理 → **算力调度**，模型管理 → **模型服务**），删 HAMi 内置插件 + DB 行，文档定位调整 | ✅ 完成 |
| Volcano 转向 P1 | Volcano 核心对接：5 个 CR 浏览器（Queue / Job / CronJob / PodGroup / HyperNode）+ 类型化创建编辑表单（form / YAML 双视图）+ 生命周期操作（bus.volcano.sh Command）+ 调度策略可视化编辑器（actions / tier / plugin 元数据 + 新手提示）；GPU dashboard 与 HAMi 解析器 / snapshot informer 全量删除 | ✅ 完成 |
| Volcano 转向 P1.5 | 算力调度页性能重写：worker 加 `list-full` action，server 加 5 个专用 list 端点按 kind 投影 slim row，前端 5 个页改写为单 useRequest + ProTable，cell 全部 props-driven。N+1（100 队列 = 101 请求）→ 1 请求 / 刷新；删 CRPage / sharedFetch / WorkloadsContent 扩展点 | ✅ 完成 |
| 集群 + Volcano review 硬化 | 全栈 review 修复。集群侧：gateway RegisterAck Send race、流式会话 ctx 派生自 tunnel.StreamContext()、Pod 日志 64 MiB 字节封顶、HTTP/WS 反代 URL scheme 白名单、describe panic recover、exec writer onSendErr cancel、proxy 读/写超时拆分（120s / 30s）、UpdateCluster TOCTOU 删除等 ~12 项。Volcano 侧：server workerTimeout 拆 read/write 与 worker 对齐、5 list 端点接 `limit + continue` 透传 + 响应 shape 改 `{items, continue?, remainingItemCount?}` 带截断兜底、worker listFull 剥 managedFields + 加 effective ns 日志、5 页 + 2 form i18n 完整覆盖、QueueForm editOriginalRef 镜像 spec.priority、useStaggeredRefresh 解决 setTimeout-on-unmounted 等 13+3 项 | ✅ 完成 |
| Volcano 转向 P2 | vGPU 实况：worker `pkg/worker/proxy/vgpu.go` 解析 `volcano.sh/node-vgpu-register` + `vgpu-ids-new` annotation，server `/api/v1/clusters/:id/vgpu` 返回集群 → 节点 → 卡 → Pod 树，前端 `/compute/:id/vgpu` 渲染 KPI + 每节点表格（展开行 = 卡列表）；volcano-vgpu-device-plugin 包成 wrapper Helm chart（go:embed + 启动时 helm package）加为内置插件 | ✅ 完成 |
| Volcano 转向 P2.x | P2 收尾打磨。**vGPU 页**：搜索 / 排序 / drilldown / banner / CTA + KPI 对齐 + 统一 bar 组件 + GiB 单位 + early-return 前算 derived state（hooks rule）。**chart**：ConfigMap 钉死 `kube-system`（device-plugin 容器硬编码读 `kube-system/volcano-vgpu-device-config`，原来走 release namespace 错的） + `all:` 前缀避免 `_helpers.tpl` 被 go:embed 默认规则跳过 + display_name 缩短到 "Volcano vGPU" 适配 antd Card 单行 ellipsis + description 修到 varchar(500) 内。**架构**：删除 `pkg/server/protect/`（588 行写保护，归还集群级写权由 K8s RBAC + controller 兜底）。**schedulerMeta**：把 `arguments` 作为已知 top-level key 修复 plugin block round-trip。**JobForm**：编辑时提前告知用户 Volcano webhook 仅接受 `minAvailable / tasks[*].replicas / priorityClassName` 三字段修改，dirty-diff 监听到改动其它字段就 inline Alert。**hack/**：`aliyun-gpu.sh` 一键拉 Aliyun spot GPU 测试机 | ✅ 完成 |
| Volcano 转向 P3 | DCGM Exporter 内置插件 + Grafana NVIDIA DCGM dashboard（GPU 物理卡监控） | 待规划 |
| Volcano 转向 P4 | 资源治理：Volcano queue 配额视图 + 设备健康告警 + GPU-Hour 计费报表 | 待规划 |
| P7a | 模型服务 → 模型仓库 + 内置预设（Qwen / DeepSeek / Llama 等 vLLM 启动模板） | 待开始 |
| P7b | 模型服务 → 推理部署 + 内置 chat 调试 + 可选反代 endpoint | 待开始 |
| P7c | 模型服务 → OpenAI 兼容路由（按 model 参数路由后端，灰度 / A/B） | 待规划 |
| P8 | 模型服务 → 训练任务（基于 Volcano，分布式 fine-tune 的 gang scheduling） | 待规划 |
