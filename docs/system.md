# 系统监控（`/system`）

KPilot 自身的运行时观测面板 —— server 和每个 worker 进程的 Go runtime、业务计数器、pprof profile,全部在一个控制台。**不依赖 VictoriaMetrics / Grafana**,数据来自 `pkg/diag` 内置采集,关页面即丢(零持久化)。

## 谁用?

- **运维**:server 内存涨了 / worker 反代怎么慢了 / 哪个集群的 yamux stream 数突然飙升,实时看而不是查日志推。
- **排查**:抓 pprof heap / goroutine / CPU profile 下载到本机,`go tool pprof -http=:6060` 看火焰图。
- **容量评估**:某 worker 的 in-cluster proxy inflight 长期接近上限,该扩了。

## 页面结构

```
/system  (顶级菜单 📊)
├── landing: 节点表格(server 1 行 + N 个 worker)
│   每行 KPI: 状态 / uptime / goroutines / heap / GC p99 / RSS / 业务指标
│   4s 自动刷新
│
└── /system/:node  详情页
    ├── 顶部 8 KPI 卡(uptime / goroutines / heap / GC p99 / sched p99 / CPU% / RSS / FDs)
    └── Tabs:
        ├── 概览     goroutines / heap / GC pause / CPU
        ├── 内存     heap 各段堆叠 / alloc rate / live objects / RSS
        ├── 调度     sched latency 分位 / mutex wait
        ├── 网络     [server only] yamux stream by cluster
        ├── HTTP     [server only] RPS / 5xx / p50/p90/p99 latency / in-flight / SSE clients
        ├── 数据库   [server only] DB pool open/in_use/idle + wait
        ├── 集群代理 [worker only] 5 个 handler inflight + 路由缓存命中率
        └── pprof    下载按钮组(heap / goroutine / allocs / block / mutex / threadcreate / CPU / trace)
```

**架构**:后端 `diag.Poller` 每 15 秒拉一次所有节点的 snapshot,落到 PG `system_snapshots` 表(JSONB);TTL janitor **每 15 分钟**清理 25 小时前的行(保留 1 天 + 1 小时 buffer)。前端 15 秒一次 HTTP 拉取,首次进页面立刻拿到所选范围的历史。Server / worker 进程内存零增长(数据在 PG 里),server 重启**保留**历史。

**时间范围**:详情页头部有 `<TimeRangePicker>`,预设 `1h / 3h / 6h / 12h / 24h` + 绝对范围 picker。默认 1 小时。后端按范围**自动降采样到 ~240 行**(返回响应永远不超过 ~500 KB):
- `1h` → 240 行原始,15 s 间隔(精度无损)
- `24h` → 240 行采样,~6 min/sample(看趋势用,看精度请选窄范围)
- 自定义"昨晚 23:50 → 00:10"那 20 分钟 → 80 行原始,精度完整

## API 端点

| 路径 | 用途 |
|---|---|
| `GET /api/v1/system/nodes` | 列出 server + 所有 worker 节点的注册视图 |
| `GET /api/v1/system/snapshots` | 批量返回所有节点的**最新一行**(landing,15s 轮询) |
| `GET /api/v1/system/:node/snapshot` | 单节点最新 snapshot |
| `GET /api/v1/system/:node/history?range=1h\|3h\|6h\|12h\|24h` | 预设范围,后端按范围自动降采样到 ~240 行,ASC |
| `GET /api/v1/system/:node/history?from=RFC3339&to=RFC3339` | 绝对范围,同样降采样;31 天 cap |
| `GET /api/v1/system/:node/history?since=RFC3339` | 增量(详情页 1h live 模式的 15 s 轮询用),返回 since 之后 ≤ 240 行,不降采样 |
| `GET /api/v1/system/:node/pprof/:kind` | 反代 pprof 端点,返回 `.pb.gz`(浏览器直接下载,**实时,不进 DB**) |

`:node` = `server` 或 worker 的 `cluster_id`。

**pprof 高开销端点**(`profile` / `trace`)必须带 `?confirm=true`,否则 403 `PPROF_CONFIRMATION_REQUIRED`。前端的 CPU profile 按钮已自动加确认 Modal。

## 指标清单

### Runtime(来自 `runtime/metrics`)

`goroutines / gomaxprocs / heap_inuse / heap_idle / heap_released / heap_goal / stack_inuse / runtime_overhead / total_mapped / total_alloc / live_objects / gc_cycles_total / gc_pause_p50/p90/p99/max(秒,delta 模式取最近 1s)/ sched_latency_p50/p90/p99(秒,delta) / cpu_user / cpu_gc / cpu_idle / cpu_scavenge / cpu_total(累计 cpu-seconds) / mutex_wait_total / rss_bytes(Linux only) / os_threads(Linux only) / open_fds(Linux only) / max_fds(Linux only)`

> **macOS / Windows**:`rss_bytes` / `os_threads` / `open_fds` / `max_fds` 显示为 0,因为这些只能通过 `/proc/self/*` 读取。要看进程级 RSS 请用 `top -p <pid>` 或 macOS Activity Monitor。

### Server 业务

- **yamux** — `sessions` / `streams_open` / `streams_by_cluster`(每集群当前活跃 stream)
- **db** — `max_open_connections` / `open_connections` / `in_use` / `idle` / `wait_count` / `wait_duration_seconds`
- **http** — `in_flight` / `requests_total` / `requests_per_sec` / `status_5xx_total` / `status_5xx_per_sec` / `latency_p50/p90/p99_ms`(双 buffer + 1s 旋转)
- **inference** — `inflight`(OpenAI 兼容反代正在处理的请求) / `total`(累计) / `sse_clients`(同时 SSE 客户端数)

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
| 后台 polling | 每节点 4 次/分钟。50 节点集群 ≈ **3.3 INSERT/秒**,Postgres 玩剩下的 |
| 每次 INSERT 体积 | ~2 KB JSONB,稳态 50 节点 × 240 行 = ~24 MB,TOAST 压缩后 **~12-15 MB** |
| 1 个 browser 打开 detail | 首屏 GET /history 一次 ~10 ms,之后每 15 秒一次增量 GET(typically 1-2 行)|
| N 个 browser 看同一节点 | **不放大** —— 都查同一份 PG 行,后台 polling 只跑 1 路 |
| Server 进程内存增量 | **0**(数据在 PG 里) |
| HTTPCollector hot path | 每请求 5–7 个 atomic 操作,**无 mutex / 无 CAS 重试** |
| CPU profile 30s | 节点 CPU 短时升高 ~5%(这是 profile 的本意,不进 DB) |

## 复用 `pkg/diag` 接入自己的 Go 程序

`pkg/diag` 是零业务依赖的纯 stdlib 包,可以直接抄到任何 Go 项目里(将来可能拆成独立 module)。最小例子:

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

- **Worker 端 diag mux 只 bind 127.0.0.1**,不监听外部网卡 —— 默认无法从集群外访问。
- **Server 端 diag mux 同样只 bind 127.0.0.1** —— 不暴露在主 HTTP 端口上。
- 所有外部访问通过 `/api/v1/system/*` 走主 HTTP server,带 JWT cookie 鉴权,跟 admin API 同一组中间件。
- **pprof CPU profile / trace 强制二次确认**(`?confirm=true`),防止误点把节点 CPU 拉高 30 秒。

## 不做什么

- **不做告警**:这是诊断工具不是监控平台。告警走 VictoriaMetrics + Alertmanager 那一套。
- **不做历史趋势**:浏览器 ringBuffer 最长 1 小时,关页面即丢。要看 7d / 30d 趋势,export 到 VM。
- **不做多用户共享视图**:数据在 PG 共享,但每个 browser 独立本地 ring;后台 polling 跟订阅者数量无关(`always-on` 模式)。
