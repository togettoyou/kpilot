# KPilot

**Kubernetes 多集群管理 + GPU 算力调度 + 模型服务的一体化控制面。**

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

单条双向流，用 `request_id` 实现请求-响应配对。所有大消息（HTTP body、ResourceResponse data、chart blob）都走 **chunked 帧**：`*Start` 元数据 + 0 或多个 `BodyChunk`（≤64 KiB）+ `BodyEnd` 终止，保证任何单次 `stream.Send` 都很小（<1 ms），不会因 HTTP/2 流控阻塞挡住其他消息。**stream 启用 gRPC 内置 gzip 压缩**（两端都 blank import `google.golang.org/grpc/encoding/gzip` 注册 codec；worker 出方向 `grpc.UseCompressor("gzip")`、server 出方向 `grpc.SetSendCompressor(stream.Context(), "gzip")`），JSON 类响应 wire 体积普遍缩到 1/5–1/8，跨境链路下吞吐提升显著。

**Worker → Server（WorkerMessage）：**
- `Register`（携带 Token） / `Heartbeat`
- `ResourceResponseStart` + `BodyChunk*` + `BodyEnd`（list/get/apply/update/patch/delete/describe 共用）
- `PluginStatusPush`
- `PluginLogChunk` / `PluginLogEnd`（插件安装日志流）
- `LogsChunk` / `LogsEnd`（Pod 日志流）
- `ExecOutput` / `ExecEnd`（Pod 终端流）
- `HTTPResponseStart` + `BodyChunk*` + `BodyEnd`（反代 HTTP 回包）
- `WSFrame` / `WSEnd`（反代 WebSocket 帧）

**Server → Worker（ServerMessage）：**
- `RegisterAck`
- `ResourceRequestStart` + `BodyChunk*` + `BodyEnd`（同上 action 集合；apply/update/patch 的 JSON body 走 chunk）
- `PluginCommandStart` + `BodyChunk*` + `BodyEnd`（enable / disable；chart .tgz 通过 chunks 推送）
- `LogsStartRequest` / `LogsCancelRequest`
- `ExecStartRequest` / `ExecStdin` / `ExecResize` / `ExecCancelRequest`
- `HTTPRequestStart` + `BodyChunk*` + `BodyEnd`（反代 HTTP 请求；POST body 走 chunk）
- `WSStartRequest` / `WSFrame` / `WSEnd`（反代 WS）

四种通信模式：
- **Push**（`request_id` 为空）：Worker 主动上报，事件驱动（PluginStatusPush）
- **Chunked Request-Response**：Server 带 `request_id` 发 `*Start` + chunks + `BodyEnd`，Worker 同样 chunked 回包；receiver 按 `request_id` 累积。`BodyChunk`/`BodyEnd` 在两个方向各定义一次但 message 类型共享
- **流式会话**：`request_id` 复用为 sessionID，双向多消息往返直到 `*End` 或显式 cancel（Pod 日志、终端、反代 WebSocket）
- **小消息直发**：Heartbeat / RegisterAck / PluginStatusPush 这类小消息不走 chunked

**priority sender + 多队列公平调度**：worker + server 各起一个 sender goroutine（`pkg/{worker/tunnel,server/gateway}/sender.go`）。fast lane 只给 Heartbeat；**slow lane 是 per-`request_id` 子队列 + round-robin 调度器**，不是单 FIFO —— 一个 20 MiB 大响应切成的 320 chunk 不会 head-of-line block 后到的小请求的几帧;同一 request_id 的帧 FIFO 排队保序,不同 request_id 的帧 round-robin 交错下发。sender 永远先 drain fast 再考虑 slow，保证 Heartbeat 不被数据 chunk 挡住。`prioritySender` 是唯一 `stream.Send` 调用方，因此不需要 sendMu。新加入的子队列追加到 order 末尾,wake 信号通过 buf=1 channel 合并(多个 producer 信号自动 collapse)。

**心跳与离线检测分离**：应用层 Heartbeat 每 10s 一次仅作可观测信号（debug snapshot 的 `lastSeen`）。worker 是否离线由 **gRPC HTTP/2 keepalive PING** 判定 —— worker + server 都配 `Time: 20s / Timeout: 10s`，PING 失败 30s 内 gRPC 自动 close stream，`stream.Context().Done()` 触发即视为掉线。PING 走连接层、不经任何 sendMu，**应用消息再多也不会把它挡住**。

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
│   │   │   ├── handler/     # Gin Handler（auth、cluster、workload、volcano、plugin、model 模型仓库 CRUD、model_deploy 推理部署（生成 K8s manifests 走 applyOneDoc）、proxy、pod (logs/exec)、pod_top、system、ws helper、sse helper、errors、metrics 调试端点、tunnel_bench 跨境链路诊断、vm_query/vmlogs_query 共享 PromQL/LogsQL 客户端、vm_cache 共享 TTL response cache、cluster/node/pod_metrics + pod_health 自绘监控、logs 自绘日志搜索（SSE 流式响应避免 ingress idle timeout）、device_health/gpu_hour/gpu_metrics 算力调度三件套）
│   │   │   ├── middleware/  # JWT 中间件
│   │   │   └── router.go    # 路由注册
│   │   ├── store/           # PostgreSQL CRUD（GORM）+ 启动 seed（内置插件 + 本地 chart blob upsert + 模型仓库内置预设）
│   │   ├── pluginservice/   # 插件域服务（BuildEnableCommand 拼装 *Command{Action, CrdName, Spec, Blob} —— Blob 与 spec 分离让 gateway 走 chunked 发送 + 合 dashboards 覆盖 + 解析 ${KPILOT_*} / PersistStatus 写 ClusterPlugin 行），gateway 不再直接 import store/dashboards
│   │   ├── deploy/          # 模型推理部署生成器（P16-A）：从 store.Model + DeployOptions 拼出 Deployment + Service + 可选 PVC/Secret，返回 unstructured 列表 + YAML 预览文本；走 handler/applyOneDoc 推到集群
│   │   ├── dashboards/      # 内置 Grafana dashboard JSON（go:embed）+ overlay 合并器
│   │   ├── plugins/         # 内置 Helm chart 源（charts/<name>/，go:embed）+ 启动时 helm package 出 .tgz 写 PluginBlob
│   │   ├── config/          # Server 环境变量
│   │   └── gateway/         # 纯传输层：gRPC Server + Worker 连接管理。`server.go` Connect handler + 离线检测（依赖 stream.Context()，不用应用心跳）+ stream 级 gzip 压缩（`SetSendCompressor`）。`sender.go` per-worker prioritySender（fast lane=Heartbeat / slow lane=**per-request_id 子队列 + round-robin 调度器**，大响应 chunk 不再 HOL block 小请求）取代 sendMu。`chunked.go` 双向 chunked 发送 helper + per-request_id 入站 accumulator，HTTPRequest/Response、ResourceRequest/Response、PluginCommand 的 body 全部 ≤64 KiB 分片，handler 看到的还是完整 struct（`gateway.HTTPRequest` / `gateway.ResourceRequest` / `pluginservice.Command`）。BuildEnableCommand / handlePluginStatus 委托给 pluginservice（通过 ClusterDomainResolver 接口反向调用拿 worker 上报的 cluster_domain）
│   ├── worker/
│   │   ├── apis/v1alpha1/   # Plugin CRD Go 类型 + DeepCopy
│   │   ├── plugin/          # Plugin CRD reconciler + Helm SDK + chart cache + manager
│   │   ├── proxy/           # K8s 资源代理（list/get/apply/update/patch/delete/describe + `tunnel-bench` 跨境链路诊断 action，内部 `proxy.ResourceResponse` 结构通过 sendFn 回给 tunnel 走 chunked）+ LogsManager + ExecManager + HTTPProxy（内部 `proxy.HTTPResponse` 同样 chunked 回包）/ WSManager（in-cluster `*.svc.*` URL 优先直连 dial，DNS 失败 fallback 到 K8s API service-proxy；决策按 24h TTL 缓存到 Worker 进程，HTTP / WS 共用 `InClusterRouter`；生产路径完全绕过 API server，WS 服务端走 wss://apiserver/.../proxy/ 子资源） + VGPUTracker（解析 Volcano vGPU annotation）
│   │   ├── config/          # Worker 环境变量
│   │   └── tunnel/          # gRPC Client。`client.go` 注册 + 重连 + Server 消息分发 + dial 时 `UseCompressor("gzip")` 启用出方向压缩，handler 看到的是已经组装好的 `tunnel.HTTPRequest` / `tunnel.ResourceRequest` / `tunnel.PluginCommand`。`sender.go` prioritySender（fast lane=Heartbeat / slow lane=**per-request_id 子队列 + round-robin 调度器**）。`chunked.go` per-request_id 入站 accumulator + 出站 chunked 发送 helper（HTTPResponseStart / ResourceResponseStart + BodyChunk + BodyEnd），心跳走 fast lane 永远不会被数据 chunk 挡住
│   └── common/
│       ├── proto/           # protobuf 生成代码（不手动编辑）
│       ├── vgpu/            # vGPU snapshot 共享 JSON 类型（worker 投影 → server 透传 → 前端渲染）
│       └── volcano/         # volcano-status 探测共享类型（installed + schedulerConfigMapNamespace）
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
│   │   ├── Monitoring/      # 监控页（自绘，cluster KPI + node 时序 + pod top-N + pod health 表，不嵌 Grafana；共享 `<TimeRangePicker>` 预设按钮 + 绝对范围）
│   │   ├── Logging/         # 日志页（自绘 LogsQL 搜索 + 直方图 + ns/pod picker 自动构造 stream selector）—— full-bleed 布局（外层 ResizeObserver 测 viewport - wrapperTop - footerHeight - gap，闭式公式无外层滚动条；依赖 Footer 组件的 `kpilot-footer` className 找 footer 位置）+ react-virtuoso 虚拟列表（10k 行 DOM 恒定）+ 大屏模式（Esc 退出，隐藏顶部区让 Results 占满 viewport）+ TXT/NDJSON 导出 Dropdown（纯客户端 Blob 下载）+ 共享 `<TimeRangePicker>` + 直方图默认收起 + **`/logs/search` 和 `/logs/histogram` 走 SSE 协议**（`services/kpilot/logs.ts` 用 EventSource 包装成 Promise；后端 25s 发 `progress` 心跳事件穿透 ingress idle timeout；终态 `result` / `error` 事件,EventSource 接到后关闭连接,无自动重连）
│   │   └── Grafana/         # Grafana 兜底页（iframe escape hatch，power user 自定义 dashboard / datasource / alert）
│   ├── Compute/             # 算力调度
│   │   ├── index.tsx        # 顶级 landing（集群 picker，进入 → /overview）
│   │   └── Volcano/         # Overview（调度概览,KPI + 图表 dashboard）+ Scheduler（调度策略编辑器）+ QueueQuota（队列配额,单 Queue 多资源 capability/guarantee/allocated/deserved 三 tick bar,默认选 root）+ VGPU（GPU 视图,每节点 Card 列表 + Progress 仪表盘 KPI）+ GPUMonitoring（GPU 监控,**自绘** `@ant-design/plots` Line —— 4 KPI 卡 + 6 张多线时序图,不嵌 Grafana；共享 `<TimeRangePicker>` 支持预设 + 绝对范围）+ DeviceHealth（GPU 告警,DCGM XID/ECC/温度/显存四路 PromQL 聚合）+ GPUHour（GPU-Hour 用量,DCGM 利用率 × 窗口积分,1h/24h/7d/30d range picker）+ 10 个 CR 页（Queues / Jobs / CronJobs / PodGroups / HyperNodes / JobFlows / JobTemplates / NumaTopologies / NodeShards / ColocationConfigurations）+ 对应 Form drawer（7 个类型化表单 + JobFlow/JobTemplate 走 YamlCreateDrawer / NumaTopology 只读）+ schedulerMeta + shared/Layout（NotInstalled / isResourceNotAvailable / useAutoRefresh / useStaggeredRefresh / RefreshControl / TruncatedBanner 带 load-more action / formatAge）+ shared/utils（parseQuantity / shortUUID / usageBand / usageColor 跨页共享）
│   ├── ModelHub/            # 模型仓库（P15）+ 推理部署（P16-A）：`index.tsx` 家族分组卡片 catalog（Collapse + 搜索 + 过滤）；`ModelCard.tsx` 单卡（HF logo + 描述 + badges + Deploy 主按钮 + Edit/Duplicate/Delete）；`ModelDetailDrawer.tsx` 只读详情；`ModelDrawer.tsx` 新建/编辑/复制为自定义 三 mode；`DeployDrawer.tsx` 部署 drawer 三 tab（配置 / YAML 预览 复用 workloads YamlEditor / 部署结果）
│   ├── Plugins/             # 全局插件注册表 CRUD
│   └── exception/404/
├── services/kpilot/         # API 服务（auth、cluster、node、workload、pod、plugin、model 模型仓库、volcano、vm-backed device-health / gpu-hour / gpu-metrics / monitoring / logs）
├── hooks/                   # useClusterRequest（manual:true + useEffect 替代 ready+refreshDeps 反模式）+ useVolcanoList（cursor 分页累积器，Volcano 10 个 CR 列表页用）
├── models/                  # Umi useModel 全局状态（namespace 等）
├── components/              # Footer（带 `kpilot-footer` className 供 full-bleed 页面 ResizeObserver 测量用）、HeaderDropdown、RightContent（含 DefaultPasswordWarning 头部 ⚠ icon）、NamespacePicker、GrafanaEmbed、PluginInstallLogDrawer、TimeRangePicker（预设按钮 1h/24h/7d/30d + antd RangePicker `showTime` 绝对范围；`TimeRangeValue` discriminated union + `buildRangeQuery` / `resolveTimeRange` helper；监控 / 日志 / GPU 监控三个页面复用）
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
| `SERVER_ADDR` | `localhost:9090` | Server gRPC 地址（Worker 视角）。支持三种格式：裸 `host:port`（明文）/ `grpc://host[:port]`（明文，默认 80）/ `grpcs://host[:port]`（TLS，默认 443，适用于走 HTTPS ingress 暴露 gRPC 的场景） |
| `CLUSTER_TOKEN` | 空 | 必填，集群创建时 UI 一次性展示的 token |
| `DATA_DIR` | `/var/lib/kpilot` | 持久化根目录。`charts/` 放 Helm chart .tgz cache，`helm/` 放 Helm 仓库配置 + cache |
| `CLUSTER_DOMAIN` | `cluster.local` | K8s 集群 DNS 域。register 时上报给 Server，反代构 FQDN 时用 |
| `HELM_REPOSITORY_CONFIG` / `HELM_REPOSITORY_CACHE` | 空 | Helm SDK 自身 env，设了优先于 `DATA_DIR` 派生路径 |

### `.env` 加载
Server / Worker 启动时自动加载 cwd 下的 `.env`（godotenv），shell / pod env 优先（不会覆盖）。`.env.example` 在仓库根，`.env` 在 `.gitignore`。

### gRPC 配置
- `MaxRecvMsgSize` / `MaxSendMsgSize`: **64 MiB**（chunked transport 后单个 Send 永远 ≤ 64 KiB，64 MiB 只是上限兜底，给重组后的整 chart blob 留余量）
- `InitialWindowSize` / `InitialConnWindowSize`: **4 MiB**（5–10× 默认 64 KiB，单 RTT 多发数据，减少流控等待）
- gRPC HTTP/2 keepalive：worker `Time: 20s / Timeout: 10s / PermitWithoutStream: true`；server 同样配 `KeepaliveServerParameters` + `KeepaliveEnforcementPolicy{MinTime: 5s}` 防 worker ping flood。**worker 离线检测完全依赖这个 PING**，不用应用心跳。
- chunk 大小：`chunkSize = 64 KiB`（在 `pkg/{worker/tunnel,server/gateway}/sender.go`）。e171965 从 256→64 KiB —— 跨境链路下大响应被切成更多片，per-request_id round-robin 调度的"一周时间"缩短 4×，小请求等待 round 的延迟更小（hack/loadtest.sh `hol` 子命令可回归验证）。
- **stream-level gzip 压缩**：两端 blank import `google.golang.org/grpc/encoding/gzip` 注册 codec；worker dial 时 `grpc.WithDefaultCallOptions(grpc.UseCompressor("gzip"))` 启用出方向压缩；server `Connect` handler 开头调 `grpc.SetSendCompressor(stream.Context(), "gzip")` 启用反方向。JSON / unstructured 类响应压缩比 5–8×。**滚动升级注意**：两端都必须先 import 注册 codec 才能开 UseCompressor —— 多租户 / 分批升级时让 server 先发布(有 decode 能力,即使不主动 compress)。

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
- **stream Send 只能由 prioritySender 调用**：`grpc.ClientStream` / `grpc.ServerStream` 的 `Send` 不并发安全。worker `pkg/worker/tunnel/sender.go` 和 server `pkg/server/gateway/sender.go` 各起一个 sender goroutine 独占 Send，所有 producer（HTTP handler、流式会话、心跳）只能往 `sendFast` / `sendSlow` 入队。**禁止重新引入 sendMu 或直接调 stream.Send**（Register / RegisterAck 是连接建立期间唯一的例外）
- **fast lane 给 Heartbeat，slow lane per-request 公平 round-robin**：sender 永远先 drain fast 才动 slow。**slow lane 不是单 FIFO**：按 `msg.RequestId` 分子队列(空串 = 控制帧共用 bucket),sender 轮流从每个非空子队列取 1 帧。同一 request 的帧 FIFO 保序,不同 request 的帧 wire 上交错(rxAccumulator 按 request_id 重组,接收端无感知)。**新增帧类型时把 `RequestId` 填上正确的 request_id / session_id 就自动享受公平调度**;留空(=控制帧)会归到共用 bucket。需要保证某帧不被数据 chunk 挡住时,加到 fast lane(如 LogsCancelRequest)
- **`sendSlow` 不阻塞 producer**：append 到子队列后立即返回 nil。sender 已死时返回 `ErrSenderClosed`,但 done 与 mu 之间存在 race —— producer 可能成功 append 后 sender 才挂(消息被孤立,GC 时连同整个 prioritySender 回收)。语义上"fire and forget on disconnect",对调用方无影响:断连后 server 端 `<-w.Stream.Context().Done()` 会向所有 pending 调用方报 "worker disconnected"
- **大消息必须 chunked**：HTTPResponse body / ResourceResponse data / chart blob 等都不能直接塞进单 message，必须用 `gateway.HTTPResponse` / `gateway.ResourceResponse` / `pluginservice.Command` + 走对应 `sendChunked*` helper。新增大数据消息时仿照这个模式，**不要新加 unary 大 message**
- **离线检测**：worker 离线由 `stream.Context().Done()` 触发（依赖 gRPC HTTP/2 keepalive PING 失败）。`ConnectedWorker.lastSeen()` 仅作 debug snapshot 暴露给 `/metrics`，**不参与判定**
- **一次性请求-响应**（list/get/apply/update/patch/delete K8s 资源）：用 `gateway.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{...})`，返回 `*gateway.ResourceResponse`
- **反代 HTTP**：用 `gateway.SendHTTPRequest(ctx, clusterID, &gateway.HTTPRequest{...})`，返回 `*gateway.HTTPResponse`。Body 字段允许 >32 MB，gateway 自动 chunk
- **流式会话**（Pod 日志 / exec / 反代 WebSocket）：用 `gateway.OpenStream(clusterID)` 拿 `*Stream`，`Stream.Send(payload)` 写、`<-Stream.Recv()` 读、`Stream.Close()` 关
- **Worker 断开时**：gateway `unregister` 自动 `closeClusterStreams` 清理活跃 stream + `worker.rxAsm.reset()` 丢弃半组装的入站 chunked 请求，确保重连从干净状态开始
- **Worker 端流式会话**：`tunnel.Client.StreamContext()` 暴露 per-connection ctx，`connect()` 退出（含 keepalive PING 超时、网络断、reconnect）时 defer cancel。`LogsManager` / `ExecManager` 的 session ctx 都派生自它——tunnel 一断 K8s 侧的 SPDY exec / log Stream 立刻 unwind，不会等到下次 Send 失败才退出

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
- chunked 大消息：新增 `*Start` 帧时同步加 receiver 端的 `rxAsm.open` 调用 + `dispatchAssembled` (worker) / `finalizeChunkedResponse` (server) 分支；body 直接复用现有 `BodyChunk`/`BodyEnd`，**不要为每个大消息单独造一对 chunk/end**

> K8s 资源代理（Worker 端）的写动作语义、Describe fallback、RESTMapper 缓存等细节见 [docs/clusters.md](docs/clusters.md) 的「K8s 资源代理」一节。
> 写操作 protection 的设计取舍（为何下放给 K8s RBAC、原 `pkg/server/protect/` 7 类规则为何撤掉）见 [docs/clusters.md](docs/clusters.md) 的「写操作 protection」一节。

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
| `/models` | 模型服务 | landing = 模型仓库（catalog + CRUD）；模型部署 / chat 调试 / 路由在 P16+ 落地 |
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

> ⚠️ **页面级条件 fetch**：page 级 `useRequest({ ready, refreshDeps })` 同样有上面这个 bug。`web/src/hooks/useClusterRequest.ts` 封装了 `manual: true + useEffect` 的正确模式，签名 `(service, deps, { ready })`，返回 `{data, loading, error, refresh, mutate, run}`。Compute/Volcano 的非列表页（Overview + Scheduler + VGPU + 4 个 P14 新页 + GrafanaEmbed）走这个。**列表分页用 `useVolcanoList`**：返回 `{ items, loading, error, refresh, loadMore, hasMore, total }`，K8s `continue` token 在 hook 内串起来，单次 cap 500 行，`TruncatedBanner` 的 load-more 按钮直接调 `loadMore`；10 个 Volcano CR 列表页都用这个。原生 `useRequest` 留给真的需要 polling / 复杂 manual 控制的场景。

> ⚠️ **hooks 顺序**：React 跟踪 hook 调用顺序。所有 `useMemo` / `useEffect` / `useCallback` 必须在任何 early-return 之前调用，否则当条件改变（如 RESOURCE_NOT_AVAILABLE 错误第一次出现）时 React 会抛 "Rendered fewer hooks than expected"。已踩过 —— QueueQuota 把 early-return 插在 `useClusterRequest` 之后 / 三个 `useMemo` 之前,集群无 Volcano 时挂掉。

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
| P4 | 插件系统（Plugin CRD + Helm SDK + Server 注册表 + 集群启用/禁用 + 状态同步 + 内置插件） | ✅ 完成 |
| P5 | 监控中心 + 日志中心（Grafana iframe + auth.proxy + HTTP/WS 反代 + 内置 dashboard overlay） | ✅ 完成 |
| P6 | 平台架构重构 + 集群管理收尾：4 顶级平台拆分（集群 / 算力 / 模型 / 插件）+ Node 写操作收敛（cordon scoped 端点 + `_cr` URL 绕过修复 + protection 改为基于 GVK）+ Pod 即时指标（`kubectl top` 等价）+ Metrics Server / kube-state-metrics / Volcano 内置插件 + 全栈 review 修复（DeleteCluster 404、LastSeen atomic、polling timer ref、UpdateCluster 唯一性 race、ListPluginsBrief、replay 不补 Failed 等 6 项）+ 详细文档拆分到 `docs/` | ✅ 完成 |
| P7 | Volcano 转向 - 定位调整：平台改名（算力管理 → **算力调度**，模型管理 → **模型服务**），删 HAMi 内置插件 + DB 行，文档定位调整；同期废弃原 GPU dashboard（HAMi annotation 双格式解析 + Pod-to-card 归属 + Snapshot informer 缓存）—— 完整替代由后续 P11 vGPU 重新实现 | ✅ 完成 |
| P8 | Volcano 核心对接：5 个 CR 浏览器（Queue / Job / CronJob / PodGroup / HyperNode）+ 类型化创建编辑表单（form / YAML 双视图）+ 生命周期操作（bus.volcano.sh Command）+ 调度策略可视化编辑器（actions / tier / plugin 元数据 + 新手提示）；旧 GPU dashboard 与 HAMi 解析器 / snapshot informer 全量删除 | ✅ 完成 |
| P9 | 算力调度页性能重写：worker 加 `list-full` action，server 加 5 个专用 list 端点按 kind 投影 slim row，前端 5 个页改写为单 useRequest + ProTable，cell 全部 props-driven。N+1（100 队列 = 101 请求）→ 1 请求 / 刷新；删 CRPage / sharedFetch / WorkloadsContent 扩展点 | ✅ 完成 |
| P10 | 集群 + Volcano review 硬化：全栈 review 修复。集群侧：gateway RegisterAck Send race、流式会话 ctx 派生自 tunnel.StreamContext()、Pod 日志 64 MiB 字节封顶、HTTP/WS 反代 URL scheme 白名单、describe panic recover、exec writer onSendErr cancel、proxy 读/写超时拆分（120s / 30s）、UpdateCluster TOCTOU 删除等 ~12 项。Volcano 侧：server workerTimeout 拆 read/write 与 worker 对齐、5 list 端点接 `limit + continue` 透传 + 响应 shape 改 `{items, continue?, remainingItemCount?}` 带截断兜底、worker listFull 剥 managedFields + 加 effective ns 日志、5 页 + 2 form i18n 完整覆盖、QueueForm editOriginalRef 镜像 spec.priority、useStaggeredRefresh 解决 setTimeout-on-unmounted 等 13+3 项 | ✅ 完成 |
| P11 | vGPU 实况：worker `pkg/worker/proxy/vgpu.go` 解析 `volcano.sh/node-vgpu-register` + `vgpu-ids-new` annotation，server `/api/v1/clusters/:id/vgpu` 返回集群 → 节点 → 卡 → Pod 树，前端 `/compute/:id/vgpu` 渲染 KPI + 节点列表；volcano-vgpu-device-plugin 包成 wrapper Helm chart（go:embed + 启动时 helm package）加为内置插件 | ✅ 完成 |
| P12 | P11 收尾打磨。**vGPU 页**：完整重构 —— KPI 三个利用率（slots / memory / cores）改用 `Progress.dashboard` 环形仪表盘（cores 客户端聚合自每张卡）；旧的"节点表 + 展开行 = 卡列表"改成 card-per-node 列表，每节点头部三段聚合 bar，节点下方逐张卡一行（身份 + 三 bar + Pods 占用），所有信息默认可见无展开；pod 名点击改打开 DescribeDrawer（不是 Logs）；UUID 尾截 `…hhhhhhhh`；搜索框 + 排序 + drilldown 到节点 / health banner / 空集群 CTA。**chart**：两个 ConfigMap 都放 release namespace（默认 `volcano-system`），device-config 依赖 binary 的 `kube-system → volcano-system` fallback 链，去掉之前错误的 kube-system pin；display_name 缩 "Volcano vGPU"；description 修到 varchar(500) 内。**架构**：删除 `pkg/server/protect/`（写保护全部归还给 K8s RBAC + controller）。**schedulerMeta**：`arguments` 加入已知 top-level key。**Volcano 内置 chart**：默认 scheduler.conf 已带 `deviceshare` 插件 + `VGPUEnable: true`（新装即用）；默认 release namespace 改成 `volcano-system`。**Job/CronJob/Queue 表单**：原生 vGPU 三件套字段（number / memory / cores）；JobForm 编辑时 Alert 提示 webhook 三字段限制 + submit-time diff 拦截。**Overview / Scheduler**：Volcano 检测 cluster-side（worker 探 Queue CRD + ConfigMap field-selector），不再依赖 kpilot 插件注册表；Overview list fetch 走 `Promise.allSettled` 容忍可选 sub-CRD 缺失。**plugin install log**：修 10 分钟 buffer TTL 内重新 enable 旧 end 帧误关 WS 的 bug。**hack/**：`aliyun-gpu.sh` → `remote-k3s.sh` 改名 + 跨平台 tunnel pid 跟踪 + SSH multiplex；Tencent/GCP/EC2 镜像 root 密码 SSH 禁用时自动通过 ubuntu/centos/ec2-user/admin 用同密码登录 + sudo bootstrap pubkey 到 root；GPU 节点缺 NVIDIA Container Toolkit 时自动 apt 装上。 | ✅ 完成 |
| P13 | GPU 物理卡监控：NVIDIA DCGM Exporter 内置插件（repo chart 4.8.2，sort_order 27，DaemonSet 暴露 `:9400` Prometheus 指标）。**首版用 Grafana iframe 嵌 dashboard 12239，后修订为完全自绘**：新增 server-side `pkg/server/api/handler/gpu_metrics.go::GetGPUMetrics` 通过 `gw.SendHTTPRequest` 并发跑 6 条 PromQL（util/temp/power/fbUsed/fbTotal/SM/tensor），server 预算 snapshot；前端 `pages/Compute/Volcano/GPUMonitoring.tsx` 用 `@ant-design/plots` Line + Progress.dashboard 渲染 4 KPI 卡 + 6 张多线时序图，required 改成 `victoria-metrics + dcgm-exporter`（**不再依赖 grafana**）。删除 `pkg/server/dashboards/builtin/nvidia-dcgm.json` + `embed.go` 里的注册条目。Grafana 嵌入只留给「集群管理」的通用监控 / 日志页。算力调度 = 专用形态，集群管理 = 通用形态 | ✅ 完成 |
| P14 | 资源治理三件套 + 集群管理可观测性重写 + Grafana 反代硬化。**共享层**：抽 `pkg/server/api/handler/vm_query.go`（`resolveVMQueryURL` 通过 plugin DB lookup 拿 VictoriaMetrics Service FQDN + `queryVM` instant + `queryVMRange` matrix + `urlQueryEscape`），DeviceHealth / GPUHour / GPUMetrics 三 handler 共用；同源端 `vm_cache.go` 4s TTL response cache 跨所有 VM-backed endpoint 共用。**队列配额**（`/queue-quota`）：`queueRow` 加 `Priority` / `Guarantee`（unwrap `spec.guarantee.resource`）/ `Deserved` 三字段；前端缩进树形 Queue Select（默认选 `root`）+ 主卡片 + 子 Queue 递归卡片；每资源行纯 CSS 自绘三 tick bar（capability=track / allocated=填充 / guarantee=绿色竖线 / deserved=紫色竖线），未设上限走斜纹空轨道 + 超限 / 未达保障 Alert。**GPU 告警**（`/device-health`）：4 条 PromQL 并发（XID / 30min ECC increase / 温度 ≥85 / FB ≥95%）走 worker tunnel，单 query 失败仅 log 跳过；server 预算 severity counts，**alert 句子全部前端 i18n**（zh-CN / en-US 双套 message 模板，server 只下发 `kind` + `value`）。单一 ProTable（空数据走 `locale.emptyText`），RefreshControl 在 `toolBarRender`。**GPU-Hour 用量**（`/gpu-hour`）：`avg_over_time((DCGM_FI_DEV_GPU_UTIL/100)[range:step])` × 窗口小时 = GPU-Hour 数（step 1h→1m / 24h→5m / 7d/30d→15m），server 按 hours 倒序返回 + total；前端 Radio.Group range picker + 双 Statistic 卡 + ProTable + share `<Progress>` 占比；30d 多挂 retention warning。v1 仅按 (Hostname, gpu) 聚合，Queue / Namespace 细分留作后续（需要 worker 周期性 Volcano 分配快照持久化）。**worker 端 in-cluster Service URL 路由**：`*.svc.*` 自动改走 K8s API server 的 service-proxy 端点（`/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/<path>`），生产部署 + 本地调试都通，HTTP / WS 共用 `InClusterRouter` 24h TTL 决策缓存。**`/clusters/:id/monitoring` 改自绘**：删 Grafana iframe + 内置 dashboard 依赖，新增 4 个后端端点（cluster-metrics / node-metrics / pod-metrics / pod-health），多层 KPI / 节点趋势 / Pod top-N / Pod 健康表，覆盖 cluster CPU/mem/Pods+Pending、node CPU/mem/disk%/disk I/O+IOPS/net/loadPerCore/netErrors/inode/tcpRetrans、pod CPU/mem/netRx/netTx/cpuThrottle/fsRead/fsWrite/memLimitRatio。Pod 段本地 namespace picker（不连全局 `useModel('namespace')`，每次进页面默认全部 ns），pod 名搜索只匹配 pod 部分。**`/clusters/:id/logging` 改自绘**：删 Grafana iframe，自绘 LogsQL 搜索 + 直方图，留空 query 后端默认转 `*` = 全部日志；namespace + pod 下拉选择器自动构造 stream selector 回填到输入框（用 `kubernetes.pod_namespace` / `kubernetes.pod_name` 字段名，Pod 列表从 `/workloads/pods` Table API shape 解析 `rows[].object.metadata.name`）。**`/clusters/:id/grafana` 独立 escape hatch**：剥离原 monitoring/logging 的 iframe，定位 power user。**Grafana 反代两个 service-proxy fallback bug**：(1) `rest.RESTClient.Do().Raw()` 只返 status+body 吞 header 改用 `rest.HTTPClientFor` + 手动 http.Request；(2) K8s apiserver text/html 响应 body URL 改写无法关停（写死的 PathPrepend 逻辑），worker 收响应后 `bytes.ReplaceAll` 反向擦掉前缀。**Grafana 角色 fix**：seed.go 加 `auth.proxy.headers: "Role:X-WEBAUTH-ROLE"`（缺它 Grafana 静默忽略 X-WEBAUTH-ROLE 头）+ `auto_assign_org_role: Viewer→Admin`，老 Viewer 账号下次请求就被升 Admin。**收尾打磨**：所有 VM-backed 页（监控 / 日志 / GPU 监控）抽 `<TimeRangePicker>` 共享组件 —— 预设按钮 + antd RangePicker `showTime` 绝对范围；后端 `time_range.go::resolveTimeRange` 统一 `?range=` 或 `?from=&to=`，custom range 31 天 cap，step 按 duration 自动；日志 `limit` cap 1000→10000（VL 本身无硬上限）；超时按场景分级（VL search 30s→5min、VM 15s→60s、proxy 60s→5min）。**日志页 UX 重构**：full-bleed flex 布局（ResizeObserver 闭式公式 `viewport - wrapperTop - footerHeight - gap` 解决外层滚动条；Footer 组件加 `kpilot-footer` className 给 ResizeObserver 定位用）+ react-virtuoso 虚拟列表（10k 行 DOM 恒定）+ 大屏模式（Esc 退出）+ TXT/NDJSON 导出（纯客户端 Blob 下载）。**跨境 worker HA 加固**：跨境 server↔worker 链路实测有效带宽只有 ~20 KB/s,旧的单 FIFO slow lane + 无压缩导致大日志查询(20 MiB 响应)在 5min ctx 内根本下不完,且其他并发请求被 head-of-line block 2 分钟全部 504。一次性补四块:(1) **gRPC stream-level gzip 压缩**(两端 blank import `encoding/gzip` 注册 codec + worker `UseCompressor` + server `SetSendCompressor`),JSON 响应 wire 体积 1/5–1/8;(2) **prioritySender slow lane 改 per-request_id round-robin** 公平调度,小请求不再等大请求 chunk drain;(3) **`/logs/search` 与 `/logs/histogram` 改 SSE**(`pkg/server/api/handler/sse.go` 共享 helper,25s `progress` 心跳事件 + 终态 `result` / `error` 事件,前端 `services/kpilot/logs.ts` 用 EventSource 包成 Promise),穿透 Sealos/nginx-ingress ~60–300s idle timeout;(4) 新增 `GET /api/v1/clusters/:id/debug/tunnel-bench?bytes=N` 跨境带宽自测端点(worker 用 `crypto/rand` 回吐 N 字节真随机,server 计时算 kbps)。叠加效果:`limit=10000` 日志查询从 17min 超时变 3–4min 完成,且不阻塞并发请求 | ✅ 完成 |
| P15 | 模型服务 → 模型仓库：全局 `Model` 表（store/models.go::Model + store/model.go CRUD + store/seed_models.go 12 条 2026-05 主流内置预设：Qwen3-0.6B-Instruct（冒烟测试用，1.6 GB VRAM 任意 GPU）、Qwen3-8B/14B/32B-Instruct、Qwen3-30B-A3B-Instruct (MoE)、DeepSeek-R1、Llama-4-Scout-17B-16E-Instruct (MoE)、Mistral-Small-3.2-24B-Instruct、Phi-4、GLM-5.1、Gemma-4-31B、Kimi-K2.6，统一 pin vLLM `v0.20.2` 镜像；选型据 HF trending 2026 H1 / Artificial Analysis Intelligence Index 交叉验证）+ ModelFamily 枚举扩到 9 个（追加 `phi` / `gemma` / `kimi`）+ REST CRUD（`/api/v1/models`，handler/model.go，内置 PATCH/DELETE 返回 403 `MODEL_BUILTIN_LOCKED`，name 强 DNS-1123 label 校验便于 P16 直接用作 Deployment name）。**前端**：`ModelHub/index.tsx` 家族分组卡片 catalog（Collapse 按家族分 section，搜索 + License / Runtime 过滤，order 固定 built-ins → sort_order → name）+ `ModelCard.tsx`（每张卡 HF org logo 头像 + 内置 tag + 4 行截断描述 + runtime/GPU/license badges + Deploy 主按钮 + 复制为自定义 / 编辑 / 删除）+ `ModelDetailDrawer.tsx`（卡片点击 → 只读详情，复用 workloads `YamlEditor` 渲染 default_args 列表）+ `ModelDrawer.tsx`（新建 / 编辑 / **复制为自定义** 三种 mode；recommended_gpu 拆 3 字段：count / memoryGiB / model Select；default_args **每行一个 flag** 跟 DeployDrawer 统一）。`FAMILY_META`（label / 品牌色 / HF avatar URL）+ `RUNTIME_LABELS` + `RUNTIME_DEFAULTS`（image + defaultArgs per runtime，runtime 切换自动 swap）在 services/kpilot/model.ts 集中维护。抽 `pages.common.*` 共享 i18n 键（edit / delete / copy / copied / saved / identity / runtime / tuning / loading）。所有 background / text / border 走 `theme.useToken()` 适配暗色模式。docs/models.md 重写覆盖 schema / API / 内置预设 / FE 三段 | ✅ 完成 |
| P16-A | 模型服务 → 推理部署：`pkg/server/deploy` 生成 K8s manifests（Deployment + Service + 可选 PVC + 可选 HF Secret）→ 通过 worker tunnel apply 推到目标集群。**Model row = 模板**，同一模型可独立部署到多集群、同集群可多 instance（`{model.name}` 单实例 / `{model.name}-{instance}` 命名变体）；重复部署到同名 = SSA update。**Stateless 设计**：部署状态不进 DB，所有 manifests 打 KPilot 标签集（`app.kubernetes.io/managed-by=kpilot` + `kpilot.io/model-id` + `kpilot.io/model-family` 等），cluster 是 source of truth。`POST /api/v1/models/:id/deploy?dry_run=true` 给前端预览 YAML。GPU plumbing 二选一：`nvidia.com/gpu`（默认）或 `volcano.sh/vgpu-number`（需 volcano-vgpu-device-plugin）。HF token 落 Secret + envFrom 注入容器。PVC 默认开（heuristic 按模型名预估大小：0.6B→5G / 32B→100G / R1→1.4T），避免容器重启重新下载权重。dshm tmpfs 2 GiB 兜底 NCCL。**容器 resources 三层叠加**：① cpu/memory request + limit 可不同（burst headroom，K8s quantity strings 经 `resource.ParseQuantity` 校验）② GPU count requests==limits（device-plugin extended resource 强制）③ Volcano vGPU 子资源（`vgpu-memory` MiB + `vgpu-cores` 0-100%）limit-only，**仅当 gpu_type=volcano 时下发**。Container 还兜底 dshm tmpfs 2 GiB 给 NCCL，readiness probe 在 /health 上 5min failureThreshold 等 HF 冷下载。**前端 `ModelHub/DeployDrawer.tsx`** 三 tab 设计：「配置」（cluster Select / namespace / instance / replicas / GPU 数 / GPU 类型 radio / CPU+内存 request+limit 2×2 / Volcano vGPU sub-resources 条件渲染 / extra_args 每行一个 / HF Token 在表单底部 + autoComplete=new-password 防浏览器误填 / PVC 开关 + 大小）+「YAML 预览」（切 tab 自动 dry_run，复用 workloads `YamlEditor` 拿 CodeMirror + YAML mode + 主题色，表单 onValuesChange 失效缓存）+「部署结果」（仅首次提交后出现，per-doc Alert + Table，错误列 whiteSpace=pre-wrap 完整显示 K8s 错误信息）。Deploy 按钮 `disabled={!isFormReady}`（4 个 `Form.useWatch` 监听必填字段），未填完整不可点 + 预览 tab 显示提示而非空编辑器。`POST /api/v1/models/:id/deploy?dry_run=true` 走预览路径。"已部署列表" UX 暂不做（要求加 LabelSelector 到 proto，留给 P16-B 一起） | ✅ 完成 |
| P16-B | 模型服务 → 内置 chat 调试 + "已部署列表" UI | 待开始 |
| P16-C | 模型服务 → OpenAI 兼容反代 endpoint（`/api/v1/clusters/:id/proxy/inference/<deploy-name>`） | 待开始 |
| P17 | 模型服务 → OpenAI 兼容路由（按 model 参数路由后端，灰度 / A/B） | 待规划 |
| P18 | 模型服务 → 训练任务（基于 Volcano，分布式 fine-tune 的 gang scheduling） | 待规划 |
