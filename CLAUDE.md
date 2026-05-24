# KPilot

**Kubernetes 多集群管理 + GPU 算力调度 + 模型服务的一体化控制面。**

五个顶级平台：

| 平台 | 范围 | 详细文档 |
|---|---|---|
| 集群管理 (`/clusters`) | 通用 K8s 资源管理：节点、工作负载、监控、日志 | [docs/clusters.md](docs/clusters.md) |
| 算力调度 (`/compute`) | 基于 Volcano 的批量调度：Queue / Job / PodGroup CR 浏览，调度策略，vGPU 切分（volcano-vgpu-device-plugin），GPU-Hour 治理 | [docs/compute.md](docs/compute.md) |
| 模型服务 (`/models`) | 模型仓库、推理部署、调试、路由、训练任务 | [docs/models.md](docs/models.md) |
| 插件管理 (`/plugins`) | Helm chart 注册表，前三个平台的能力底座 | [docs/plugins.md](docs/plugins.md) |
| 系统管理 (`/system`) | KPilot 控制面自身的运维门面：系统监控（server + 每个 worker 的 runtime / 业务计数器 / pprof，PG-backed 1d 历史）、系统日志占位 | [docs/system.md](docs/system.md) |

Server(中心控制面)+ Worker(集群侧 Operator),通过 **yamux 多路复用**(裸 TCP 连接;生产部署在集群 ingress 层做 TLS 终止,server 进程本身不带 TLS,见 `cmd/server/main.go::net.Listen`)连接 —— 每个 RPC / 流式会话开独立的 yamux stream,由 yamux 内置 flow-control + 公平调度处理 HOL/取消,应用层不再做这些。详见 [docs/transport-v2.md](docs/transport-v2.md)。

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
  │  yamux session over TLS（Worker 主动 dial 进来；
  │  每个 RPC / 流式会话开独立 stream）
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
3. 管理员将 ClusterToken + Server transport 地址配置到目标集群,部署 Worker
4. Worker 启动,携带 Token 发起 TCP + yamux 多路复用连接(详见 [docs/transport-v2.md](docs/transport-v2.md))
5. Server 验证 Token，将连接与集群绑定，标记集群 Online

---

## yamux 传输协议

**一条 TCP 连接 + hashicorp/yamux 多路复用**。worker 主动 dial server(NAT 友好);worker 端可选 `grpcs://` / `https://` 触发 `tls.Dial`(到 ingress 那一跳的加密),server 进程 `net.Listen("tcp")` 不带 TLS —— 生产部署在集群 ingress 层(nginx-ingress / Traefik / cloud LB)做 TLS 终止。dial 成功后 worker 端 yamux.Client + server 端 yamux.Server 各自起 session;之后**每个 RPC / 流式会话开一条独立的 yamux stream**(≤一行代码 `session.Open()`/`Accept()`)。

为什么是 yamux 而不是 bidi gRPC：HTTP/2 的多流复用我们用不到（gRPC 设计是"一条 stream 一个 RPC"，bidi stream 当多路复用器用就得在应用层重搓 chunk + per-request 调度 + cancel 帧 + accumulator 等十几项手搓优化）。yamux 直接给你这些。详细的对比 + 实测见 [docs/transport-v2.md](docs/transport-v2.md)。

### Stream 类型（`pkg/common/proto/v2/pilot.proto::StreamKind`）

| Kind | 用途 | 谁开 | 帧序列 |
|---|---|---|---|
| `STREAM_REGISTER` | 鉴权握手 | worker | RegisterRequest → RegisterAck → close |
| `STREAM_RESOURCE_REQUEST` | K8s 资源代理（list/get/apply/update/patch/delete/describe） | server | ResourceRequest → ResourceResponse → close |
| `STREAM_HTTP_REQUEST` | 反代 HTTP（buffered / streaming 两 mode） | server | HTTPRequestStart + body bytes → HTTPResponseStart + body bytes → close |
| `STREAM_PLUGIN_COMMAND` | Helm 插件 enable/disable（chart .tgz blob 直接走 stream 字节流） | server | PluginCommand + blob bytes → PluginCommandAck → close |
| `STREAM_PLUGIN_STATUS_PUSH` | Plugin CR status 上报（事件驱动） | worker | PluginStatusPush → close |
| `STREAM_PLUGIN_LOG_PUSH` | 插件安装日志流 | worker | PluginLogChunk*（哨兵 0-payload 后跟）PluginLogEnd → close |
| `STREAM_POD_LOGS` | Pod 日志流 | server | LogsStartRequest →（worker 端）LogsChunk*（哨兵 0-payload 后跟）LogsEnd → close |
| `STREAM_POD_EXEC` | Pod exec 终端 | server | ExecStartRequest →（双向）ExecStdin/ExecResize ↔ ExecOutput → ExecEnd → close |
| `STREAM_WS_PROXY` | 反代 WebSocket | server | WSStartRequest →（双向）WSFrame ↔ WSFrame → WSEnd → close |

### 关键设计点

- **每个 stream 携带 `StreamHeader{Kind, RequestID, Gzip}`**（第一帧 length-prefix prefix），不再有 `WorkerMessage`/`ServerMessage` oneof envelope
- **取消 = `stream.Close()`** —— yamux FIN 传到对端，对端用 cancel-watcher goroutine（阻塞 1-byte Read）观察。**FIN 不是 RST**：peer 收到 FIN 后仍可继续写,所以**绝对不能在 request 写完后立刻 CloseWrite**（详见 [docs/transport-v2.md 第 16 节](docs/transport-v2.md#16-上线后修订2026-05)）
- **大消息直接当字节流写**（HTTP body、chart blob、ResourceResponse data）—— yamux 内置 flow-control window 自动反压,不需要 chunked 帧 / accumulator
- **per-stream 公平调度**：yamux 内部 round-robin,大流不会 HOL block 小流,不需要应用层 prioritySender
- **per-stream 压缩**：codec 按 `StreamHeader.Gzip` 决定是否裹 gzip.Reader/Writer。reader 延迟初始化(避免 net.Pipe 上双向 EnableGzip 死锁,见 `pkg/transport/yamux/codec.go`)
- **离线检测**：yamux 内置 KeepAlive PING（默认 30s,我们配 20s）+ `Session.IsClosed()`；不再有应用层 Heartbeat
- **一条 stream 上多种 message type**（如 LogsChunk vs LogsEnd）通过 **0-payload 哨兵帧**切换 —— worker MUST 在切类型前发一个空帧。完整 contract 在 `pkg/server/gateway/stream.go` 的 package doc

### 包结构

| 包 | 职责 |
|---|---|
| `pkg/transport/yamux` | 协议无关的传输层：Session 包装、Codec(length-prefix protobuf + lazy gzip)、Stream 包装 |
| `pkg/server/gateway` | server-side yamux Accept + 业务流分发(Send* helpers + Open*Stream typed openers) |
| `pkg/worker/tunnel` | worker-side yamux Dial + STREAM_REGISTER 握手 + Handlers struct(OnResource / OnHTTP / OnPlugin / OnLogs / OnExec / OnWS) |
| `pkg/worker/proxy`, `pkg/worker/plugin` | 业务侧 `HandleStream(ctx, *transportv2.Stream)` 入口 |

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
│   │   ├── deploy/          # 模型推理部署生成器（P16）：从 store.Model + DeployOptions 拼出 Deployment + Service + 可选 PVC/Secret，返回 unstructured 列表 + YAML 预览文本；走 handler/applyOneDoc 推到集群
│   │   ├── dashboards/      # 内置 Grafana dashboard JSON（go:embed）+ overlay 合并器
│   │   ├── plugins/         # 内置 Helm chart 源（charts/<name>/，go:embed）+ 启动时 helm package 出 .tgz 写 PluginBlob
│   │   ├── config/          # Server 环境变量
│   │   ├── diag/            # 系统监控数据管线：`poller.go` 单 writer per node（每 15s 拉一次 server loopback 或 worker /debug/snapshot through yamux，patch identity.name → cluster_name，INSERT PG `system_snapshots` JSONB）+ janitor（每 15min DELETE > 25h）+ 启动时按 store.ListClusters reconcile；`collectors.go` 业务 collector（YamuxCollector / DBCollector / HTTPCollector / InferenceCollector / CachesCollector）。HTTPCollector 双 buffer live/prev + 1s rotate，hot path 每请求 5-7 atomic 操作零 mutex
│   │   └── gateway/         # 纯传输层：yamux Accept + Worker 会话注册中心。`server.go` GatewayServer + ConnectedWorker（只持有 yamux.Session + clusterID + lastSeen）。`yamux_accept.go` AcceptYamux + STREAM_REGISTER 握手 + dispatchInboundStream（worker 主动开的 PLUGIN_STATUS_PUSH / PLUGIN_LOG_PUSH）。`send.go` SendResourceRequest / SendHTTPRequest 等同步 helper —— 内部 `session.Open()` 一条流、写 request、读 response、close,handler 看到的还是完整 struct（`gateway.HTTPRequest` / `gateway.ResourceRequest` / `pluginservice.Command`）。`http_stream.go` SendHTTPRequestStream + HTTPStream（Body 直接是 yamux Stream 的 io.Reader,**不再有 chunks channel / accumulator**）。`stream.go` OpenLogsStream / OpenExecStream / OpenWSStream typed openers + 哨兵帧契约 package doc。`plugin.go` SendPluginCommand 60s ack 超时 + replayPendingPluginCommands。BuildEnableCommand / handlePluginStatus 委托给 pluginservice（通过 ClusterDomainResolver 接口反向调用拿 worker 上报的 cluster_domain）
│   ├── worker/
│   │   ├── apis/v1alpha1/   # Plugin CRD Go 类型 + DeepCopy
│   │   ├── plugin/          # Plugin CRD reconciler + Helm SDK + chart cache + manager
│   │   ├── proxy/           # K8s 资源代理 Proxy.HandleStream（list/get/apply/update/patch/delete/describe + `tunnel-bench` 跨境链路诊断 action）+ LogsManager.HandleStream（cancel-watcher → ctx.Cancel → kubectl-logs unwind）+ ExecManager.HandleStream（reader goroutine defer cancel → sessCtx 撤销）+ HTTPProxy.HandleStream（buffered + handleStreamingResp 两 mode；streaming 路径 cancel-watcher 触发 upstream HTTP ctx 撤销）+ WSManager.HandleStream（reader/writer pump 双向桥；任一边关另一边自动 unblock）+ InClusterRouter（in-cluster `*.svc.*` URL 优先直连 dial，DNS 失败 fallback 到 K8s API service-proxy；决策按 24h TTL 缓存，HTTP / WS 共用） + VGPUTracker（解析 Volcano vGPU annotation）
│   │   ├── config/          # Worker 环境变量
│   │   ├── diag/            # 系统监控 worker 侧：业务 collector（TunnelCollector / ProxyCollector inflight 5 类 / RouterCollector），`Serve(ctx, *diag.Diag)` bind 127.0.0.1:0 起 http.ServeMux 挂 `pkg/diag` 端点，返回端口号给 `tunnelClient.SetDiagPort` → STREAM_REGISTER 时上报给 server
│   │   └── tunnel/          # yamux Client。`client.go` TCP / TLS dial(URL scheme 决定 `net.Dial` vs `tls.Dial`)+ yamux.Client + STREAM_REGISTER 握手 + 重连循环 + Accept loop + Handlers struct(OnResource / OnHTTP / OnPlugin / OnLogs / OnExec / OnWS)+ push helpers(PushPluginStatus / PushPluginLogLine / PushPluginLogEnd —— 主动 Open stream 上报)。`types.go` PluginCommand / PluginSpec / ChartSource 业务类型。**没有 sender.go / chunked.go** —— yamux 自带 flow-control + 公平调度,大消息直接当 stream 字节流写
│   └── common/
│       ├── proto/v2/        # protobuf v2 生成代码（不手动编辑；v1 pilot.pb.go 已删）
│       ├── vgpu/            # vGPU snapshot 共享 JSON 类型（worker 投影 → server 透传 → 前端渲染）
│       └── volcano/         # volcano-status 探测共享类型（installed + schedulerConfigMapNamespace）
├── proto/                   # .proto 源文件
├── web/                     # 前端（见下方前端规范）
├── deploy/
│   ├── server/              # Server K8s manifests
│   └── worker/              # Worker Helm Chart
├── docs/                    # 5 平台详细文档
├── hack/                   # 脚本（proto 生成等）
└── pkg/diag/               # 通用诊断底座（零业务依赖，纯 stdlib + gopsutil v4 跨平台）。`Diag.New(kind, name, version)` + `Register(Collector)` + `Snapshot()`、`Mount(mux, prefix)` 挂 `/info` + `/snapshot` + `/pprof/*`；runtime/metrics 投影 50+ key（heap 各段 + GC pause p50/p90/p99 + sched latency 分位 + CPU 各类 + mutex wait + alloc rate + live objects）；进程级 RSS / open_fds / mem_total 走 gopsutil v4 跨 Linux/macOS/Windows 均可用；Linux 额外读 `/sys/fs/cgroup/memory.{max,limit_in_bytes}` 让 mem_total 反映容器 cgroup 限制。**未来可拆成独立 module 接到任意 Go 项目**
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
│   ├── ModelHub/            # 模型仓库（P15）+ 推理部署（P16）：`/models/catalog`。`index.tsx` 家族分组卡片 catalog（Collapse + 搜索 + 过滤）；`ModelCard.tsx` 单卡（HF logo + 描述 + badges + Deploy 主按钮 + Edit/Duplicate/Delete）；`ModelDetailDrawer.tsx` 只读详情；`ModelDrawer.tsx` 新建/编辑/复制为自定义 三 mode；`DeployDrawer.tsx` 部署 drawer 三 tab（配置 / YAML 预览 复用 workloads YamlEditor / 部署结果）
│   ├── ModelDeployments/    # 模型实例（P16）：`/models/deployments`。跨模型 + 跨集群一张 ProTable（family / runtime / cluster / status 多 filter），per-row 模型调试 / Describe 跳 workloads / Delete；catalog 行被删的孤立 deployment 仍显示并打 Tag
│   ├── ModelChat/           # 模型调试（P16）：`/models/chat`。全屏 playground，URL 驱动 `?cluster=&ns=&name=` 选实例（grouped Select），左 Card 系统提示词 / 温度 / max_tokens 旋钮，右 Card 对话区（Row align="stretch" + 两侧 flex:1 等高），user / assistant / system 三色头像；request 用 server 下发的 `instance.model_field`（= `HuggingFaceID || deployment.name`）严格匹配 vLLM `--model` 启动值，否则 404；0 部署时整页 Result 引导跳 catalog
│   ├── APIKeys/             # API Keys（P16）：`/models/api-keys`。操作员 ProTable 管理 OpenAI 兼容反代的 Bearer 令牌。Create Drawer 二级 picker（cluster Select → 该集群下的推理实例 Select，切 cluster 自动 clear deployment）；签发成功 Modal 一次性展示明文 token + 复制按钮 + curl usage 示例（`maskClosable=false` 防误关丢 token）；列表列 prefix / 授权 scope / 状态 / 最近使用 / 创建时间 + 撤销（软删，保留审计行）/ 删除（硬删）两个 row action
│   ├── Plugins/             # 全局插件注册表 CRUD
│   ├── System/              # 系统监控（P19）：`/system/monitor`。`index.tsx` landing ProTable（10s setInterval polling `batchSystemSnapshots()` → server + 每 worker 一行；CPU/Memory 列用 `<Progress>` + `usageColor` 红/橙/绿；CPU 需 prev+cur 两次 snapshot delta，首次 0%；查看按钮**离线也可点**，PG 有 1d 历史可做事后分析）；`Detail/index.tsx` 详情页（header subtitle = `hostname · pid · app · go · goos/goarch · M/N procs` 单行小字；body toolbar `<TimeRangePicker>` 1h/3h/6h/12h/24h + 绝对范围 + polling tag + pause button；8 KPI 卡 2 行×4 列；7-8 tab，antd Tabs `destroyOnHidden` 避开 G2 hidden-pane 闪烁；**live 模式 = preset 1h** 15s `?since=` 增量追加，其他范围切换 = 全量重 fetch；stale = `now - lastAt > 30s` 显示 banner + 禁用 pprof；pprof 6 个低开销按钮直接 `window.open`，CPU profile / trace 两个 `danger` Modal 二次确认才带 `?confirm=true`）
│   ├── SystemLogs/          # 系统日志占位页（P19）：`/system/logs`。后端 endpoint 待落地；现仅显示 `<Result>` icon + "待落地" message
│   └── exception/404/
├── services/kpilot/         # API 服务（auth、cluster、node、workload、pod、plugin、model 模型仓库、volcano、vm-backed device-health / gpu-hour / gpu-metrics / monitoring / logs、system 监控 listSystemNodes/batchSystemSnapshots/listSystemHistory + pprofURL）
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
| Server↔Worker 通信 | hashicorp/yamux over TCP(详见 [docs/transport-v2.md](docs/transport-v2.md)) |
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
| `YAMUX_ADDR` | `:9090` | Worker 回连的 TCP 监听地址(yamux 多路复用,详见 [docs/transport-v2.md](docs/transport-v2.md)) |
| `DSN` | `postgres://...` | PostgreSQL 连接串 |
| `ADMIN_USERNAME` | `kpilot` | 管理员用户名 |
| `ADMIN_PASSWORD` | `kpilot123` | 管理员密码 |
| `JWT_SECRET` | 随机 | JWT 签名密钥，未设置则每次重启失效 |
| `CORS_ORIGINS` | 空（开发宽松模式） | 生产环境设置前端域名，逗号分隔 |

### Worker 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SERVER_ADDR` | `localhost:9090` | Server transport 地址(Worker 视角,TCP + yamux 多路复用,不是 gRPC)。支持三种格式:裸 `host:port`(明文 TCP)/ `grpc://host[:port]`(明文 TCP,默认 80;命名是 v1 兼容别名)/ `grpcs://host[:port]`(TLS TCP,默认 443,适用于走 HTTPS ingress 暴露的场景;同样是 v1 别名)。`tcp://` / `tcps://` 可读性更好,行为完全等价 |
| `CLUSTER_TOKEN` | 空 | 必填，集群创建时 UI 一次性展示的 token |
| `DATA_DIR` | `/var/lib/kpilot` | 持久化根目录。`charts/` 放 Helm chart .tgz cache，`helm/` 放 Helm 仓库配置 + cache |
| `CLUSTER_DOMAIN` | `cluster.local` | K8s 集群 DNS 域。register 时上报给 Server，反代构 FQDN 时用 |
| `HELM_REPOSITORY_CONFIG` / `HELM_REPOSITORY_CACHE` | 空 | Helm SDK 自身 env，设了优先于 `DATA_DIR` 派生路径 |

### `.env` 加载
Server / Worker 启动时自动加载 cwd 下的 `.env`（godotenv），shell / pod env 优先（不会覆盖）。`.env.example` 在仓库根，`.env` 在 `.gitignore`。

### 传输层配置（`pkg/transport/yamux/config.go`）
- **AcceptBacklog**: 256（最多 256 个并发未处理 inbound stream）
- **MaxStreamWindowSize**: 4 MiB（per-stream flow-control 窗口；上调自 yamux 默认 256 KiB，跨境链路单 RTT 多发）
- **KeepAliveInterval**: 20s + **ConnectionWriteTimeout**: 10s（PING 失败 30s 内 yamux 自动关 session）
- **Per-stream gzip**: 由 `StreamHeader.Gzip` flag 决定;codec lazy-init reader 避开 net.Pipe 双向 EnableGzip 死锁。`STREAM_RESOURCE_REQUEST` / `STREAM_HTTP_REQUEST`（buffered mode）默认开；`STREAM_POD_LOGS` / `STREAM_HTTP_REQUEST`(stream mode) 关（per-line flush 不适合 gzip）
- **没有单消息大小上限** —— stream 字节流模式天然按需读;不需要 v1 的 `MaxRecvMsgSize: 64 MiB` 兜底
- **离线检测**：`session.IsClosed()` 或 `<-session.CloseChan()`,触发即视为掉线。worker 端 reconnect loop 在外层 for 循环重试 dial

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

### yamux 与 Worker 通信
- **每个 RPC / 会话开一条独立的 yamux stream** —— 由 `session.Open()` (server 侧) 或 worker handler 的 `Accept` loop (worker 侧) 提供;**禁止把多个 RPC 复用在一条 stream 上**(那就回到了 v1 的 bidi 模式)
- **一次性请求-响应**（list/get/apply/update/patch/delete K8s 资源）：用 `gateway.SendResourceRequest(ctx, clusterID, &gateway.ResourceRequest{...})`，返回 `*gateway.ResourceResponse`。内部开一条 STREAM_RESOURCE_REQUEST，写完 close
- **反代 HTTP buffered**：用 `gateway.SendHTTPRequest(ctx, clusterID, &gateway.HTTPRequest{...})`，返回 `*gateway.HTTPResponse`。body 直接当字节流写,无需 chunk —— yamux flow-control 兜底
- **反代 HTTP streaming**（SSE / 推理 token 流 / 日志逐行）：用 `gateway.SendHTTPRequestStream(ctx, clusterID, ...)` 拿 `*HTTPStream`，`Body` 是直接挂在 yamux Stream 上的 `io.Reader`；**MUST `defer stream.Close()`**（FIN 触发 worker 端 cancel-watcher,中断 upstream HTTP request）
- **流式会话**（Pod 日志 / exec / 反代 WebSocket）：用 `gateway.OpenLogsStream` / `OpenExecStream` / `OpenWSStream` 拿对应 typed wrapper（`LogsStream` / `ExecStream` / `WSStream`），`Send*` 写、`Recv()` 读、`Close()` 关
- **取消语义**：caller 端 `stream.Close()` = yamux FIN → worker 端 cancel-watcher goroutine 的 `Read` 返回 EOF → 触发 `cancel()` → K8s ctx 撤销。**FIN 不是 RST,server 端在 request 写完后绝对不能立刻 CloseWrite** —— 那会让 worker 误判为立刻取消。详见 [docs/transport-v2.md 第 16 节](docs/transport-v2.md#16-上线后修订2026-05)
- **新加 streaming endpoint 时**：(1) 在 `proto/v2/pilot.proto` 加 StreamKind 枚举值 + 必要消息类型 (2) 在 `gateway/stream.go` 加 typed opener (3) 在 worker 对应 manager 加 `HandleStream(ctx, *transportv2.Stream)` 入口 (4) **在 `tunnel/client.go` Handlers struct 注册 + main.go 接线** (5) worker handler 第一件事:派 cancel-watcher 1-byte Read goroutine + `defer cancel()`
- **Worker 断开时**：yamux session close 会让所有 in-flight stream Read/Write 立即返错 —— gateway 不需要手动 cleanup（v1 那套 `closeClusterStreams` / `rxAsm.reset()` 全删了）
- **一条 stream 多消息类型**用 0-payload 哨兵帧切换（LogsChunk vs LogsEnd 等），完整契约 grep `Sentinel discriminator (Worker contract)`。新增时遵守此约定，不要为每对消息单独造 oneof

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
- `gateway` 是 yamux 接入层 + Worker 会话注册中心；HTTP handler 通过它发请求/开 stream，永远不要直连 Worker
- `proxy`（worker 端）所有 K8s 操作都走 controller-runtime / client-go 构建的 cfg，不要在 handler 层重新构造
- `pkg/transport/yamux` 是协议无关传输层（Session + Codec + Stream wrapper）,不依赖任何 KPilot 业务类型 —— 想换底层 transport（quic / mux 等）只需替换这个包

### Proto 改动
1. 改 `proto/v2/pilot.proto`
2. 跑 `bash hack/gen-proto.sh` 重新生成 `pkg/common/proto/v2/*.pb.go`
3. 生成的文件**不手动编辑**

新增 StreamKind 变体时同步更新：
- `pkg/common/proto/v2/pilot.proto` 的 `StreamKind` enum + 必要 message 类型
- server 端 `pkg/server/gateway/` 加 typed Send/Open helper（参考 `send.go` 的 SendResourceRequest 或 `stream.go` 的 OpenLogsStream）
- worker 端 `pkg/worker/{proxy,plugin}/` 加对应 `HandleStream(ctx, *transportv2.Stream)` 入口
- `pkg/worker/tunnel/client.go` 的 `Handlers` struct + worker dispatchInboundStream / server `yamux_accept.go::dispatchInboundStream`（看是谁主动开 stream）
- `cmd/{server,worker}/main.go` 接线（worker `SetHandlers({On...})`）
- 哨兵帧契约（如果一条 stream 上多消息类型）→ 更新 `pkg/server/gateway/stream.go` package doc

> K8s 资源代理（Worker 端）的写动作语义、Describe fallback、RESTMapper 缓存等细节见 [docs/clusters.md](docs/clusters.md) 的「K8s 资源代理」一节。
> 写操作 protection 的设计取舍（为何下放给 K8s RBAC、原 `pkg/server/protect/` 7 类规则为何撤掉）见 [docs/clusters.md](docs/clusters.md) 的「写操作 protection」一节。

---

## 前端开发规范（web/）

### 技术栈
- UmiJS Max v4（`@umijs/max`）
- antd v6 + `@ant-design/pro-components` v3
- Tailwind v4（布局）+ `antd-style`（CSS-in-JS，需要主题 token 时）
- 国际化：zh-CN / en-US

### 5 平台路由结构

| 路径 | 名称 | 说明 |
|---|---|---|
| `/clusters` | 集群管理 | landing = 集群列表；进入集群后 `/clusters/:id/...` 注入 K8s 子菜单 |
| `/compute` | 算力调度 | landing = 集群 picker；进入集群后 `/compute/:id/scheduler` 是首屏，sider 注入「调度策略」+「调度资源」(Queue/Job/CronJob/PodGroup/HyperNode) |
| `/models` | 模型服务 | 三个对等子菜单页（菜单形式对齐集群管理 / 算力调度）：`/models/catalog` 模型仓库（卡片 catalog + CRUD + Deploy drawer）/ `/models/deployments` 模型实例（跨模型 + 跨集群 ProTable）/ `/models/chat` 模型调试 playground。`/models` 默认 redirect 到 `/models/catalog`。三页统一 `breadcrumbRender={false}` 隐藏面包屑（菜单本身是平的） |
| `/plugins` | 插件管理 | 全局 Helm 插件注册表 |
| `/system` | 系统管理 | KPilot 控制面自身的运维区。子菜单结构(模仿 `/models`)：`/system/monitor` 系统监控(节点表 + 详情页 + pprof,数据走 PG `system_snapshots` 表 + 15s 后台 poller,不依赖 VM/Grafana);`/system/logs` 系统日志(占位页,后续接入 server/worker 日志查询)。`/system` 默认重定向到 `/system/monitor`。详情页 `/system/monitor/:node` 通过 `hideInMenu` 隐藏不在 sider 显示。**放在 sider 最右**——定位是诊断 / 运维区,不是日常主流程入口 |

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

> 5 平台子菜单注入 / `extractClusterId` / ProLayout 配置等动态导航细节见 [docs/clusters.md](docs/clusters.md) 的「集群详情导航」一节。

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
| P12 | P11 收尾打磨。**vGPU 页**：完整重构 —— KPI 三个利用率（slots / memory / cores）改用 `Progress.dashboard` 环形仪表盘（cores 客户端聚合自每张卡）；旧的"节点表 + 展开行 = 卡列表"改成 card-per-node 列表，每节点头部三段聚合 bar，节点下方逐张卡一行（身份 + 三 bar + Pods 占用），所有信息默认可见无展开；pod 名点击改打开 DescribeDrawer（不是 Logs）；UUID 尾截 `…hhhhhhhh`；搜索框 + 排序 + drilldown 到节点 / health banner / 空集群 CTA；UtilBar percent 模式去重（之前 80% 的条旁边还又渲染一遍 `80%` 文字）。**chart**：两个 ConfigMap 都放 release namespace（默认 `volcano-system`），device-config 依赖 binary 的 `kube-system → volcano-system` fallback 链，去掉之前错误的 kube-system pin；display_name 缩 "Volcano vGPU"；description 修到 varchar(500) 内。**架构**：删除 `pkg/server/protect/`（写保护全部归还给 K8s RBAC + controller）。**schedulerMeta**：`arguments` 加入已知 top-level key。**Volcano 内置 chart**：默认 scheduler.conf 已带 `deviceshare` 插件 + `VGPUEnable: true`（新装即用）；默认 release namespace 改成 `volcano-system`。**Job/CronJob/Queue 表单**：原生 vGPU 三件套字段（number / memory / cores）；JobForm 编辑时 Alert 提示 webhook 三字段限制 + submit-time diff 拦截。**Overview / Scheduler**：Volcano 检测 cluster-side（worker 探 Queue CRD + ConfigMap field-selector），不再依赖 kpilot 插件注册表；Overview list fetch 走 `Promise.allSettled` 容忍可选 sub-CRD 缺失。**plugin install log**：修 10 分钟 buffer TTL 内重新 enable 旧 end 帧误关 WS 的 bug。**hack/**：`aliyun-gpu.sh` → `remote-k3s.sh` 改名 + 跨平台 tunnel pid 跟踪 + SSH multiplex；Tencent/GCP/EC2 镜像 root 密码 SSH 禁用时自动通过 ubuntu/centos/ec2-user/admin 用同密码登录 + sudo bootstrap pubkey 到 root；GPU 节点缺 NVIDIA Container Toolkit 时自动 apt 装上。 | ✅ 完成 |
| P13 | GPU 物理卡监控：NVIDIA DCGM Exporter 内置插件（repo chart 4.8.2，sort_order 27，DaemonSet 暴露 `:9400` Prometheus 指标）。**首版用 Grafana iframe 嵌 dashboard 12239，后修订为完全自绘**：新增 server-side `pkg/server/api/handler/gpu_metrics.go::GetGPUMetrics` 通过 `gw.SendHTTPRequest` 并发跑 6 条 PromQL（util/temp/power/fbUsed/fbTotal/SM/tensor），server 预算 snapshot；前端 `pages/Compute/Volcano/GPUMonitoring.tsx` 用 `@ant-design/plots` Line + Progress.dashboard 渲染 KPI 卡 + 6 张多线时序图，required 改成 `victoria-metrics + dcgm-exporter`（**不再依赖 grafana**）。删除 `pkg/server/dashboards/builtin/nvidia-dcgm.json` + `embed.go` 里的注册条目。Grafana 嵌入只留给「集群管理」的通用监控 / 日志页。算力调度 = 专用形态，集群管理 = 通用形态。**T4 实测发现的修复**：(1) **`fbTotal` PromQL** —— DCGM 不发 `DCGM_FI_DEV_FB_TOTAL`，老写法常驻 0 让 `fbUsagePct = NaN`；改 `sum by (Hostname,gpu,UUID,modelName)(DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE)` 直接物理上限。(2) **KPI 卡 4→6**：把显存占用从「总功耗 + 显存」混合卡里拆出独立卡（`Progress.dashboard format` slot 内嵌 `used/totalG` 绝对值，避免外挂 Text 撑高 16px 破对齐），新增 **Tensor 活跃率**（`DCGM_FI_PROF_PIPE_TENSOR_ACTIVE`，LLM/视觉训练才看；Volta+ 才发，老卡常驻 0）。(3) **KpiTile helper**：抽共享布局 —— 文本侧 `flex:1 + min-width:0` 占满剩余宽度，标题/数值 `whiteSpace:nowrap` 防一字一行折行；环侧 `flex-shrink:0` 防 56px 被挤；卡高 `<Card style.height:100%>` + `<Row align="stretch">`。**Col 断点** `xs/sm/md/lg/xl/xxl = 1/2/2/3/4/6`，6-per-row 仅 ≥1600px 才放（老版 `lg={4}` 让 992–1280px 屏一行塞 6 张卡，每卡 ~200px 把「平均利用率」打成 `平/均/利/用/率` 单字纵排） | ✅ 完成 |
| P14 | 资源治理三件套 + 集群管理可观测性重写 + Grafana 反代硬化。**共享层**：抽 `pkg/server/api/handler/vm_query.go`（`resolveVMQueryURL` 通过 plugin DB lookup 拿 VictoriaMetrics Service FQDN + `queryVM` instant + `queryVMRange` matrix + `urlQueryEscape`），DeviceHealth / GPUHour / GPUMetrics 三 handler 共用；同源端 `vm_cache.go` 4s TTL response cache 跨所有 VM-backed endpoint 共用。**队列配额**（`/queue-quota`）：`queueRow` 加 `Priority` / `Guarantee`（unwrap `spec.guarantee.resource`）/ `Deserved` 三字段；前端缩进树形 Queue Select（默认选 `root`）+ 主卡片 + 子 Queue 递归卡片；每资源行纯 CSS 自绘三 tick bar（capability=track / allocated=填充 / guarantee=绿色竖线 / deserved=紫色竖线），未设上限走斜纹空轨道 + 超限 / 未达保障 Alert。**GPU 告警**（`/device-health`）：4 条 PromQL 并发（XID / 30min ECC increase / 温度 ≥85 / FB ≥95%）走 worker tunnel，单 query 失败仅 log 跳过；server 预算 severity counts，**alert 句子全部前端 i18n**（zh-CN / en-US 双套 message 模板，server 只下发 `kind` + `value`）。单一 ProTable（空数据走 `locale.emptyText`），RefreshControl 在 `toolBarRender`。**GPU-Hour 用量**（`/gpu-hour`）：`avg_over_time((DCGM_FI_DEV_GPU_UTIL/100)[range:step])` × 窗口小时 = GPU-Hour 数（step 1h→1m / 24h→5m / 7d/30d→15m），server 按 hours 倒序返回 + total；前端 Radio.Group range picker + 双 Statistic 卡 + ProTable + share `<Progress>` 占比；30d 多挂 retention warning。v1 仅按 (Hostname, gpu) 聚合，Queue / Namespace 细分留作后续（需要 worker 周期性 Volcano 分配快照持久化）。**worker 端 in-cluster Service URL 路由**：`*.svc.*` 自动改走 K8s API server 的 service-proxy 端点（`/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/<path>`），生产部署 + 本地调试都通，HTTP / WS 共用 `InClusterRouter` 24h TTL 决策缓存。**`/clusters/:id/monitoring` 改自绘**：删 Grafana iframe + 内置 dashboard 依赖，新增 4 个后端端点（cluster-metrics / node-metrics / pod-metrics / pod-health），多层 KPI / 节点趋势 / Pod top-N / Pod 健康表，覆盖 cluster CPU/mem/Pods+Pending、node CPU/mem/disk%/disk I/O+IOPS/net/loadPerCore/netErrors/inode/tcpRetrans、pod CPU/mem/netRx/netTx/cpuThrottle/fsRead/fsWrite/memLimitRatio。Pod 段本地 namespace picker（不连全局 `useModel('namespace')`，每次进页面默认全部 ns），pod 名搜索只匹配 pod 部分。**`/clusters/:id/logging` 改自绘**：删 Grafana iframe，自绘 LogsQL 搜索 + 直方图，留空 query 后端默认转 `*` = 全部日志；namespace + pod 下拉选择器自动构造 stream selector 回填到输入框（用 `kubernetes.pod_namespace` / `kubernetes.pod_name` 字段名，Pod 列表从 `/workloads/pods` Table API shape 解析 `rows[].object.metadata.name`）。**`/clusters/:id/grafana` 独立 escape hatch**：剥离原 monitoring/logging 的 iframe，定位 power user。**Grafana 反代两个 service-proxy fallback bug**：(1) `rest.RESTClient.Do().Raw()` 只返 status+body 吞 header 改用 `rest.HTTPClientFor` + 手动 http.Request；(2) K8s apiserver text/html 响应 body URL 改写无法关停（写死的 PathPrepend 逻辑），worker 收响应后 `bytes.ReplaceAll` 反向擦掉前缀。**Grafana 角色 fix**：seed.go 加 `auth.proxy.headers: "Role:X-WEBAUTH-ROLE"`（缺它 Grafana 静默忽略 X-WEBAUTH-ROLE 头）+ `auto_assign_org_role: Viewer→Admin`，老 Viewer 账号下次请求就被升 Admin。**收尾打磨**：所有 VM-backed 页（监控 / 日志 / GPU 监控）抽 `<TimeRangePicker>` 共享组件 —— 预设按钮 + antd RangePicker `showTime` 绝对范围；后端 `time_range.go::resolveTimeRange` 统一 `?range=` 或 `?from=&to=`，custom range 31 天 cap，step 按 duration 自动；日志 `limit` cap 1000→10000（VL 本身无硬上限）；超时按场景分级（VL search 30s→5min、VM 15s→60s、proxy 60s→5min）。**日志页 UX 重构**：full-bleed flex 布局（ResizeObserver 闭式公式 `viewport - wrapperTop - footerHeight - gap` 解决外层滚动条；Footer 组件加 `kpilot-footer` className 给 ResizeObserver 定位用）+ react-virtuoso 虚拟列表（10k 行 DOM 恒定）+ 大屏模式（Esc 退出）+ TXT/NDJSON 导出（纯客户端 Blob 下载）。**跨境 worker HA 加固**：跨境 server↔worker 链路实测有效带宽只有 ~20 KB/s,旧的单 FIFO slow lane + 无压缩导致大日志查询(20 MiB 响应)在 5min ctx 内根本下不完,且其他并发请求被 head-of-line block 2 分钟全部 504。一次性补四块:(1) **gRPC stream-level gzip 压缩**(两端 blank import `encoding/gzip` 注册 codec + worker `UseCompressor` + server `SetSendCompressor`),JSON 响应 wire 体积 1/5–1/8;(2) **prioritySender slow lane 改 per-request_id round-robin** 公平调度,小请求不再等大请求 chunk drain;(3) **`/logs/search` 与 `/logs/histogram` 改 SSE**(`pkg/server/api/handler/sse.go` 共享 helper,25s `progress` 心跳事件 + 终态 `result` / `error` 事件,前端 `services/kpilot/logs.ts` 用 EventSource 包成 Promise),穿透 Sealos/nginx-ingress ~60–300s idle timeout;(4) 新增 `GET /api/v1/clusters/:id/debug/tunnel-bench?bytes=N` 跨境带宽自测端点(worker 用 `crypto/rand` 回吐 N 字节真随机,server 计时算 kbps)。叠加效果:`limit=10000` 日志查询从 17min 超时变 3–4min 完成,且不阻塞并发请求。**T4 实测发现的收尾**：(1) **集群上限 fallback**：Queue 未设 `spec.capability` 时整版面显示「未设上限 / 0%」很丑且无信息量。`ListVolcanoQueues` 并发 List Nodes、用 `resource.Quantity.Add()` 聚合 `node.status.allocatable` → 响应顶层挂 `clusterAllocatable map[string]string`，前端在 ClusterCapacityCard / QueueHierarchyCard / 队列配额 ResourceQuotaRow 三处统一 fallback 到集群可分配量当分母，配「集群上限 X」label + 「物理」Tag。(2) **`parseQuantity` SI 小写 `k`**：早期前端 helper 只认大写 `K`/`Ki`，集群上限走 `12k` 时被解析成 0；补齐 SI 全套（`k`/`M`/`G`/`T`/`P`/`E` 二进制 `Ki`/`Mi`/`Gi`/...），与 `resource.ParseQuantity` 对齐。(3) **队列配额子 Queue 递归 `<SubqueueTree>`**：默认全部折叠（antd `Collapse`），header 显示子 Queue 名 + `(N)` 后代总数；老 flat 列表在深层多孩子集群（HPC）一屏几十张卡找不到东西。(4) **三 tick bar 填充色按 usageBand**：复用 `shared/utils.ts::usageColor`（≥85% 红 / ≥60% 橙 / 其余绿）取代平铺蓝色，与 Overview / GPU 监控 KPI 仪表配色统一。(5) **Overview 队列层级树拿到 GPU 轴**：每个 Queue 节点显示 CPU / memory / **GPU**（自动探 vGPU 模式：`volcano.sh/vgpu-memory` 走 vGPU 显存轴、否则 `nvidia.com/gpu` 整卡数）+ 数字 chip；同时**删除 `QueueResourceCard`** 扁平表格（~316 行，与 hierarchy 表达同一数据），布局收敛为 ClusterCapacityCard → QueueHierarchyCard 全宽 → 其它行。**日志页真流式升级**：`/logs/search` 从"包 SSE 外壳的全缓冲"改成端到端逐行流式 —— 新 `handler/vmlogs_stream.go::streamVMLogs` 走 `gw.SendHTTPRequestStream`（见 P16）接 VL `/select/logsql/query` 的 NDJSON 响应,worker 边读 32 KiB chunk 边发,server 端 accumulator 按 `\n` 切完整行(跨 chunk 边界半截行留 buffer + 单行 1 MiB cap 防异常长 stack trace 打爆内存),投影后立刻 `sse.send("line", ...)` 流出。SSE 协议升级到 5 事件:`meta`(首发参数 echo)/ `progress`(25s 心跳)/ `line`(每条日志)/ `result`(终态总结 total/truncated/elapsedMs/endErr,**不含 lines[]**)/ `error`(dispatch 失败)。前端 `services/kpilot/logs.ts::streamLogsSearch` 用 EventSource 解析 + **按 50ms / 100 行 batch onLine**(直接 per-line setState 会打爆 React + virtuoso),搜索时 Search 按钮变 Stop(AbortController → EventSource.close),已加载行保留;结果计数 loading 时显示 `已加载 N 条 · Xs`(elapsedMs from progress),完成后变 `N 条`。limit cap **10000 → 50000**(流式 + virtuoso + Stop 兜底,不再怕大查询拖卡浏览器)。`queryVMLogs`(旧 buffered 函数)随之删除。继承 P16 streaming 底座所有健壮性:per-request_id 公平调度不 HOL block 其它请求 / `stream.Close()` defer 严格保证 / `closeWorkerHTTPStreams` 按 cluster scope / HTTPCancel 帧主动撤销 upstream。 | ✅ 完成 |
| P15 | 模型服务 → 模型仓库：全局 `Model` 表（store/models.go::Model + store/model.go CRUD + store/seed_models.go 12 条 2026-05 主流内置预设：Qwen3-0.6B-Instruct（冒烟测试用，1.6 GB VRAM 任意 GPU）、Qwen3-8B/14B/32B-Instruct、Qwen3-30B-A3B-Instruct (MoE)、DeepSeek-R1、Llama-4-Scout-17B-16E-Instruct (MoE)、Mistral-Small-3.2-24B-Instruct、Phi-4、GLM-5.1、Gemma-4-31B、Kimi-K2.6，统一 pin vLLM `v0.20.2` 镜像；选型据 HF trending 2026 H1 / Artificial Analysis Intelligence Index 交叉验证）+ ModelFamily 枚举扩到 9 个（追加 `phi` / `gemma` / `kimi`）+ REST CRUD（`/api/v1/models`，handler/model.go，内置 PATCH/DELETE 返回 403 `MODEL_BUILTIN_LOCKED`，name 强 DNS-1035 label 校验（Service 形式比 Deployment 严，必须字母开头 + 不含点）便于 P16 直接用作 Service / Deployment name）。**前端**：`ModelHub/index.tsx` 家族分组卡片 catalog（Collapse 按家族分 section，搜索 + License / Runtime 过滤，order 固定 built-ins → sort_order → name）+ `ModelCard.tsx`（每张卡 HF org logo 头像 + 内置 tag + 4 行截断描述 + runtime/GPU/license badges + Deploy 主按钮 + 复制为自定义 / 编辑 / 删除）+ `ModelDetailDrawer.tsx`（卡片点击 → 只读详情，复用 workloads `YamlEditor` 渲染 default_args 列表）+ `ModelDrawer.tsx`（新建 / 编辑 / **复制为自定义** 三种 mode；recommended_gpu 拆 3 字段：count / memoryGiB / model Select；default_args **每行一个 flag** 跟 DeployDrawer 统一）。`FAMILY_META`（label / 品牌色 / HF avatar URL）+ `RUNTIME_LABELS` + `RUNTIME_DEFAULTS`（image + defaultArgs per runtime，runtime 切换自动 swap）在 services/kpilot/model.ts 集中维护。抽 `pages.common.*` 共享 i18n 键（edit / delete / copy / copied / saved / identity / runtime / tuning / loading）。所有 background / text / border 走 `theme.useToken()` 适配暗色模式。docs/models.md 重写覆盖 schema / API / 内置预设 / FE 三段 | ✅ 完成 |
| P16 | 模型服务 → 推理路径完整落地。<br/>**一、推理部署生成器**：`pkg/server/deploy` 从 store.Model + DeployOptions 拼出 Deployment + Service + 可选 PVC + 可选 HF Secret → 通过 worker tunnel apply 推到目标集群。**Model row = 模板**，同一模型可独立部署到多集群、同集群可多 instance（`{model.name}` 单实例 / `{model.name}-{instance}` 命名变体）；重复部署到同名 = SSA update。**Stateless 设计**：部署状态不进 DB，所有 manifests 打 KPilot 标签集（`app.kubernetes.io/managed-by=kpilot` + `kpilot.io/model-id` + `kpilot.io/model-family` 等），cluster 是 source of truth。GPU plumbing 二选一：`nvidia.com/gpu`（默认）或 `volcano.sh/vgpu-number`（需 volcano-vgpu-device-plugin）。HF token 落 Secret + envFrom 注入容器。PVC 默认开（heuristic 按模型名预估大小：0.6B→5G / 32B→100G / R1→1.4T）。**容器 resources 三层叠加**：① cpu/memory request+limit 可不同（burst headroom，`resource.ParseQuantity` 校验）② GPU count `limits` only（device-plugin extended resource 强制 requests==limits）③ Volcano vGPU 子资源（`vgpu-memory` MiB + `vgpu-cores` 0-100%）limit-only，**仅 `gpu_type=volcano` 时下发**。dshm tmpfs 2 GiB 兜底 NCCL，readiness probe 5min failureThreshold 等 HF 冷下载。前端 `ModelHub/DeployDrawer.tsx` 三 tab（配置 / YAML 预览 dry_run / 部署结果），Deploy 按钮 `Form.useWatch` 监听必填字段；HF Token 放表单底部 + `autoComplete=new-password` 防浏览器误填。`POST /api/v1/models/:id/deploy?dry_run=true` 走预览路径。<br/>**二、模型实例 + chat 调试**：协议层 `ResourceRequestStart` 加 `label_selector` 字段，worker `proxy.listFull` / `listTable` forward 到 `ListOptions.LabelSelector`。`/models` 改成三个对等子菜单页（catalog / deployments / chat）。**部署实例端点** `GET /api/v1/models/deployments[?model_id=N]`：handler 启动时一次性 `store.ListModels` 装 `modelsByID` map 避免 N+1，遍历 `store.ListClusters()` 跳过 offline worker，每集群 goroutine 8s ctx + `list-full apps/v1 Deployment` + selector；每行 enrich `ModelDisplayName / Family / Runtime / ModelField`（catalog 行被删的孤立 deployment 保留显示 + 前端「孤立」Tag）；status 服务端预算 Running/Progressing/Failed；partial-fail 落 `errors[]`。**Chat 反代** `Any /api/v1/clusters/:id/inference/:namespace/:name/*subpath` → 转发 `http://<name>.<ns>.svc.<cluster-domain>:8000/v1<subpath>`，端口硬编码 8000 防被改造成通用集群内 HTTP 代理；仅转发 Content-Type + Accept，KPilot session cookie 全剥掉。前端 ModelDeployments 单 ProTable + family quick-filter `<Tag.CheckableTag>` + per-row 调试/Describe/Delete；ModelChat 双列 Card `Row align=stretch + flex:1` 等高，URL 驱动 `?cluster=&ns=&name=`；request `model` 字段用 server 下发的 `instance.model_field`（= `HuggingFaceID \|\| deployment.name`）严格匹配 vLLM `--model` 启动值（否则 404 `does not exist`）。<br/>**三、OpenAI 兼容反代 endpoint + 真 SSE 流式底座**：`HTTPRequestStart` 加 `bool stream_response = 4`（向后兼容），worker `proxy/http.go::handleStreaming` stream=true 时 32 KiB 缓冲循环 Read → `SendHTTPResponseChunk` 边读边发，`tunnel/chunked.go` 拆出 `sendHTTPResponseStart/Chunk/End` 三个 incremental API。gateway 新增 `pkg/server/gateway/http_stream.go::HTTPStream{Status, Headers, Error, Chunks <-chan []byte, EndErr <-chan error, Close()}` + `SendHTTPRequestStream`，session 在 `g.httpStreams[requestID]` 注册，recv loop 在分发 HttpRespStart/BodyChunk/BodyEnd 时**优先 check streaming session 再 fall back 到 buffered rxAccumulator**；chunks channel buffer 32（2 MiB worst case），handler MUST defer `stream.Close()`；worker 断开时 `closeWorkerHTTPStreams` 按 cluster scope 兜底关 session（跨集群隔离）。**鉴权**：`store/api_key.go::APIKey{ID, Name, TokenHash(sha256), TokenPrefix, ClusterID, Namespace, DeployName, LastUsedAt(throttled 1/min), RevokedAt}`，Token 格式 `kp-sk-<24 byte crypto/rand base64url>` 一次性明文展示，sha256 入库。中间件 `middleware/bearer_api_key.go::BearerAPIKey` 提取 `Authorization: Bearer ...` → sha256 → `store.GetAPIKeyByHash` → RevokedAt 检查 + URL path scope 精确匹配 → 异步 `TouchAPIKeyLastUsed`（WHERE-clause throttle）。**对外 endpoint** `Any /api/v1/clusters/:id/proxy/inference/:namespace/:name/*subpath` 走 BearerAPIKey 中间件 → `handler/inference_proxy.go::ProxyInferenceOpenAI` → `SendHTTPRequestStream` → 共享 `writeStreamingResponse`（Status+Headers 透传 + 每 chunk `Flush()` + `X-Accel-Buffering: no` 头让 nginx-ingress 不 buffer SSE）。chat playground 同步切流式（`model_chat.go::ProxyInference` 共用 `writeStreamingResponse`，鉴权保持 cookie）。前端 `services/kpilot/model.ts::streamChatCompletions` 用 fetch + ReadableStream + TextDecoder（umi `request` 全缓冲不可用），按 `\n\n`/`\r\n\r\n` 切 SSE 事件，`data:` 行 JSON.parse `choices[0].delta.content` 触发 onDelta；`pages/ModelChat/index.tsx` 预分配 assistant 气泡固定 React key 避 remount 丢帧，Stop 按钮 AbortController.abort()。错误码 `API_KEY_NOT_FOUND/INVALID/MISSING/SCOPE_MISMATCH` 中英双套。<br/>**四、HTTPCancel 帧（主动取消）**：proto `ServerMessage.http_cancel = 62`（`HTTPCancelRequest{reason}`），worker `tunnel/client.go::httpCancelers map[string]func()` 注册表 + `RegisterHTTPCancel/DeregisterHTTPCancel/cancelHTTPRequest`，`proxy/http.go::handleStreaming` 进入时注册 ctx cancel + defer 注销，recv loop dispatch HttpCancel → 查表 → 调 cancel → http.Request ctx 撤销 → upstream conn 立即断。server `gateway/http_stream.go::HTTPStream.Close()` 在清理本地 state 前 sendSlow `HttpCancel` 给 worker（best-effort，worker 已断时静默跳过）。前端 Stop / EventSource 关闭 → server `c.Request.Context().Done()` → defer `stream.Close()` → HttpCancel 帧 → worker 立即断 upstream，不再傻读到 5min 超时。同款机制覆盖 chat playground / OpenAI 兼容 endpoint / `/logs/search` 所有 streaming 路径。<br/>**五、APIKey 前端管理页** `/models/api-keys`（`pages/APIKeys/index.tsx`）：操作员 ProTable + Create Drawer 二级 picker（cluster Select → 该集群下的推理实例 Select，切 cluster 自动 clear deployment 防 scope 错配）+ 签发成功 Modal 一次性展示明文 token（`maskClosable=false` 防误关 + 复制按钮 + curl usage 示例）+ 撤销（软删，保留审计行）/ 删除（硬删）两个 row action；scope 列做 cluster id → name 反查（mount 时 fetch clusters 不靠 drawer 打开才有，首屏不显示 UUID）。<br/>**T4 实测验证**：腾讯云 Tesla T4 单卡节点（k3s + nvidia-container-toolkit + drop-in `50-nvidia-default.toml` 把 `default_runtime_name=nvidia`）跑通 Qwen3-0.6B 全链路 —— UI 一键部署 → Pod Running → `/v1/chat/completions` 实际返回带 thinking 模式的 Qwen3 输出。 | ✅ 完成 |
| P17 | **P-Transport-v2：server↔worker 通信层从 bidi gRPC 迁移到 hashicorp/yamux**（设计文档 [docs/transport-v2.md](docs/transport-v2.md)）。**触发**：`/logs/search` Stop 级联卡死(commit 6d293c24) + 跨境 20 KB/s 链路上单 FIFO slow lane HOL 阻塞 + 15+ 项手搓的"HTTP/2 多流等价物"(prioritySender / chunked transport / HttpCancel 帧 / rxAccumulator / 公平 round-robin / stream-level gzip / KeepAlive PING 剥离应用心跳)代价过高,本质上"把单 gRPC bidi stream 当多路复用器用"是错的。**方案**：每个 RPC / 流式会话开一条独立的 yamux stream(yamux 内置 per-stream flow-control + 公平调度 + cancel(FIN) + 自动 KeepAlive PING),应用层不再做。**分 5 阶段单 PR 完成**(phase A 传输底座 + benchmarks / phase B server gateway 改写 / phase C worker 业务层 HandleStream 化 / phase D 删 v1 proto + 全量切换 / phase E integration tests + cancel 语义打磨)。**proto v2 schema**：`pkg/common/proto/v2/pilot.proto`,删了 WorkerMessage/ServerMessage oneof 包装 + BodyChunk/BodyEnd 对 + *CancelRequest 帧 + Heartbeat,改 `StreamHeader{Kind, RequestID, Gzip}` 第一帧定流类型 + StreamKind enum 9 个值。**`pkg/transport/yamux/`**：协议无关传输层 ~650 LOC,Codec(length-prefix protobuf + lazy gzip,延迟初始化 reader 避开 net.Pipe 双向 EnableGzip 死锁) + Session + Stream wrapper + ReadRaw("try multiple proto types on same bytes",ExecStdin/Resize 用),10 个 bench(M1 loopback RPC 79–82µs / HOL 188–209µs / Cancel 15–17µs / 每流 ~10 KB 内存) + 9 个单测。**server `pkg/server/gateway/`** 629→175 LOC: ConnectedWorker 只持有 Session,yamux_accept.go AcceptYamux + STREAM_REGISTER 握手 + dispatchInboundStream(worker 主动开的 PLUGIN_STATUS_PUSH / PLUGIN_LOG_PUSH),send.go SendResourceRequest/SendHTTPRequest 同步 helper,http_stream.go HTTPStream(Body 直接是 yamux Stream 的 io.Reader 不再有 chunks channel),stream.go OpenLogsStream/OpenExecStream/OpenWSStream typed openers + 哨兵帧契约 package doc(LogsChunk / ExecOutput / WSFrame / PluginLogChunk 四处统一文档化),plugin.go SendPluginCommand 60s ack 超时 + replayPendingPluginCommands,types.go HTTPRequest/Response 用 `*pbv2.HTTPHeader` 直接。**worker `pkg/worker/tunnel/`** 1000→340 LOC: TLS+yamux dial + STREAM_REGISTER 握手 + Handlers struct(OnResource/OnHTTP/OnPlugin/OnLogs/OnExec/OnWS)+ push helpers(PushPluginStatus/PushPluginLogLine/PushPluginLogEnd 主动开 stream 上报),types.go PluginCommand/PluginSpec/ChartSource 业务类型。**worker `pkg/worker/proxy/` 全部转 HandleStream 模式**: Proxy.HandleStream / HTTPProxy.HandleStream(buffered + handleStreamingResp 两 mode)/ LogsManager.HandleStream(LogsChunk 哨兵 0-payload + LogsEnd)/ ExecManager.HandleStream(ReadRaw + try-both-types 区分 ExecStdin/Resize)/ WSManager.HandleStream(reader/writer pump 双向桥)/ types.go 本地 HTTPRequest。**`pkg/worker/plugin/stream.go`** NEW: plugin.HandleStream(mgr, cache) 从 main.go 拆出来,持久化 blob 到 cache **BEFORE** ack,ack 写失败时直接 bail(防 duplicate Helm 安装风险)。**清理**: 删 pkg/common/proto/pilot.pb.go (3460 LOC) + pilot_grpc.pb.go (140 LOC) + proto/pilot.proto (425 LOC) + pkg/server/gateway/wire.go,加 go mod tidy/vendor 剥掉 grpc-go/x/net/trace 共 39k LOC vendored 代码,**净删 4000+ 行**(超出原估算 1700)。**整 5 阶段过程发现/修复多个 bug**: (A) TestCodecRoundtripGzip 死锁 = 双 EnableGzip 同步 net.Pipe 时 gzip.NewReader 阻塞读 header 等不到对端 Flush → 改 lazy reader init,writer 渴望初始化 + Flush header / reader 延到首 ReadMsg。(A) Stream.CloseWrite 死代码 = yamux v0.1.2 无 CloseWrite,fallback type-assert 写错 → raw.Close()即 FIN。(B) 3 bug: replayPendingPluginCommands 没接入 / Send* 不 watch ctx.Done / SendPluginCommand 阻塞 10min → 加 acceptYamuxRegister 接 replay goroutine + watchCtx helper + 改 fire-and-forget 60s ack。(C) 3 bug: makePluginHandler 在 main.go(应在 plugin 包)/ ack 在 blob 落盘前(假承诺)/ 重启时已 ack 但未落盘命令重复执行 → 移到 pkg/worker/plugin/stream.go + cache.Put 在 ack 之前 + ack 写失败 bail。(D) sed 留双 pbv2 import / 8 处 stale "gRPC tunnel"/"BodyChunk"/"HttpCancel frame" 注释清理。**(E) 关键 bug**: integration test TestIntegrationStreamCancelPropagates 打穿 phase C 的设计假设 —— **yamux Stream.Close 是 FIN 不是 RST,半关后 peer 还能写,phase C 假设的"close → 对端 Read EOF → 解释为 cancel"在 server 也 CloseWrite 时(如 SendHTTPRequestStream)被立刻误触发,response 还没开始就被撤了**。修复: server 端 SendHTTPRequestStream / OpenLogsStream 都不再 CloseWrite(留 FIN 给真取消用)+ worker 端 HTTPProxy.handleStreamingResp / LogsManager.HandleStream / ExecManager.HandleStream reader goroutine / WSManager.HandleStream reader pump 全部派 cancel-watcher 1-byte Read goroutine,EOF = cancel → 触发 sessCtx 撤销 / upstream HTTP ctx 撤销 / SPDY exec ctx 撤销 / WS conn.Close。同时发现 WS pre-existing 反向 bug(upstream 先关时 writer pump 退出但 reader 卡在 yamux ReadMsg,wg.Wait 死锁): 补 writer pump 退出后 st.Close 让两端互通(idempotent)。**5 个 integration tests**(`pkg/server/gateway/integration_test.go`,net.Pipe yamux pair fake worker): RPCRoundtrip / StreamCancelPropagates(打穿设计的就是这个)/ ConcurrentRPCs(100 并发隔离)/ LargeResponse(4 MiB 跨 flow-control window)/ DisconnectCleansSessions。`-race` 跑通无 leak。**T4 跨境实测**: latency 与 v1 持平(网络瓶颈),**取消时间从 ~5min(v1 lazy detection 等到 per-write deadline)降到 sub-second**。**核心收益不是性能,是把架构债一次性清掉** —— 以后新增 streaming endpoint 直接开新 stream + 加 cancel-watcher,不再需要手搓 transport 层补丁。 | ✅ 完成 |
| P18 | **可观测性 + 模型服务 + API 计量综合升级**。<br/>**一、监控页 v2**(`/clusters/:id/monitoring`):重写成 **Cluster / Node / Pod 三 tab** 结构 + 分组 LazySection(IntersectionObserver + chartReady gate + `usePollingRefresh`,只刷当前 tab + 已展开的 section);antd Tabs `destroyOnHidden=true` 让 chart 实例在 tab 切换时彻底 tear-down,绕开 G2 hidden-pane forceFit 污染。后端三个 metrics handler 加 `?groups=` filter(cluster: overview/capacity/workload;node: cpu/mem/disk/network/storage;pod: cpu/mem/network/io/throttle/memLimit),前端按 section 独立 fetch,4s server cache 把同步 fan-out 拍平。**Node 维度**新增 8 个 PromQL 指标(load1/5/15、memUsed、diskPartitions 按 mountpoint、tcpConns、diskIOWait/IOService/IOBusy 按 device),前端按节点 multi-select 全局筛选取代 per-section 文本框;后端额外 `listNodeIPMap()` 把 `instance="10.0.0.1:9100"` 翻译成 Kubernetes node 名字,所有 chart 统一显示节点名。**Cluster 维度** PromQL fix:`podsByPhase` 从 workload 组移到 overview(KPI 卡才能拿到 phase 计数,否则一直显示"KSM 未启用");`pendingPods` / `crashLooping` 把 `count(...gauge)` 改 `sum(...gauge)` —— `kube_pod_status_phase` 是 0/1 gauge,count 数的是 series 条数而非真实 Pending pod 数,fix 后跑测试集群里"15 个 Pending"幻象消失。**Pod 维度**:server 接 `?podSearch=` 推到 PromQL `pod=~"(?i).*<q>.*"`,topk 在 search 结果集里取,避免"搜的 pod 不在 top-N → 客户端 filter 后全空 → chart 空白";Pod Health 移到 tab 顶部(运维信号),内存 chart 单位 GiB→MiB。**Disk I/O**:节点磁盘 I/O wait/service time 单位 s→ms(`unitScale=1000`),读写 legend 用「读 / 写」中文标签代替 ↓↑ 箭头(磁盘没方向感)。chart 主标题 unit 为空时不渲染 `()`(避免"节点 Load Average（每核） ()"空括号)。<br/>**二、日志页 v2**(`/clusters/:id/logging`,11 项 UX 升级):**Live tail** 开关 — 每 2s 拉新行,新数据 prepend 到顶部(`kubectl logs -f` / `tail -f` 语义),上次 lastLineTime+1ms 为 exclusive lower bound 避免重复;Stop 兼停 manual 搜索。**直方图点击 zoom-in**:点 bar 自动把 range 改成 `{custom, from: bin.t, to: bin.t + step}` 并立即重 query(G2 `interval:click` 事件)。**行展开**:点击 log row 展开为 JSON pretty-print(message 是 JSON 时)+ 结构化 fields key/value 表;parse 只在 expanded 时跑 + useMemo cache 不浪费流式 append。**关键词高亮**:从 LogsQL 中剥 selector / field:value / 操作符后保留 word/phrase term,用 `<mark>` 包匹配文本。**Container picker**:pod 选定后 fetch `spec.containers + initContainers`,加第三级 Select,selector 自动补 `kubernetes.container_name="..."`。**URL 持久化**:mount 时读 `?q=&range=&from=&to=&sinceNow=&limit=&ns=&pod=&container=`,带查询参数自动 auto-run;submit 后 `history.replaceState` 同步,不污染 back 栈。**limit Select**:100/500/1k/5k/10k/50k 六档替代原 free-form Input(原 input 超 50k 静默拒绝)。**行级跳转**:pod tag 变 Dropdown(筛选此 Pod / 复制 Pod 名)。**LogsQL cheat-sheet popover**:搜索框 suffix ? 按钮,5 类 17 条示例(文本 / 流标签 / 结构化字段 / 逻辑 / 管道),点击插入 + 上游文档外链。**stdout/stderr + log-level 高亮**:stderr 仅作中性 Tag(Python logging / Go log / nginx 都默认 stderr,跟"错误"无关);红/橙高亮改用应用的 `level` / `severity` / `lvl` 字段(error/fatal/panic/crit 红、warn 橙)。**Picker merge**:新 `mergeStreamSelector` 只替换 query 头部 `{...}` 块,保留用户后续手写的 filter(不再无脑覆盖)。**Reset 按钮**:一键还原首次进页面状态(清 query / picker / lines / live tail / URL params)。<br/>**三、GPU 监控页加固**(`/compute/:id/gpu-monitoring`):**节点/GPU 多选筛选**(顶部 Select,filter 应用所有 chart + KPI snapshot 客户端重算)。**"需要关注的 GPU" 卡**:客户端从 series 算 idle(util=0 持续 ≥5/10 sample)/ hot(temp ≥85°C)/ OOM(FB ≥95%) 三组,健康集群自动隐藏。**chart 阈值线**:G2 lineY annotation,temp 80/90°C(warn/error)、tensor 5%(idle floor)。**chart 全屏**:per-chart expand 按钮,fixed 覆盖 viewport,Esc 退出。**机型分色**:backend 拉 DCGM `modelName` label,legend 显示 `host · GPU 0 [A100 80GB]` 区分异构集群。**fbUsed chart bug**:删除原写死的 36 GiB("90% of 40G")阈值线 —— 在 T4(16G)/H100(80G)集群完全错;KPI 卡的 fbUsagePct 已经按每张卡 used/(used+free) 算了。**抖动 root cause**:Select `maxTagCount="responsive"` 模式内部 RO 在 chip 变化 + page reflow 时反复测量,跟外层 flex layout 互相 reflow 触发循环。改 `maxTagCount={3}` + 固定 width 360 阻断 feedback loop。**chart wrapper hardening**:`annotations` useMemo + 删除导致首屏空白的 chartReady gate(此页不在 Tabs 里,G2 内置 autoFit 已经够用,gate 反而引入闪烁)。**toolbar layout**:range + filter + refresh 单行紧凑,带次要文字 label,窄屏自然 wrap。<br/>**四、GPU 告警 PromQL fix**(`device_health.go`):FB-near-full 告警的 `(DCGM_FI_DEV_FB_USED / DCGM_FI_DEV_FB_TOTAL) > 0.95` 永远不触发 —— DCGM exporter 4.x 不发 `FB_TOTAL`,divisor 一直是 NaN。改成 `FB_USED / (FB_USED + FB_FREE) > 0.95`(两个 metric 同 label,default vector matching 直接对位),100% 显存的 GPU 终于能进告警列表。<br/>**五、模型实例删除级联**(ModelDeployments):原来只删 Deployment,Service / PVC / Secret 留垃圾。改成 `Promise.allSettled([del(Deployment), del(Service), del(PVC=<name>-hf-cache), del(Secret=<name>-hf)])`,404 容错(没开持久化/没填 HF token 时这些资源根本没创建);非 404 错误聚合成 partial-failure toast。<br/>**六、模型调试页 UX**(ModelChat):每轮 assistant bubble 下方 inline footer **`X tok/s · Ys · prompt → completion (total)`**;wall-clock 从 send 时间起算,服务端 `completion_tokens` 算速率;**关键**:request body 加 `stream_options: { include_usage: true }`,否则 vLLM `stream=true` 不发最后的 usage chunk,onUsage 永不触发。**`<think></think>` 拆分**:DeepSeek-R1 / Qwen3 reasoning 的 chain-of-thought 自动 `splitThink()` 拆到独立 Collapse(default 跟随 stream — 推理中展开、`</think>` 出现自动收起;用户手动 toggle 后 `thinkOverride` 锁定不再被自动覆盖)。**Markdown 渲染**:assistant 消息用 `react-markdown + remark-gfm`(code block 自定义 tinted 背景、tables / lists / 删除线 / 任务列表 全套),user / system 保持 plain text。<br/>**七、APIKey 计量**:`store.APIKey` 加 `prompt_tokens` / `completion_tokens` / `request_count` / `usage_reset_at` 列(GORM AutoMigrate 拾起)。`inference_proxy.go` 加 `usageScanner` 双模(SSE 行扫 `data: {...}` 找 `usage`、JSON 全 body 解析,256 KiB cap)+ `io.TeeReader` side-channel sniff,响应路径无阻塞;handler 拿 `*usageBlock` 后 async `IncrementAPIKeyUsage(prompt, completion, 1)`(第三方 SDK 不设 `stream_options.include_usage` 时 token 列保持 0,但 `request_count` 还是会涨,operator 至少看得到调用频率)。新 endpoint `POST /api/v1/api-keys/:id/reset-usage`(操作员重置计量窗口)。前端 APIKeys 页加「用量」列(`12.3k → 4.5k = 16.8k tok` + `formatBigNumber` k/M/B 压缩)+「重置用量」per-row 操作(仅 request_count>0 时显示)+ tooltip 区分 lifetime vs since-reset。<br/>**八、跨页 scroll reset**:日志 / 模型调试 / GPU 监控页 mount 时遍历 ancestor 把 scrollTop 清零 + `window.scrollTo(0,0)` 兜底 —— 从其他可滚动页面切过来时,fixed-viewport 布局的 wrapper.top 用 `getBoundingClientRect()` 算高度,残留 scrollTop 会让 wrapper 出 viewport 之外。 | ✅ 完成 |
| P19 | **第 5 平台「系统管理」(`/system`):KPilot 自身 server + worker 进程的运行时观测 + pprof 抓取,完全脱离 VM/Grafana**。<br/>**架构演进**:迭代过两版 —— 起初 in-memory + per-node 1Hz WebSocket fan-out hub + browser ring buffer,优点零依赖但 server 重启即丢、N 个 browser 共享 hub 的并发模型复杂、跨标签共享一份数据但拿不到历史。后改成 **PG-backed pull 模式**:server 端 `diag.Poller` 每 15s 主动拉所有节点的 `/debug/snapshot` 写入 PG,handler 全部转为纯 DB reader,WS 整套删掉。收益:server 重启**保留 1 天历史**、worker 掉线后详情页仍能进(事后复盘)、单 writer per node 无并发问题、多 browser 看同节点不放大 polling。代价:数据延迟 15s(可接受,这是诊断不是 alerting)。<br/>**三层包,通用底座 + 业务 collector 分离**(future-proof 可拆库)。**`pkg/diag/`** 零业务依赖纯 stdlib + gopsutil v4(~400 LOC):`Diag.New(kind, name, version)` + `Register(Collector)` + `Snapshot()`,`Mount(mux, prefix)` 挂 `/info` + `/snapshot` + `/pprof/*`(stdlib `net/http/pprof`,显式注册 6 个 named profile + Cmdline/Profile/Symbol/Trace,不用 `pprof.Index` 因为它硬编码 `/debug/pprof/` 前缀);runtime/metrics 投影 50+ key(heap 各段 + GC pause p50/p90/p99 max + sched latency 分位 + CPU 各类 + mutex wait + alloc rate + live objects),`samples []metrics.Sample` 切片复用避免每次 5 KB 分配,histogram 用 live/prev delta tracker(5s gap 重置 baseline)。**进程级 RSS / open_fds / mem_total 走 gopsutil v4**(macOS / Linux / Windows 都能拿到);Linux 额外读 `/sys/fs/cgroup/memory.{max,limit_in_bytes}` 让 `mem_total_bytes` 反映容器 cgroup 限制不是宿主机物理内存。**`pkg/worker/diag/`**:TunnelCollector(connected/uptime/reconnect_total/streams_open,全 atomic)+ ProxyCollector(5 个 handler inflight atomic.Int32)+ RouterCollector(InClusterRouter hit/miss + hit_rate);`Serve(ctx, *diag.Diag)` bind 127.0.0.1:0 一个 `http.ServeMux`,返回端口号给 `tunnelClient.SetDiagPort` → STREAM_REGISTER 时上报给 server。**`pkg/server/diag/`**:`poller.go` 单 writer per node — 每 15s ticker + 启动时按 `store.ListClusters()` reconcile + 集群增删时上下线 ticker + jittered first poll(避免 50 节点同时刻 INSERT 风暴)+ janitor 每 15min `DELETE WHERE at < now() - 25h`(retention 1d + 1h buffer);**worker snapshot identity.name patch**: 写 DB 前 50 µs JSON in-place 改写 `identity.name = gw.GetWorker(nodeID).ClusterName`(worker 进程启动时不知道自己叫啥,fallback 用 `cfg.ServerAddr` 凑,patch 后详情页 / landing 显示真实集群名);`collectors.go` 业务 collector(YamuxCollector / DBCollector / HTTPCollector / InferenceCollector / CachesCollector)。**HTTPCollector 关键性能设计**:双 buffer live/prev 模式 + janitor 1s 旋转(`prev = live.Swap(0)`):hot path 每请求 5–7 个 atomic 操作(in_flight ± / total ± / liveReqs + / liveLat[bucket] +),**零 CAS 重试 / 零 mutex**;p50/p90/p99 算在 24 桶 power-of-2 latency histogram 上(1ms → 16s),Gin middleware 第一个 `r.Use()` 上,捕获所有请求。**InferenceCollector** 全局 atomic 计数,handler 直接 `diag.InferenceInflight.Add(1); defer Add(-1)` 埋点。<br/>**Proto v2 扩展**:`RegisterRequest` 加 `uint32 diag_port = 4`(向后兼容),worker `tunnel.Client.SetDiagPort(port)` 在 `Run()` 之前调;`gateway.ConnectedWorker` 加 `DiagPort uint32` 字段。<br/>**PG schema**:`system_snapshots(node_id varchar(64), at timestamptz, snapshot jsonb)`,**composite PK `(node_id, at)`** 无 synthetic id,indexes `(node_id, at DESC)` + `(at)`;`SystemSnapshotsRange` PG 端 `ROW_NUMBER() OVER (ORDER BY at) % step` 降采样到 ≤240 行 + 强制含最新点,`SystemSnapshotsSince` `ORDER BY at DESC LIMIT 240` 后客户端 reverse(保 newest)。<br/>**Server REST**(`pkg/server/api/handler/system.go`):4 个端点 `/api/v1/system/nodes`(列 server + worker)、`/snapshots`(纯 DB 读最新行)、`/:node/history?range=1h\|3h\|6h\|12h\|24h\|from=&to=\|since=`(三种 mode:预设范围 / 绝对范围 31 天 cap / 增量,前两种走 PG 降采样,since 模式不降采样给 live 1h 用)、`/:node/pprof/:kind`(走 yamux tunnel 实时反代 worker `/debug/pprof/*`,**不进 DB**,`profile`/`trace` 强制 `?confirm=true` 否则 403 `PPROF_CONFIRMATION_REQUIRED`)。原 `/:node/snapshot` + `/:node/stream` 已删(被 `?since=最新-1s` + batch endpoint 覆盖)。<br/>**Server startup**(`cmd/server/main.go`):起独立 `serveDiag` listener bind 127.0.0.1:0 挂 `pkg/diag` 端点 → `pollerInst := serverdiag.NewPoller(gw, diagPort)` → `pollerInst.Start(ctx)` 启动 reconcile + janitor goroutines。<br/>**菜单**:`/system` 顶级菜单 `系统管理`(icon=setting,位置 sider 最右)= hub,子菜单 `/system/monitor` 系统监控(icon=dashboard) + `/system/logs` 系统日志占位(icon=profile)。详情页 `/system/monitor/:node` `hideInMenu`。<br/>**前端**:landing `pages/System/index.tsx` = ProTable + **10s** `setInterval` polling `batchSystemSnapshots()`,列 节点(server 显示 `control-plane`,worker 显示真实 cluster_name)/ 状态(在线 / 离线 / 无指标)/ uptime / goroutines / **CPU 列**(`<Progress>` % + `usageColor` 红/橙/绿 + `pct · cores/N 核`;CPU% 需 prev+cur 两次 snapshot delta,首次 0%)/ **内存列**(`<Progress>` + `RSS / mem_total` + cgroup 感知)/ 业务 KPI(server:sessions/streams/RPS;worker:streams + inflight)/ 查看按钮(**离线也可点**,PG 有 1d 历史)。**手动刷新 button 已删**(10s 自动刷新覆盖)。详情页 `pages/System/Detail/index.tsx`:header subtitle 单行小字 `hostname · pid · app · go · goos/goarch · M/N procs`(从 `extra` 移到 body toolbar 让标题不挤);body toolbar `<TimeRangePicker>` 1h/3h/6h/12h/24h + 绝对范围(`TimeRangePicker` 扩展加 3h/6h/12h 预设)+ polling tag + pause button;8 KPI 卡 2 行×4 列(`Col lg={6}`,从 5 列改的);7-8 tab(概览/内存/调度/网络[server]/HTTP[server]/数据库[server]/集群代理[worker]/pprof),antd Tabs `destroyOnHidden` 避开 G2 hidden-pane 闪烁;**live 模式 = preset 1h** 15s `?since=` 增量追加新点 + `pushHistory`,其他范围切换 = 全量重 fetch + `replaceHistory`;`stale` 判定 = `now - lastAt > 2 × pollInterval = 30s` 显示 banner + 禁用 pprof;pprof tab:6 个低开销按钮(heap/goroutine/allocs/block/mutex/threadcreate)直接 `window.open` 下载 .pb.gz;CPU profile / trace 两个高开销 `danger` 按钮**单独一行**(从横排同行改的),Modal 二次确认才带 `confirm=true` 打开。`SystemChart` = `@ant-design/plots` Line 2.x 薄包,React.lazy 把 G2 ~250 KB bundle 切到详情页才下载。<br/>**杂项清理**:`/api/v1/metrics` 调试端点删了(3 个 cache 计数迁到 CachesCollector);`gateway.MetricsSnapshot` / `WorkerSnapshot` 死代码删了;`PluginBlob sha256` 改成从 embed.FS 算稳定 hash(原来每次启动 Helm gzip 时间戳 → 不同 sha → 每次 INSERT 重复行)；GORM custom logger `IgnoreRecordNotFoundError: true` 干掉 ErrRecordNotFound 日志噪音。<br/>**性能开销**:50 节点稳态 ~3.3 INSERT/秒,稳态行数 50 × 1d × 4/min ≈ 28.8 万行 ≈ 600 MB raw / ~300 MB TOAST 压缩;单次 poll yamux RPC + JSON patch + PG INSERT 总计 < 5ms;1 个 browser 看详情页(1h live)首屏 ~240 行 + 每 15s 增量 ≤ 1 行;**N 个 browser 看同一节点不放大** —— 都查同一份 PG 行,后台 polling 跑 1 路。<br/>**T4 实测**:本地 server 起 → poller 自动注册 server + cluster 两个 ticker → `/api/v1/system/snapshots` 返回 2 行最新 snapshot;`/api/v1/system/test/history?range=1h` 返回 240 行;`heap.pb.gz` 合法 gzip;`/pprof/profile?seconds=2` 无 confirm = 403 `PPROF_CONFIRMATION_REQUIRED`,带 confirm = 200 + .pb.gz。 | ✅ 完成 |
