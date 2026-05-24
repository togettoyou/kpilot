# KPilot

**Kubernetes 多集群管理 + GPU 算力调度 + 模型服务的一体化控制面。**

五个顶级平台：

| 平台 | 范围 | 详细文档 |
|---|---|---|
| 集群管理 (`/clusters`) | 通用 K8s 资源管理：节点、工作负载、监控、日志 | [docs/clusters.md](docs/clusters.md) |
| 算力调度 (`/compute`) | 基于 Volcano 的批量调度：Queue / Job / PodGroup CR 浏览，调度策略，vGPU 切分（volcano-vgpu-device-plugin），GPU-Hour 治理 | [docs/compute.md](docs/compute.md) |
| 模型服务 (`/models`) | 模型仓库、推理部署、调试、路由、训练任务 | [docs/models.md](docs/models.md) |
| 插件管理 (`/plugins`) | Helm chart 注册表，前三个平台的能力底座 | [docs/plugins.md](docs/plugins.md) |
| 系统管理 (`/system`) | KPilot 控制面自身的运维门面：系统监控（runtime / 业务计数器 / pprof）+ 系统日志（跨节点查询 + 实时跟随 + 下载），都走 PG-backed 1d 历史，server + worker 同结构 | [docs/system.md](docs/system.md) |

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
│   ├── SystemLogs/          # 系统日志（P19）：`/system/logs`。跨节点查询（node / level / module / 关键词 + TimeRangePicker），实时跟随（2s 增量 polling），下载（TXT / NDJSON），大屏模式（Esc 退出）。全 full-bleed + react-virtuoso 虚拟列表 + theme 适配暗色
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
| `KPILOT_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`，运行时也可通过 `pkg/log.SetLevel()` 调整 |
| `KPILOT_LOG_MODE` | `console` | `console`(人读)或 `json`(结构化) |
| `KPILOT_LOG_COLOR` | `auto` | `always`/`never`/`auto`(stderr 是 TTY 时着色) |

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

### 日志（pkg/log，统一走 zap）
所有 server / worker 日志必须经过 `pkg/log` —— 一层薄包,console 模式可读输出 + 模块名 + level filter。**不要 `import "log"` / `fmt.Println`**;GORM 和 Gin 也走我们的 logger(`pkg/log/gorm.go`、`pkg/log/gin.go`)。

每个文件顶部声明一个文件级 logger:
```go
import kplog "github.com/togettoyou/kpilot/pkg/log"

var pollerLog = kplog.L("diag-poller")  // 模块名 = lowercase kebab
```

调用点用 KV 变参(优先)或 `*f` 格式(porting 老代码):
```go
pollerLog.Info("fetch recovered", "node", nodeID)
pollerLog.Warn("fetch failed", "node", nodeID, "err", err)
pollerLog.Errorf("insert failed: node=%s err=%v", nodeID, err)  // 格式化等价
pollerLog.Fatal("db init failed", "err", err)  // log + Sync + os.Exit(1)
```

**Level 约定**:
- `Debug` — 每请求 / 每帧 / 每 poll 的状态日志(`KPILOT_LOG_LEVEL=debug` 才出);
- `Info` — 启动停止 / 集群连断 / 状态变化(≪ 1/sec 稳态);
- `Warn` — 失败但可恢复(单次 PromQL 失败、worker 重连前掉线、validation 拒绝);
- `Error` — 需要运维介入(boot fail、insert fail、panic recover)。

**模块名约定**:lowercase kebab,匹配 package 角色(`gateway`、`yamux`、`http-proxy`、`pod-exec`、`diag-poller`、`inference-proxy`、`tunnel`、`gorm`、`gin`、`router`、`handler.model` 子区域用点)。同包多文件用文件名做变量后缀避免冲突(`execLog`、`httpLog`、`vgpuLog`),module name 仍可相同。

**热路径性能**:Sugar API ~1-2 µs/call,对所有控制面场景都够用。HTTP middleware(`pkg/log.GinMiddleware`)每请求一行,落在 < 1% 请求预算。极少数真正需要零 alloc 的地方:`lg.Zap()` 拿到原始 `*zap.Logger` 走 `zap.Field`。

**Env 控制**:`KPILOT_LOG_LEVEL=debug|info|warn|error`(默认 info)、`KPILOT_LOG_MODE=console|json`(默认 console)、`KPILOT_LOG_COLOR=always|never|auto`。

**GORM 慢查询阈值**:200ms,超过 Warn;查询错误(非 `ErrRecordNotFound`)Error。**Gin 5xx → Error / 4xx → Warn / 2xx 3xx → Info**(`pkg/log/gin.go::GinMiddleware`)。

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
| `/system` | 系统管理 | KPilot 控制面自身的运维区,模仿 `/models` 的多对等子菜单结构:`/system/monitor` 系统监控(节点表 + 详情页 + pprof,走 PG `system_snapshots` + 15s poller)、`/system/logs` 系统日志(跨节点查询 + 实时跟随 + 下载,走 PG `system_logs` + 5s LogsPoller)。`/system` 默认重定向到 `/system/monitor`,详情页 `/system/monitor/:node` `hideInMenu`。**放 sider 最右** —— 诊断 / 运维区,不是日常主流程入口 |

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
| P12 | P11 vGPU 收尾打磨。**vGPU 页**完整重构:KPI 三个利用率(slots / memory / cores)改 `Progress.dashboard` 环形,卡片式 card-per-node 节点列表(每节点头部三段聚合 bar + 节点下逐张卡一行),pod 名点击改打开 DescribeDrawer(非 Logs),UUID 尾截 + 搜索 + 排序 + drilldown。**Chart 修复**:两个 ConfigMap 放 release namespace(默认 `volcano-system`),device-config 依赖 `kube-system → volcano-system` fallback 链。**架构清理**:删 `pkg/server/protect/`(写保护全部归还给 K8s RBAC + controller)。**Volcano 内置 chart**:默认 scheduler.conf 带 `deviceshare` plugin + `VGPUEnable: true`,新装即用。**Job/CronJob/Queue 表单**:加原生 vGPU 三件套字段(number / memory / cores),JobForm 编辑时 Alert 提示 webhook 限制 + submit-time diff 拦截。**Overview / Scheduler**:Volcano 检测改 cluster-side(worker 探 Queue CRD + ConfigMap),不再依赖 kpilot 插件注册表;list fetch 走 `Promise.allSettled` 容忍可选 sub-CRD 缺失。**hack/**:`aliyun-gpu.sh` → `remote-k3s.sh` 改名 + 跨平台 tunnel pid 跟踪 + SSH multiplex;Tencent/GCP/EC2 镜像 root 密码 SSH 禁用时自动通过 ubuntu/centos/ec2-user 用同密码登录 + sudo bootstrap pubkey 到 root;GPU 节点缺 NVIDIA Container Toolkit 时自动 apt 装上。 | ✅ 完成 |
| P13 | GPU 物理卡监控。NVIDIA DCGM Exporter 内置插件(repo chart 4.8.2,DaemonSet 暴露 `:9400` Prometheus 指标)。**首版 Grafana iframe 嵌 dashboard 12239,后改完全自绘**:`handler/gpu_metrics.go` 并发跑 6 条 PromQL,前端 `pages/Compute/Volcano/GPUMonitoring.tsx` 用 `@ant-design/plots` Line + Progress.dashboard 渲染 KPI 卡 + 6 张多线时序图。required 改 `victoria-metrics + dcgm-exporter`,删 grafana 依赖。**T4 实测发现的修复**:(1) `fbTotal` PromQL 改 `sum(FB_USED + FB_FREE)` —— DCGM 不发 `FB_TOTAL`,老写法 NaN;(2) KPI 卡 4→6,显存独立卡 + Tensor 活跃率(`DCGM_FI_PROF_PIPE_TENSOR_ACTIVE`,Volta+ 才发);(3) `KpiTile` helper 抽共享布局,卡高 stretch + flex:1 min-width:0 防一字一行折行;(4) Col 断点 `xs/sm/md/lg/xl/xxl = 1/2/2/3/4/6`,6-per-row 仅 ≥1600px 才放(老 `lg={4}` 992-1280px 屏每卡 ~200px 把「平均利用率」打成单字纵排)。 | ✅ 完成 |
| P14 | **资源治理三件套** + **集群管理可观测性脱 Grafana** + **跨境链路 HA**。<br/>**资源治理(3 个 VM-backed 页)**:队列配额(`/queue-quota`,Queue 多资源 capability/guarantee/allocated/deserved 自绘三 tick bar,缩进树形 Queue picker)、GPU 告警(`/device-health`,DCGM XID/ECC/温度/FB 四路 PromQL 聚合,severity counts,alert 文案前端 i18n)、GPU-Hour 用量(`/gpu-hour`,`avg_over_time(DCGM_FI_DEV_GPU_UTIL/100)` × 窗口积分,1h/24h/7d/30d range picker)。共享 `pkg/server/api/handler/vm_query.go`(VictoriaMetrics 反代 + 4s TTL cache)。<br/>**集群监控 / 日志改自绘**:删 Grafana iframe + 内置 dashboard。`/clusters/:id/monitoring` 4 个端点(cluster/node/pod metrics + pod health),覆盖 CPU/mem/disk%/IOPS/net/loadPerCore/inode/tcpRetrans/cpuThrottle 等。`/clusters/:id/logging` 自绘 LogsQL 搜索 + 直方图 + ns/pod picker 自动构造 stream selector。`/clusters/:id/grafana` 拆成独立 escape hatch 给 power user。**修两个 Grafana service-proxy bug**:`rest.RESTClient.Do().Raw()` 吞 header 改 `HTTPClientFor` + 手动 http.Request;K8s apiserver text/html 响应 body URL 写死的 PathPrepend,worker `bytes.ReplaceAll` 反向擦掉。<br/>**Worker in-cluster Service URL 路由**:`*.svc.*` 自动走 K8s API server 的 service-proxy 端点(`/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/<path>`),生产 + 本地调试都通。HTTP / WS 共用 `InClusterRouter` 24h TTL 决策缓存。<br/>**共享 `<TimeRangePicker>` 组件**:预设按钮 + RangePicker `showTime` 绝对范围;后端 `time_range.go::resolveTimeRange` 统一 `?range=` / `?from=&to=`,custom 31 天 cap,step 按 duration 自动。<br/>**日志页 UX**:full-bleed 闭式公式高度(viewport - wrapperTop - footerHeight - gap)无外层滚动条 + react-virtuoso 10k 行 DOM 恒定 + 大屏模式(Esc 退出)+ TXT/NDJSON 导出。<br/>**跨境 HA 四件套**(实测带宽只有 ~20 KB/s,大日志查询 20 MiB 在 5min ctx 内根本下不完且 HOL block 其它请求):gRPC stream-level gzip(JSON 体积 1/5)+ prioritySender 改 per-request_id round-robin + `/logs/search` & `/logs/histogram` 改 SSE 穿透 ingress idle timeout + `/debug/tunnel-bench` 跨境带宽自测端点。叠加效果:`limit=10000` 查询从 17min 超时降到 3-4min 且不阻塞。<br/>**T4 实测收尾**:Queue 未设 capability 时 fallback 到集群 Node allocatable 之和当分母(`clusterAllocatable` 顶层挂)+ 「物理」Tag;`parseQuantity` 补齐 SI 小写(`k/M/G/T/P/E`);Overview 队列层级树加 GPU 轴(自动探 vGPU 显存或整卡);删 `QueueResourceCard` 扁平表(数据跟 hierarchy 重复)。<br/>**日志页真流式升级**:`/logs/search` 从"包 SSE 外壳的全缓冲"改端到端逐行流式 —— worker 边读 32 KiB chunk 边发,server accumulator 按 `\n` 切行(跨 chunk 半截行留 buffer + 单行 1 MiB cap)立刻 `sse.send("line", ...)` 流出。SSE 5 事件(meta/progress/line/result/error)。前端 `streamLogsSearch` 用 EventSource + 50ms/100 行 batch onLine 防打爆 React + virtuoso,Search 按钮变 Stop(AbortController)。limit cap 10000→50000。继承 P16 streaming 底座(per-request 公平调度 / `stream.Close()` defer / HTTPCancel 帧主动撤销 upstream)。 | ✅ 完成 |
| P15 | 模型服务 → 模型仓库。全局 `Model` 表 + 12 条 2026-05 内置预设(Qwen3 系列 / DeepSeek-R1 / Llama-4 / Mistral / Phi-4 / GLM-5.1 / Gemma-4 / Kimi-K2.6,统一 vLLM v0.20.2)+ ModelFamily 枚举 9 个 + REST CRUD。内置 PATCH/DELETE 返 403 `MODEL_BUILTIN_LOCKED`;name 强 DNS-1035 label(必须字母开头 + 不含点,给 P16 直接用作 Service / Deployment name)。**前端**:`ModelHub/index.tsx` 家族分组卡片 catalog(Collapse + 搜索 + License/Runtime 过滤)+ HF org logo + Deploy 主按钮 + 复制为自定义 / 编辑 / 删除。`FAMILY_META` + `RUNTIME_DEFAULTS`(image + defaultArgs per runtime,runtime 切换自动 swap)集中维护。抽 `pages.common.*` 共享 i18n 键。background / text / border 全走 `theme.useToken()` 适配暗色。 | ✅ 完成 |
| P16 | 模型服务 → 推理路径完整落地(部署生成器 + chat 调试 + OpenAI 兼容反代 + SSE 流式 + 主动取消 + APIKey 管理 5 大块)。<br/>**1. 部署生成器**(`pkg/server/deploy`):store.Model + DeployOptions → Deployment + Service + 可选 PVC + 可选 HF Secret,通过 worker tunnel apply。Model row = 模板,同一模型可多集群 / 多实例(`{name}` / `{name}-{instance}`)。**Stateless** —— 状态不进 DB,manifests 打 KPilot 标签集(`app.kubernetes.io/managed-by=kpilot` + `kpilot.io/model-id` + family),cluster 是 source of truth。GPU 二选一:`nvidia.com/gpu` 或 `volcano.sh/vgpu-number`。**容器 resources 三层叠加**:① cpu/memory request+limit 可不同(burst headroom);② GPU count limits-only(device-plugin 强制 requests==limits);③ Volcano vGPU 子资源(`vgpu-memory` + `vgpu-cores`)limit-only,仅 `gpu_type=volcano` 时下发。PVC heuristic 按模型名预估(0.6B→5G / 32B→100G / R1→1.4T)。dshm 2 GiB tmpfs 兜底 NCCL。<br/>**2. Chat 反代 + 模型实例**:协议加 `label_selector` 字段。`/models` 改三个对等子菜单(catalog / deployments / chat)。`GET /api/v1/models/deployments` 跨集群跨模型 list-full + label selector,handler 启动时一次性 `store.ListModels` 装 map 避免 N+1。Chat 反代 `Any /clusters/:id/inference/:namespace/:name/*subpath` → `http://<name>.<ns>.svc.<cluster-domain>:8000/v1<subpath>`,端口硬编码 8000 防被改造成通用集群内 HTTP 代理;只转 Content-Type + Accept,KPilot session cookie 剥掉。前端 `model` 字段用 server 下发的 `instance.model_field`(= `HuggingFaceID || deployment.name`)严格匹配 vLLM `--model` 启动值。<br/>**3. OpenAI 兼容反代 + 真 SSE 流式底座**:`HTTPRequestStart` 加 `stream_response = 4`(向后兼容),worker `handleStreaming` stream=true 时 32 KiB 缓冲循环 Read → `SendHTTPResponseChunk` 边读边发。gateway 新增 `http_stream.go::HTTPStream{Status, Headers, Chunks <-chan []byte, EndErr, Close()}` + `SendHTTPRequestStream`,handler MUST defer `Close()`。**鉴权**:`store/api_key.go` Token 格式 `kp-sk-<24B base64url>` 一次性明文展示,sha256 入库;`middleware/bearer_api_key.go` 提取 `Authorization: Bearer ...` → sha256 → URL path scope 精确匹配 → 异步 `TouchAPIKeyLastUsed`(WHERE-clause throttle)。前端 `streamChatCompletions` 用 fetch + ReadableStream + TextDecoder(umi `request` 全缓冲不可用),按 `\n\n` 切 SSE 事件;`pages/ModelChat/index.tsx` 预分配 assistant 气泡固定 React key 避 remount 丢帧,Stop = AbortController.abort()。<br/>**4. HTTPCancel 帧(主动取消)**:proto `ServerMessage.http_cancel`,worker 注册表 + recv dispatch → 查表 → upstream HTTP ctx 撤销 → conn 立即断。server `HTTPStream.Close()` 清理本地 state 前发 HttpCancel(best-effort)。前端 Stop / EventSource 关闭 → defer `stream.Close()` → 立刻断 upstream,不再傻读到 5min 超时。<br/>**5. APIKey 前端管理页** `/models/api-keys`:操作员 ProTable + Create Drawer 二级 picker(cluster Select → 该集群下的推理实例 Select,切 cluster 自动 clear 防 scope 错配)+ 签发成功 Modal 一次性展示明文 token + 复制 + curl usage 示例(`maskClosable=false`)+ 撤销(软删保留审计)/ 删除(硬删)。<br/>**T4 实测验证**:腾讯云 T4 单卡节点(k3s + nvidia-container-toolkit + drop-in `default_runtime_name=nvidia`)跑通 Qwen3-0.6B 全链路 —— UI 一键部署 → Pod Running → `/v1/chat/completions` 实际返回带 thinking 模式的输出。 | ✅ 完成 |
| P17 | **P-Transport-v2:server↔worker 通信层从 bidi gRPC 迁移到 hashicorp/yamux**(详见 [docs/transport-v2.md](docs/transport-v2.md))。**触发**:`/logs/search` Stop 级联卡死 + 跨境单 FIFO slow lane HOL block + 15+ 项手搓"HTTP/2 多流等价物"(prioritySender / chunked transport / HttpCancel 帧 / rxAccumulator / round-robin / gzip / 心跳)代价过高,本质"把单 bidi stream 当多路复用器用"错了。**方案**:每 RPC / 流式会话一条独立 yamux stream(yamux 内置 flow-control + 公平调度 + cancel(FIN) + KeepAlive),应用层不再做。**proto v2**:删 WorkerMessage/ServerMessage oneof + BodyChunk/BodyEnd 对 + *CancelRequest + Heartbeat,改 `StreamHeader{Kind, RequestID, Gzip}` 第一帧定流类型,StreamKind enum 9 个值。**`pkg/transport/yamux/`** ~650 LOC 协议无关层(Codec lazy-gzip 避 net.Pipe 双向 EnableGzip 死锁 + Session + Stream + ReadRaw try-both-types)+ 10 bench + 9 单测。Server gateway 629→175 LOC,worker tunnel 1000→340 LOC。worker proxy 全部转 `HandleStream(ctx, *Stream)` 模式。**净删 4000+ 行**(超原估 1700,vendor 剥 grpc-go / x/net/trace 39k LOC)。<br/>**踩过的关键坑**:<br/>**(1) yamux Stream.Close 是 FIN 不是 RST** —— 半关后 peer 还能写。phase C 假设"close → Read EOF → cancel"在 server 也 CloseWrite 时被立刻误触发,response 还没开始就被撤。修法:server 端 SendHTTPRequestStream / OpenLogsStream 不再 CloseWrite(留 FIN 给真取消);worker 端 HTTPProxy 流式 / LogsManager / ExecManager / WSManager 全部派 **cancel-watcher 1-byte Read goroutine**,EOF = cancel → 触发 ctx 撤销 / SPDY exec 撤销 / WS conn.Close。<br/>**(2) WS pre-existing 反向 bug**:upstream 先关时 writer pump 退出但 reader 卡在 yamux ReadMsg,wg.Wait 死锁 → writer pump 退出后 st.Close 让两端互通(idempotent)。<br/>**(3) plugin handler ack 时序**:cache.Put 必须 BEFORE ack,ack 失败 bail —— 否则 server 以为成功了,worker 重启时已 ack 但未落盘的命令会重复执行 Helm 安装。<br/>**(4) Codec gzip 死锁**:双 EnableGzip 同步 net.Pipe 时 gzip.NewReader 阻塞读 header 等不到对端 Flush。改 lazy reader init(writer 渴望初始化 + Flush header / reader 延到首 ReadMsg)。<br/>**Integration tests** 5 个(`pkg/server/gateway/integration_test.go`,net.Pipe yamux pair fake worker):RPCRoundtrip / StreamCancelPropagates(打穿设计的就是这个)/ ConcurrentRPCs(100 并发隔离)/ LargeResponse(4 MiB 跨 flow-control window)/ DisconnectCleansSessions。**T4 跨境实测**:取消时间从 ~5min(v1 lazy detection 等 per-write deadline)降到 sub-second。**核心收益不是性能,是把架构债一次性清掉** —— 以后新 streaming endpoint 直接开新 stream + 加 cancel-watcher。 | ✅ 完成 |
| P18 | **观测 + 模型服务 + API 计量综合升级**。<br/>**监控页 v2**(`/clusters/:id/monitoring`):重写成 Cluster / Node / Pod 三 tab + 分组 LazySection(IntersectionObserver + chartReady gate),antd Tabs `destroyOnHidden` 避 G2 hidden-pane forceFit 污染。后端三个 metrics handler 加 `?groups=` filter + 4s server cache 拍平 fan-out。**Node** 加 8 个 PromQL(load/mem/disk partitions/tcpConns/diskIO),节点 multi-select + 后端 `listNodeIPMap()` 把 `instance:port` 翻译成 K8s node 名。**Cluster** PromQL fix:`podsByPhase` 移到 overview tab(KPI 卡才拿得到 phase 计数);`pendingPods` `count(gauge)` 改 `sum(gauge)`(`kube_pod_status_phase` 是 0/1 gauge,count 数的是 series 条数 → 幻象数 15 个 Pending)。**Pod** 加 `?podSearch=` 推 PromQL `pod=~"(?i).*<q>.*"`,topk 在 search 结果集里取。**Disk I/O** 单位 s→ms,读写 legend 中文标签。<br/>**日志页 v2**(`/clusters/:id/logging`,11 项 UX):Live tail(2s prepend,lastLineTime+1ms 防重)、直方图点击 zoom-in、行展开 JSON pretty-print + fields 表(lazy parse)、关键词高亮(从 LogsQL 剥 selector 后)、Container picker(三级)、URL 持久化(replaceState 不污染 back 栈)、limit Select 100-50k 替代 free-form Input、pod tag Dropdown(筛选/复制)、LogsQL cheat-sheet popover、stderr 只作中性 Tag(默认 stderr 跟"错误"无关;红/橙改用应用的 `level`/`severity` 字段)、mergeStreamSelector 只替换 query 头 `{...}` 块、Reset 按钮。<br/>**GPU 监控加固**(`/compute/:id/gpu-monitoring`):节点/GPU 多选筛选、"需要关注的 GPU" 卡(client-side 算 idle/hot/OOM 三组)、chart 阈值线(G2 lineY annotation)、per-chart 全屏(Esc 退)、机型分色 legend(读 DCGM `modelName`)、删 fbUsed 写死的 36 GiB 阈值线(T4 16G / H100 80G 都错)。**抖动 root cause**:Select `maxTagCount="responsive"` 模式内部 RO 跟外层 flex layout 互相 reflow,改 `maxTagCount={3}` + 固定 width 阻断。<br/>**GPU 告警 PromQL fix**:FB-near-full 用 `FB_USED / FB_TOTAL` 永远不触发 — DCGM 4.x 不发 `FB_TOTAL`(divisor NaN);改 `FB_USED / (FB_USED + FB_FREE) > 0.95`,100% 显存终于能进告警列表。<br/>**模型实例删除级联**:原来只删 Deployment,Service / PVC / Secret 留垃圾。改 `Promise.allSettled([del all])` + 404 容错。<br/>**模型调试页 UX**(ModelChat):assistant bubble 下方 inline footer `tok/s · 时间 · prompt → completion (total)`,关键 — request body 加 `stream_options: { include_usage: true }`,否则 vLLM stream=true 不发最后的 usage chunk;`<think></think>` 自动拆到独立 Collapse(stream 中展开 / 结束自动收起,用户手动 toggle 后 `thinkOverride` 锁定);assistant 消息走 `react-markdown + remark-gfm`。<br/>**APIKey 计量**:`store.APIKey` 加 prompt/completion/request_count/usage_reset_at 列。`inference_proxy.go` `usageScanner` 双模(SSE 行 + JSON 全 body,256 KiB cap)+ `io.TeeReader` side-channel sniff 响应路径无阻塞,handler async `IncrementAPIKeyUsage`。新 `POST /api-keys/:id/reset-usage`。前端「用量」列 + 「重置用量」per-row(`formatBigNumber` k/M/B)+ tooltip 区分 lifetime / since-reset。<br/>**跨页 scroll reset**:日志 / 模型调试 / GPU 监控 mount 时遍历 ancestor 清 scrollTop + `window.scrollTo(0,0)`,fixed-viewport 布局的 wrapper.top 算高度时不会被残留 scroll 推出 viewport。 | ✅ 完成 |
| P19 | **第 5 平台「系统管理」(`/system`)= 系统监控 + 系统日志 + 日志框架统一**。控制面自观测,脱 VM/Grafana。<br/>**架构演进**:迭代过两版 — 起初 in-memory + per-node 1Hz WS fan-out + browser ring,优点零依赖但 server 重启丢、并发模型复杂、拿不到历史。改成 **PG-backed pull**:server `diag.Poller` 主动拉所有节点 `/debug/snapshot` 落 PG,handler 全转 DB reader,WS 整套删。收益:server 重启保留 1d 历史 + worker 掉线仍能进详情页 + 单 writer per node 无并发 + 多 browser 不放大 polling。代价:延迟 15s(可接受 — 诊断不是 alerting)。<br/>**三层包,通用底座 + 业务 collector 分离**(可拆库)。**`pkg/diag/`** 零业务依赖(stdlib + gopsutil v4):runtime/metrics 投影 50+ key + `Mount` 挂 `/info` + `/snapshot` + `/pprof/*`;进程级 RSS / open_fds / mem_total 跨平台,Linux 额外读 cgroup 让 `mem_total` 反映容器限制。**`pkg/worker/diag/`** + **`pkg/server/diag/`** 业务 collector(yamux / db / http / inference / proxy inflight / router cache),`Serve()` bind 127.0.0.1:0 → 端口走 STREAM_REGISTER 上报。**HTTPCollector 关键性能**:双 buffer live/prev + 1s rotate,hot path 5-7 atomic / 零 mutex,p99 算在 24 桶 power-of-2 histogram。<br/>**Poller 共性**:per-node ticker + jittered first poll(避雪崩)+ store.ListClusters reconcile + janitor。**`diag.Poller`**(snapshot,15s):写 DB 前 50µs JSON in-place 改写 `identity.name = gw.GetWorker(nodeID).ClusterName`(worker 不知道自己叫啥,fallback 用 `cfg.ServerAddr`)。**`diag.LogsPoller`**(logs,5s):lazy init cursor 从 `GetLatestSystemLogSeq(nodeID)` 恢复 + setCursor 单调推进。<br/>**PG schema**:`system_snapshots(node_id, at, snapshot jsonb)` composite PK + `system_logs(node_id, seq, at, level, module, msg, fields)` composite PK + (node_id, at DESC) 复合索引(prev 单列 level/module 索引无用已删)+ (at) for janitor。**Seq 必须存在**:实测 macOS time.Now() 95% 冲突(µs 精度被假装成 ns),`(node_id, at)` 当 PK 会丢日志;seq 从 RingCore atomic.Uint64 来。`SystemSnapshotsRange` PG-side `ROW_NUMBER() % step` 降采到 ≤240 行 + 强制含最新点。<br/>**Server REST**(`handler/system.go`):`/system/nodes`、`/snapshots`(纯 DB,最新行)、`/:node/history` 三种 mode(预设 / 绝对 31d cap / since 增量)、`/:node/pprof/:kind`(yamux 反代 worker `/debug/pprof/*`,不进 DB,profile/trace 强制 `?confirm=true`)、`/:node/logs` 两种 mode(range filter / after_seq live tail)、`/logs/modules?node_id=` 节点 scoped 模块 picker。<br/>**菜单**:`/system`(icon=setting,sider 最右)hub + `/monitor` + `/logs` + `/monitor/:node` hideInMenu。<br/>**前端**:landing 10s setInterval ProTable(节点 / 状态 / CPU 进度 / 内存进度 / 业务 KPI / 查看),离线也可点(PG 有 1d 历史)。详情页(`Detail/index.tsx`):header subtitle 一行小字 + body toolbar `<TimeRangePicker>` + pause + 8 KPI 卡 2×4 + 7-8 tab(antd Tabs `destroyOnHidden` 避 G2 闪烁)+ live 模式 = preset 1h 用 `?since=` 增量;stale 判定 banner + 禁用 pprof。日志页(`SystemLogs/index.tsx`):full-bleed + react-virtuoso + 工具栏(node / level / module / 搜索 / 时间 / 条数 100-10000 / Live Tail switch / 重置 / 刷新 / 清空)+ 结果 Card extra 槽(下载 TXT/NDJSON + 全屏切换,Esc 退出)。**SystemChart** = `@ant-design/plots` Line 薄包,React.lazy 把 G2 ~250 KB bundle 切到详情页才下载。<br/>**日志框架统一(`pkg/log`)**:zap console wrapper,~370 LOC。每文件声明 `var fooLog = kplog.L("module-kebab")`,4 levels + KV 优先 + `*f` 兼容老代码 + `Fatal()` = log + Sync + Exit。env:`KPILOT_LOG_LEVEL/MODE/COLOR`。GORM 跟 Gin 都接到 pkg/log(慢查询 >200ms Warn,Gin 5xx Error / 4xx Warn)。`RingCore` zapcore.Core 把每条 log 推到 50k 槽位 ring(hot path +300ns),`/debug/logs` HTTP endpoint 暴露 ring 给 LogsPoller 拉。**禁止 `import "log"` / `fmt.Println`**。一次 migration 41 文件 ~185 call sites 转过来,bulk 按 message keyword 升级了 89 Warn / 4 Error。**.env 加载顺序坑**:package-level `var lg = kplog.L(...)` 在 godotenv 之前 init,所以 .env 里的 `KPILOT_LOG_LEVEL` 不生效;config.Load 在 godotenv 后显式 `kplog.SetLevel(os.Getenv(...))` 兜底。<br/>**踩过的几个真坑**:(1) worker 重启日志静默丢 — RingCore.seq 从 0 起,server cursor 在 N(大于 worker 新 seq 1,2,3),Snapshot 把全部新行过滤掉。**修法**:seq 起点 anchor 到 `time.Now().UnixNano()`(~1.8e18),新进程的起点天然超过任何旧 cursor;PG PK `(node_id, seq)` 也因 epoch 不同的数值空间,无冲突。(2) worker SIGINT 卡死 — `sess.Accept()` 不看 ctx,acceptLoop 永远 wedged。**修法**:在 connectOnce 起 ctx-watcher goroutine,ctx done → sess.Close() → Accept 返 ErrSessionClosed → 优雅退。Server 早就有这模式,worker 漏了。(3) JS Number 精度 — 19 位 anchored seq 超 `Number.MAX_SAFE_INTEGER`(2^53),前端 `Set<number>` dedupe + `Math.max` 全错。**修法**:`uint64` JSON `,string` tag(双向自动),前端全程 string + BigInt 比较。(4) URL 双重编码 — listSystemLogs 把 buildRangeQuery 已 encoded 的 `from=Z&to=Z` 走 URLSearchParams.set 再过 toString → `%3A` 变 `%253A` → time.Parse 拒。**修法**:把 rangeQuery 直接拼字符串,filter 参数用 URLSearchParams 单独构造再 join。(5) DB 池抖 — `MaxIdleConns(20) < MaxOpenConns(100)`,burst 下完成的连接被关而非回池,下次 burst 重新 TCP+PG auth(~5-20ms),~2.4% 请求 p99 ≈ 200ms 长尾。**修法**:MaxIdleConns 跟 MaxOpenConns 对齐。<br/>**性能开销**:50 节点稳态 snapshot ~3.3 INSERT/s + 日志 100-500 INSERT/s(看负载),稳态磁盘 ~600 MB-1.5 GB/d;单 poll < 5ms;读端 /system/server/logs 10k+ rps(限 limit=500 时);N 个 browser 看同节点不放大 polling。**T4 端到端实测**:`/system/snapshots` 返回 server + cluster 两行;worker 重启日志正常入库;live tail prepend 新行 < 6s 落地;下载 TXT/NDJSON 全前端 blob;pprof confirm 拦截工作。 | ✅ 完成 |
