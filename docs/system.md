# 系统管理(`/system`)

KPilot 自身的运维门面 —— server 进程 + 每个 worker 进程的 Go runtime、业务计数器、pprof profile,全部在一个控制台。**不依赖 VictoriaMetrics / Grafana**,数据来自 `pkg/diag` 内置采集,Server 定时拉取后落到 PostgreSQL,保留 1 天。

## 谁用?

- **运维**:server 内存涨了 / worker 反代怎么慢了 / 哪个集群的 yamux stream 数突然飙升,实时看而不是查日志推。
- **排查**:抓 pprof heap / goroutine / CPU profile 下载到本机,`go tool pprof -http=:6060` 看火焰图。
- **容量评估**:某 worker 的 in-cluster proxy inflight 长期接近上限,该扩了。
- **事后复盘**:worker 已经掉线了,但最后 1 天的 snapshot 还在 PG,详情页能完整重放(只是 pprof 不可用)。

## 菜单结构

`/system`(顶级菜单**系统管理**,icon = setting,位于 sider 最右)。子菜单:

| 路径 | 名称 | icon | 说明 |
|---|---|---|---|
| `/system/monitor` | 系统监控 | dashboard | 节点列表 + 详情页(本文档) |
| `/system/monitor/:node` | (hideInMenu)| — | 详情页 drill-down,从 landing 点"查看"进入 |
| `/system/logs` | 系统日志 | profile | 占位页(后端 endpoint 待落地) |

未来可扩展系统设置 / 用户管理等,模式同 `/models` 的多对等子菜单。

## 系统监控页面

### Landing(`/system/monitor`)

```
节点表格(server 1 行 + N 个 worker)
列: 节点 / 状态 / 上线时长 / Goroutines / CPU / 内存 / 业务指标 / 操作
  - CPU 列:Progress bar(%) + 「45% · 1.23 / 8 核」
  - 内存列:Progress bar(%) + 「23% · 512 MiB / 2 GiB」
  - 业务指标:server = sessions/streams/RPS,worker = streams/inflight
10 秒自动刷新(背景静默,无手动 button)
```

CPU 利用率需要两次连续 snapshot 求差才能算出,首次进页面 CPU 列显示 `0% · 0.00 / N 核`,等 10 秒第二次轮询拿到才有真实值。Memory 单次 snapshot 就能算。

「查看」按钮**始终可点**(包括离线 worker)—— DB 里还有最后 1 天的历史,可以进详情页做事后分析。

### 详情(`/system/monitor/:node`)

```
顶部:8 KPI 卡 2 行 × 4 列
  uptime / goroutines / heap / GC p99 / sched p99 / CPU% / RSS / FDs

Body toolbar(分组):
  [<TimeRangePicker>]  [polling tag]  [pause button]

Tabs(7-8 个,按节点类型动态显示):
  概览     goroutines / heap / GC pause / CPU
  内存     heap 各段堆叠 / alloc rate / live objects / RSS
  调度     sched latency 分位 / mutex wait
  网络     [server only] yamux session/stream by cluster
  HTTP     [server only] RPS / 5xx / p50/p90/p99 latency / in-flight / SSE clients
  数据库   [server only] DB pool open/in_use/idle + wait
  集群代理 [worker only] 5 个 handler inflight + 路由缓存命中率
  pprof    下载按钮组(heap / goroutine / allocs / block / mutex / threadcreate / CPU / trace)
```

Header subtitle 一行小字:`hostname · pid X · app · goY.Z · goos/goarch · M/N procs`。

### 时间范围

详情页 toolbar 有 `<TimeRangePicker>`,预设 `1h / 3h / 6h / 12h / 24h` + 绝对范围 picker。默认 1 小时。后端按范围**自动降采样到 ~240 行**(返回响应永远不超过 ~500 KB):

- `1h` → 240 行原始,15 s 间隔(精度无损)
- `24h` → 240 行采样,~6 min/sample(看趋势用,看精度请选窄范围)
- 自定义"昨晚 23:50 → 00:10"那 20 分钟 → 80 行原始,精度完整

**Live 模式 = preset 1h**:前端 15 秒一次增量 `?since=` 拉取追加新点;其他范围切换 = 一次性全量重 fetch。stale 判定 = 最新 sample 早于 `now - 30s`,banner 警告 + pprof 按钮禁用。

## 架构

```
worker / server 进程
  └── pkg/diag mux(127.0.0.1:任意端口) /debug/snapshot + /debug/pprof/*

Server 进程
  ├── diag.Poller(每 15s 拉一次,worker 走 yamux tunnel /debug/snapshot
  │   → patch identity.name = cluster_name → INSERT PG)
  ├── janitor(每 15min,DELETE rows older than 25h)
  └── HTTP handler(纯 DB reader)

PostgreSQL
  system_snapshots(node_id, at, snapshot JSONB)
    PK (node_id, at) — 无 synthetic id
    indexes: (node_id, at DESC) + (at)
```

**单 writer per node**:poller 是唯一写入路径,HTTP handler 永不写 DB,不需要 INSERT 锁竞争 / 去重逻辑。

**Worker diag 端口发现**:worker 启动时 `net.Listen("127.0.0.1:0")` 拿随机端口,通过 STREAM_REGISTER 把端口号上报给 server(proto v2 `RegisterRequest.diag_port`)。server 端 `gateway.ConnectedWorker.DiagPort` 缓存,poller 拿来拼 URL 走 tunnel HTTP。

**Worker identity patch**:worker 进程启动时不知道自己叫啥(cluster_name 是 server 端 register 时分配的),`cmd/worker/main.go` fallback 用 `cfg.ServerAddr` 凑。poller 写 DB 前 50 µs JSON in-place 改写 `identity.name = gw.GetWorker(nodeID).ClusterName`,详情页/landing 拿到的就是真实集群名。

## API 端点

| 路径 | 用途 |
|---|---|
| `GET /api/v1/system/nodes` | 列出 server + 所有 worker 节点的注册视图(name / cluster_name / online / diag_available)|
| `GET /api/v1/system/snapshots` | 批量返回所有节点的**最新一行**(landing 用,10s 轮询)|
| `GET /api/v1/system/:node/history?range=1h\|3h\|6h\|12h\|24h` | 预设范围,后端按范围自动降采样到 ~240 行,ASC |
| `GET /api/v1/system/:node/history?from=RFC3339&to=RFC3339` | 绝对范围,同样降采样;31 天 cap |
| `GET /api/v1/system/:node/history?since=RFC3339` | 增量(详情页 1h live 模式的 15 s 轮询用),返回 since 之后 ≤ 240 行,不降采样 |
| `GET /api/v1/system/:node/pprof/:kind` | 反代 pprof 端点,返回 `.pb.gz`(浏览器直接下载,**实时,不进 DB**)|

`:node` = `server` 或 worker 的 `cluster_id`。

**pprof 高开销端点**(`profile` / `trace`)必须带 `?confirm=true`,否则 403 `PPROF_CONFIRMATION_REQUIRED`。前端的 CPU profile 按钮已自动加确认 Modal。

`/api/v1/system/:node/snapshot` **已删除** —— 单点快照需求被 `?since=最新-1s` 模式或者 batch endpoint 覆盖了,没人调。

## 指标清单

### Runtime(来自 `runtime/metrics` + gopsutil)

`goroutines / gomaxprocs / os_threads / heap_inuse / heap_idle / heap_released / heap_goal / stack_inuse / runtime_overhead / total_mapped / total_alloc / live_objects / gc_cycles_total / gc_pause_p50/p90/p99/max(秒,delta 模式取最近 1s)/ sched_latency_p50/p90/p99(秒,delta) / cpu_user / cpu_gc / cpu_idle / cpu_scavenge / cpu_total(累计 cpu-seconds) / mutex_wait_total / rss_bytes / open_fds / max_fds / mem_total_bytes / process_cpu_user_seconds / process_cpu_system_seconds / process_io_read_bytes / process_io_write_bytes / system_mem_used_bytes / system_mem_available_bytes`

> **跨平台**:`pkg/diag/proc_*.go` 走 gopsutil v4 取进程级数据,**macOS / Linux / Windows 都能拿到** RSS / open_fds / mem_total。Linux 额外读 `/sys/fs/cgroup/memory.{max,limit_in_bytes}` 让 `mem_total_bytes` 反映容器内 cgroup 限制而不是宿主机物理内存。process_io_* 只 Linux 有(走 `/proc/<pid>/io`),其他平台显示 0。

### Server 业务(`pkg/server/diag/collectors.go`)

- **yamux** — `sessions` / `streams_open` / `streams_by_cluster`(每集群当前活跃 stream 数)
- **db** — `max_open_connections` / `open_connections` / `in_use` / `idle` / `wait_count` / `wait_duration_seconds`
- **http** — `in_flight` / `requests_total` / `requests_per_sec` / `status_5xx_total` / `status_5xx_per_sec` / `latency_p50/p90/p99_ms`(双 buffer + 1s 旋转)
- **inference** — `inflight`(OpenAI 兼容反代正在处理的请求) / `total`(累计) / `sse_clients`(同时 SSE 客户端数)
- **caches** — 跨 handler 的 cache 命中率(原 `/api/v1/metrics` 上的几个指标迁过来)

### Worker 业务

- **tunnel** — `connected` / `session_uptime_seconds` / `reconnect_total` / `streams_open` / `server_addr`
- **proxy** — `inflight_resource` / `inflight_http_proxy` / `inflight_logs` / `inflight_exec` / `inflight_ws`(每类 handler 当前活跃数)
- **in_cluster_router** — `mode`(direct/service-proxy/unknown) / `age_seconds` / `hits` / `misses` / `hit_rate`

## pprof 使用

下载后用 Go 自带的 `pprof` 工具看(系统已安装 Go SDK 的话):

```bash
# Heap profile — 当前堆上各类型对象大小
go tool pprof -http=:6060 heap.pb.gz

# CPU profile — 30 秒采样的调用图 / 火焰图
go tool pprof -http=:6060 cpu.pb.gz

# Goroutine stack — 查 leak / 死锁
go tool pprof -http=:6060 -nodefraction=0 goroutine.pb.gz
```

`go tool pprof -http=:6060` 会启动一个本地 web UI,默认浏览器打开,左上角下拉切换 Top / Graph / Flame Graph / Source 视图。

## 性能开销

| 场景 | 开销 |
|---|---|
| 后台 polling | 每节点 4 次/分钟(15s 周期)。50 节点集群 ≈ **3.3 INSERT/秒**,PG 玩剩下的 |
| 单次 poll | yamux RPC 数百 µs ~ 几 ms + JSON identity.name patch ~30 µs + PG INSERT 1-3 ms |
| 每行 snapshot 体积 | ~2 KB JSONB,稳态 50 节点 × 1d × 4/min = ~28.8 万行 ≈ **600 MB raw,~300 MB TOAST 压缩后** |
| TTL janitor | 每 15 min 跑一次 `DELETE WHERE at < now()-25h`,trim ~3000 行/run,毫秒级 |
| 1 个 browser 看 landing | 每 10s 一次 `GET /system/nodes` + `GET /system/snapshots`,< 10 ms |
| 1 个 browser 看 detail(1h live) | 首屏一次 ~240 行,之后每 15s 增量 ≤ 1 行 |
| N 个 browser 看同一节点 | **不放大** —— 都查同一份 PG 行,后台 polling 跑 1 路 |
| Server 进程内存增量 | **0**(数据在 PG)|
| HTTPCollector hot path | 每请求 5–7 个 atomic 操作,**无 mutex / 无 CAS 重试** |
| CPU profile 30s | 节点 CPU 短时升高 ~5%(这是 profile 的本意,不进 DB)|

## 复用 `pkg/diag` 接入自己的 Go 程序

`pkg/diag` 是零业务依赖的纯 stdlib + gopsutil 包,可以直接抄到任何 Go 项目里(将来可能拆成独立 module)。最小例子:

```go
import "github.com/togettoyou/kpilot/pkg/diag"

func main() {
    d := diag.New("my-app", "instance-1", "v1.0.0")

    // 可选:注册自定义 collector
    d.Register(myCustomCollector{})

    mux := http.NewServeMux()
    d.Mount(mux, "/debug")

    ln, _ := net.Listen("tcp", "127.0.0.1:0")
    go http.Serve(ln, mux)
    log.Printf("diag on :%d", ln.Addr().(*net.TCPAddr).Port)

    // ... rest of your program
}

type myCustomCollector struct{}

func (myCustomCollector) Name() string { return "myapp" }
func (myCustomCollector) Collect() map[string]any {
    return map[string]any{
        "queue_depth": atomic.LoadInt32(&queueDepth),
        "active_jobs": atomic.LoadInt32(&activeJobs),
    }
}
```

然后访问 `http://127.0.0.1:<port>/debug/snapshot` 看完整 JSON,或者 `http://127.0.0.1:<port>/debug/pprof/heap` 拿堆 profile。

## 安全模型

- **Worker 端 diag mux 只 bind 127.0.0.1**,不监听外部网卡 —— 默认无法从集群外访问。端口通过 STREAM_REGISTER 上报给 server,只在 yamux session 内可见。
- **Server 端 diag mux 同样只 bind 127.0.0.1** —— 不暴露在主 HTTP 端口上。
- 所有外部访问通过 `/api/v1/system/*` 走主 HTTP server,带 JWT cookie 鉴权,跟 admin API 同一组中间件。
- **pprof CPU profile / trace 强制二次确认**(`?confirm=true`),防止误点把节点 CPU 拉高 30 秒。

## 不做什么

- **不做告警**:这是诊断工具不是监控平台。告警走 VictoriaMetrics + Alertmanager 那一套。
- **不做长期归档**:retention 25h(1 天 + 1h 缓冲),要 7d / 30d 历史趋势请 export 到 VM。
- **不做 push gateway**:server 主动拉,worker 不主动 push runtime metrics —— 这样 server 进程是单一数据源,worker 端不需要维护额外的连接 / 重试逻辑。
