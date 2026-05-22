# Transport v2: server↔worker 通信层从 bidi gRPC 迁移到 yamux

> 状态:**已上线**(2026-05,phase A–E 全部完成)
> 关联讨论:CLAUDE.md "P14 跨境 worker HA 加固"系列 + P16-C/D streaming 改造
> 触发事件:`/logs/search` Stop 级联卡死 bug(commit `6d293c24`)— 又一次证明现有 transport 的应用层多路复用代价过高
>
> 实际产出:净删 4000+ 行(超出原估算的 1700,因为 go mod tidy 顺手剥掉了 grpc-go / x/net/trace 的 vendored 39 kLOC)。功能 + 性能验证见文末第 16 节"上线后修订"。

## 1. 背景

### 1.1 现有架构

server↔worker 之间走**一条 gRPC bidi stream**(`proto/pilot.proto::PilotService.Connect`)。所有 RPC(K8s 资源代理、HTTP 反代、Helm 插件、Pod 日志、Exec、WebSocket、状态推送、心跳……)**复用同一条 stream**,用 `request_id` 字段做应用层路由。

### 1.2 我们为这个选择付出的代价(15+ 项手搓优化)

| # | 优化 | 解决的问题 | 代码所在 |
|---|---|---|---|
| 1 | chunked transport ≤64 KiB | 单 Send 占 sendMu 太久,阻塞心跳 | `pkg/{worker/tunnel,server/gateway}/chunked.go` |
| 2 | prioritySender fast/slow lane | 心跳排队在数据 chunk 后面 | `pkg/{worker/tunnel,server/gateway}/sender.go` |
| 3 | slow lane per-request_id sub-queue + round-robin | 大响应 chunk 头阻塞小请求(HOL) | 同上 |
| 4 | chunk size 256→64 KiB | 跨 WAN 单 slot 等待降 4× | 同上 |
| 5 | gRPC stream-level gzip 压缩 | 跨 WAN 20 KB/s 带宽 | `pkg/{worker/tunnel,server/gateway}/*.go` 两端 blank import |
| 6 | InitialWindowSize 64 KiB→4 MiB | gRPC HTTP/2 flow control 单 RTT 浪费 | tunnel.go / server.go grpc.WithInitialWindowSize |
| 7 | gRPC HTTP/2 keepalive PING(剥离 app Heartbeat 作观测用) | 应用消息阻塞导致的假死 | 同上 grpc.WithKeepaliveParams |
| 8 | `HTTPRequestStart.stream_response` + 流式 BodyChunk 转发 | SSE 全缓冲 | proto/pilot.proto + chunked.go |
| 9 | `HttpCancel` 帧 | 浏览器 Stop 后 worker 不停 | proto/pilot.proto + tunnel/client.go::httpCancelers |
| 10 | `httpStreams` per-request_id session 表 + closeWorkerHTTPStreams | 跨集群隔离 + 断线兜底 | server/gateway/http_stream.go |
| 11 | streaming chunks buffer 32 cap | 慢消费者的瞬时内存上限 | server/gateway/http_stream.go |
| 12 | per-worker recv goroutine 独立 | worker 间不互相阻塞 | server/gateway/server.go::Connect |
| 13 | per-write `SetWriteDeadline` | 客户端不读不关 TCP 时 server 端 Write 永久阻塞 | sse.go + inference_proxy.go |
| 14 | `rxAsm` per-request_id 累积器 | 多路复用下 chunk 跨帧重组 | 两端 chunked.go |
| 15 | `defer stream.Close()` 严格保证 | 任何异常路径都不能漏清 session | handler 层每处 |

### 1.3 这些代码加起来

| 模块 | 行数(估算) |
|---|---|
| `pkg/server/gateway/` | ~1500 |
| `pkg/worker/tunnel/` | ~800 |
| proto schema 里仅为传输用的字段(StreamResponse / HttpCancel / BodyChunk / *Start 序列) | ~150 |
| **小计** | **~2500 行专门搞 transport 的代码** |

### 1.4 根本诊断

> **我们把"为单个逻辑通道双向 RPC 设计的"gRPC bidi stream 当作"多 RPC 复用器"用了。结果是在应用层重新实现了 HTTP/2 协议的多流特性。**

HTTP/2 协议**天生**支持:per-stream multiplexing、per-stream flow control、per-stream priority、per-stream cancel、自动 keepalive。我们只用了 HTTP/2 的一条 stream,所以这些都得自己搓。

## 2. 目标 / 非目标

### 2.1 目标

- **删掉**那 15 项手搓优化 90% 的实现代码,把 transport 行为下放给 yamux
- **每个 RPC 一条独立流**,慢消费者 / 大响应只影响自己,不互相干扰
- **未来 streaming endpoint 直接 open 一条新流就完事**,不再需要设计 cancel 帧 / chunked 序列 / 累积器
- **保留** worker-dial-server 的拓扑(NAT 友好,Sealos / 跨区集群继续可用)
- **保留** register-once 鉴权模型(一次 token 校验,后续流免鉴权)
- **保留** 跨 WAN 优化效果(gzip、流量控制窗口、keepalive)
- **零业务功能回归** — 所有 handler 层逻辑、proto 业务字段、前端调用方式不变

### 2.2 非目标

- 不改 server↔worker 的鉴权模型(不引入 mTLS,继续用 ClusterToken)
- 不引入第三方组件(NATS、broker 等)
- 不动 worker↔K8s 的部分(controller-runtime、Helm SDK 等)
- 不做 transport 协议版本协商 / 灰度共存(详见 §11 — 干净一次切换)

## 3. 选型:为什么是 yamux

### 3.1 yamux 是什么

`github.com/hashicorp/yamux` — HashiCorp 开源的 **stream multiplexer**。在任意 `io.ReadWriteCloser`(典型是 TCP 或 TLS conn)之上提供多流复用,语义上等价于 HTTP/2 但协议更轻量。

| 特性 | yamux 内置 | 我们手搓的对应 |
|---|---|---|
| Multiplex 多流到一个 conn | ✓ | request_id 路由 + rxAsm |
| 任意端开新流 | ✓(`session.OpenStream()` 两端都能用) | 应用层"我开 stream 是 server 起的还是 worker 起的"判定 |
| Per-stream flow-control window | ✓(默认 256 KiB,可调) | chunks channel buf 32 + chunked transport |
| Stream Cancel | ✓(`stream.Close()`) | HttpCancel / LogsCancel / ExecCancel 帧 |
| Stream end-of-message | ✓(`stream.CloseWrite()` 半关) | BodyEnd 帧 |
| Fair scheduling | ✓(round-robin per-stream chunk) | per-request_id 子队列 + round-robin |
| Keepalive ping/pong | ✓(默认 30s) | gRPC HTTP/2 PING |
| Connection-level liveness | ✓(`session.IsClosed()`) | stream.Context().Done() + lastSeen |

**注:每个 yamux stream 实现 `net.Conn` 接口**,所以 `io.Reader` / `io.Writer` / `SetDeadline` 都直接用,不需要任何适配。

### 3.2 业界用 yamux 的项目

| 项目 | 用途 | 规模 |
|---|---|---|
| HashiCorp **Nomad** | 集群间 RPC | 生产级,全球部署 |
| HashiCorp **Vault** | 集群间 RPC | 生产级 |
| HashiCorp **Consul** | 集群间 RPC | 生产级 |
| HashiCorp **go-plugin** | 进程间 RPC(如 Terraform plugin) | 生产级 |
| **inlets-pro** | 反向 TCP 隧道(类似 ngrok) | 商业产品 |

yamux v0.1.2(2024)— 稳定库,核心代码 ~1000 行 Go,纯标准库依赖,GitHub 2.6k★。

### 3.3 为什么不选别的

| 候选 | 弃用理由 |
|---|---|
| **smux**(xtaci/smux) | 跟 yamux 同类,但 HashiCorp 系生产工艺更熟。yamux 优先 |
| **HTTP/2 over WebSocket** | server 要暴露 WS 入口;反向初发流的语义需要二层封装,比 yamux 重 |
| **NATS / 消息 broker** | 多一个组件,运维复杂度,且 broker 自身可能成 bottleneck |
| **gRPC ClientStreaming + ServerStreaming 两条单向流** | 还是在应用层做多路复用,本质没变 |
| **Tailscale / WireGuard 网络层** | 用 VPN 把 worker 拉进来,server 直接 dial。重 + 用户网络改造 |
| **SPDY** | 已被 HTTP/2 取代,生态萎缩 |
| **自己实现 yamux** | NIH,不值得 |

## 4. 目标架构

### 4.1 一句话描述

```
worker → TLS TCP dial → server
   │
   ├── (TLS handshake)
   │
   ├── yamux session 建立(client 角色=worker,server 角色=server)
   │
   ├── 控制 stream #0(worker 主动 open):
   │     发 RegisterRequest(token, worker_version, cluster_domain)
   │     收 RegisterAck(cluster_id) 或断连
   │
   └── 之后 server 和 worker 都能随时 OpenStream:
         每条逻辑 RPC = 一条独立 yamux stream
         流首帧 = StreamHeader(kind, request_id) 告诉对端"我是什么 RPC"
         之后是 RPC 类型特定的 protobuf 消息序列
         RPC 结束 = stream 关闭
```

### 4.2 关键组件改动

| 组件 | 当前 | v2 |
|---|---|---|
| 传输库 | `google.golang.org/grpc` | `github.com/hashicorp/yamux` + `crypto/tls` + `net` |
| Wire 帧 | gRPC HTTP/2 帧 + proto oneof message | yamux 协议帧 + 长度前缀 protobuf |
| Worker dial | `grpc.NewClient(target, TLS, keepalive, ...)` + `Connect()` 拿 bidi stream | `tls.Dial("tcp", target, cfg)` + `yamux.Client(conn, cfg)` |
| Server accept | `grpc.Server` + `RegisterPilotServiceServer` + `Connect` handler | `tls.Listen("tcp", addr, cfg)` + 每条 conn 创建 `yamux.Server(conn, cfg)` |
| 多路复用 | 应用层 `request_id` 路由 + prioritySender | yamux 自带 |
| Cancel | 自定义 `HttpCancel` / `LogsCancel` / `ExecCancel` 帧 | `stream.Close()` |
| 流控 | chunked 256/64 KiB + chunks channel buf 32 | yamux per-stream window(可调) |
| 心跳 / 离线 | gRPC keepalive PING + `stream.Context().Done()` | yamux KeepAlive(默认 30s)+ `session.CloseChan()` |
| 压缩 | gRPC stream-level gzip | 每个 stream 可选 gzip wrap(协议字段标记) |

### 4.3 新 proto schema

`proto/pilot.proto` 重大简化:

```protobuf
syntax = "proto3";
package pilot.v2;

// ─── 流首帧 ─────────────────────────────────────────────────────────
// 每条 yamux stream 的第一个消息,告诉对端这是什么 RPC。

message StreamHeader {
  // 流类型。决定后续消息怎么解析。
  StreamKind kind = 1;
  // 应用层 RPC id(可选,仅用于跨日志关联;yamux 自己用 stream id)。
  string request_id = 2;
  // 是否对该 stream 启用 gzip。两端 wrap reader/writer 时各自处理。
  bool gzip = 3;
}

enum StreamKind {
  STREAM_UNKNOWN = 0;

  // 鉴权:worker 启动后开的第一条流。
  STREAM_REGISTER = 1;

  // server → worker 请求:
  STREAM_RESOURCE_REQUEST = 10;   // K8s 资源 list/get/apply/...
  STREAM_HTTP_REQUEST     = 11;   // HTTP 反代(buffered 和 streaming 同一种,见 HTTPRequestStart.stream_response)
  STREAM_PLUGIN_COMMAND   = 12;   // Helm enable/disable
  STREAM_POD_LOGS         = 13;   // Pod 日志流(worker 写,server 读)
  STREAM_POD_EXEC         = 14;   // Pod exec(双向)
  STREAM_WS_PROXY         = 15;   // WebSocket 反代(双向)

  // worker → server 推送:
  STREAM_PLUGIN_STATUS_PUSH = 20; // 插件状态变更
  STREAM_PLUGIN_LOG_PUSH    = 21; // 插件安装日志流
}

// ─── 鉴权 ─────────────────────────────────────────────────────────────

message RegisterRequest {
  string cluster_token  = 1;
  string worker_version = 2;
  string cluster_domain = 3;
}

message RegisterAck {
  bool   success    = 1;
  string cluster_id = 2;
  string message    = 3;
}

// ─── 各 RPC 类型的消息(保留现有业务字段,删掉传输用字段) ──────────

// 删除:WorkerMessage / ServerMessage 这两个 oneof 包装(每条流已经有
// 类型,不需要包装)。
// 删除:BodyChunk / BodyEnd / *Start 配对(stream 自身有边界,直接读字
// 节就行)。
// 删除:HTTPCancelRequest / LogsCancelRequest / ExecCancelRequest
// (stream.Close() 替代)。
// 保留:HTTPRequestStart、HTTPResponseStart、ResourceRequestStart、
// ResourceResponseStart、PluginSpec、PluginStatusPush、PluginLogChunk、
// PluginLogEnd、LogsStartRequest、LogsChunk、LogsEnd、ExecStartRequest、
// ExecStdin、ExecResize、ExecOutput、ExecEnd、WSStartRequest、WSFrame、
// WSEnd、HTTPHeader。
// 注:这些消息现在不再放在 WorkerMessage / ServerMessage 的 oneof 里,
// 而是作为独立 message,通过 stream-type-specific 协议直接写在流上。

// (其余消息定义跟现在 1:1,只是去掉 *Start 后缀的 chunked 配对语义)
```

### 4.4 每条 stream 的 wire 协议

每条流的字节流统一格式:

```
[uvarint: msg_len] [protobuf bytes of len msg_len]  ← 第一条消息: StreamHeader
[uvarint: msg_len] [protobuf bytes of len msg_len]  ← 第二条消息(看 stream kind)
...
[stream half-close 或 close]
```

`uvarint` = Go 的 `encoding/binary.Uvarint`,标准长度前缀。

对于"长字节流"(HTTP body、chart blob、SSE 响应、pod logs 字节):**首条业务消息之后直接写裸字节直到 CloseWrite**,不再用 BodyChunk 帧封。

### 4.5 各 RPC 类型详细映射

#### 4.5.1 STREAM_RESOURCE_REQUEST(server → worker)

```
server                                  worker
──────                                  ──────
sess.OpenStream() ────────────────► 
write(StreamHeader{RESOURCE_REQUEST})  
write(ResourceRequestStart{action,gvk,...})
write(body bytes, if any)
CloseWrite()                             ◄─ 读到 EOF,知道请求完整
                                         ─► dispatch K8s op
                                         ─► resp := execute()
                                            write(ResourceResponseStart{success, error})
                                            write(data bytes)
read header + bytes ◄───────────────       CloseWrite()
stream.Close()
```

#### 4.5.2 STREAM_HTTP_REQUEST buffered(server → worker)

跟 §4.5.1 同款。

#### 4.5.3 STREAM_HTTP_REQUEST streaming(server → worker,P16-C SSE)

```
server                                  worker
──────                                  ──────
sess.OpenStream()
write(StreamHeader{HTTP_REQUEST})
write(HTTPRequestStart{method, url, stream_response=true})
write(body, if any)
CloseWrite()                             ◄─ 拨上游 vLLM/VL
                                         ─► 收响应
                                            write(HTTPResponseStart{status, headers})
                                            for chunk in body:
                                              write(chunk bytes)         ← 每次写阻塞按 yamux 流控
read HTTPResponseStart
loop:
  read 32 KiB ──► 写 c.Writer.Write
                                         ─► CloseWrite()(上游 EOF)
read returns EOF ◄────                   
stream.Close()                          
                                         ◄─ 客户端取消?stream.Close() 直接关流
                                            worker 端 Read 立刻返 err,upstream conn close
```

**关键**:用户点 Stop → server 端 `stream.Close()` → worker 端 `Read` 返 `yamux.ErrStreamClosed` → upstream HTTP request ctx cancel(用 `stream` 作为 ctx 的派生?或直接 hresp.Body.Close)。**完全不需要 HttpCancel 帧**。

#### 4.5.4 STREAM_PLUGIN_COMMAND(server → worker)

```
server                                  worker
──────                                  ──────
sess.OpenStream()
write(StreamHeader{PLUGIN_COMMAND})
write(PluginCommandStart{action, crd_name, spec})
write(chart blob bytes, if any)
CloseWrite()
                                         ◄─ 读 + cache chart
                                         ─► helm install / uninstall (async)
                                            write(brief ack proto)  // 或直接 CloseWrite 表示成功接收
                                            CloseWrite()
read ack ◄───────────────────────────
stream.Close()
```

注:安装进度走另一条 `STREAM_PLUGIN_LOG_PUSH`,与 command stream 解耦。

#### 4.5.5 STREAM_POD_LOGS(server → worker)

```
server                                  worker
──────                                  ──────
sess.OpenStream()
write(StreamHeader{POD_LOGS})
write(LogsStartRequest{ns, pod, container, follow, tail})
                                         ◄─ 起 K8s pod logs reader
                                         ─► loop:
                                              read 32 KiB from pod logs reader
                                              write(LogsChunk{data}) 或直接 raw bytes  
loop:
  read chunk ──► 写 WS 给浏览器
                                         ─► CloseWrite() 在 pod logs EOF
read returns EOF ◄────
stream.Close()                            
                                         ◄─ 用户切走?stream.Close()
                                            worker 的 K8s logs reader 关闭(ctx cancel)
```

#### 4.5.6 STREAM_POD_EXEC(双向,server ↔ worker)

```
server                                  worker
──────                                  ──────
sess.OpenStream()
write(StreamHeader{POD_EXEC})
write(ExecStartRequest{ns, pod, container, command, tty, cols, rows})
                                         ◄─ 拨 K8s exec
                                         ─► 双向桥接到 yamux stream
loop:                                       (worker 端两条 goroutine:一条 read stream → 写到 exec stdin,
  read user input from WS                   一条 read exec stdout → 写到 stream)
  write(ExecStdin{data}) on stream
                                         
                                         ─► 周期性 write(ExecOutput{stream, data})
loop:
  read ExecOutput ──► 转发给 WS
                                         ─► exec 退出?
                                            write(ExecEnd{exit_code, error})
                                            CloseWrite()
stream.Close()(用户关掉 terminal)
```

注意 exec 比纯日志复杂,因为有 stdin/stdout/stderr/resize 多种消息穿插。**保留长度前缀 protobuf 消息封装**,不像 logs 那样直接 raw bytes。

#### 4.5.7 STREAM_WS_PROXY(双向,server ↔ worker)

跟 exec 类似,WSFrame 消息封装双向数据。

#### 4.5.8 STREAM_PLUGIN_STATUS_PUSH(worker → server,push 推送)

```
worker                                  server
──────                                  ──────
sess.OpenStream() ──────────────────►
write(StreamHeader{PLUGIN_STATUS_PUSH})
write(PluginStatusPush{crd_name, phase, ...})
CloseWrite()
stream.Close()                            ◄─ read header + status,更新 DB
                                         ─► 流自然关闭
```

#### 4.5.9 STREAM_PLUGIN_LOG_PUSH(worker → server,push 多条)

```
worker                                  server
──────                                  ──────
sess.OpenStream()
write(StreamHeader{PLUGIN_LOG_PUSH})
for each log line:
  write(PluginLogChunk{...})
write(PluginLogEnd{summary})
CloseWrite()                             ◄─ 持续 read,推到 install-log session
                                         ─► EOF,session 结束
stream.Close()
```

#### 4.5.10 RegisterRequest(STREAM_REGISTER)

```
worker                                  server
──────                                  ──────
(yamux session 刚建立)
sess.OpenStream() (第一条)
write(StreamHeader{REGISTER})
write(RegisterRequest{token, version, cluster_domain})
                                         ◄─ 校验 token via store.GetClusterByToken
                                         ─► 成功:write(RegisterAck{success=true, cluster_id})
                                            失败:write(RegisterAck{success=false, message})
read RegisterAck ◄────                      stream.Close()(无论成功失败都关掉首条流)
if !success { session.Close(); abort }
stream.Close()
(主循环开始 AcceptStream 接受 server 推过来的请求)
```

## 5. 文件 / 包结构

### 5.1 新增

| 路径 | 内容 | 行数估算 |
|---|---|---|
| `pkg/transport/yamux/session.go` | yamux session 建立 + Register 流程 + 监听新流 | ~250 |
| `pkg/transport/yamux/stream.go` | 单条 stream 的 read/write helper(长度前缀 proto + 可选 gzip) | ~150 |
| `pkg/transport/yamux/codec.go` | proto 序列化 / 长度前缀框架 | ~80 |
| `pkg/transport/yamux/config.go` | yamux Config 调优(window size、keepalive、TLS) | ~50 |
| `proto/pilot.proto` v2 schema | 见 §4.3 | -100(净减) |
| `docs/transport-v2.md` | 本文档 | ~600 |

### 5.2 重写(API 保持)

| 路径 | 改动 | 行数变化 |
|---|---|---|
| `pkg/server/gateway/gateway.go` | 替换 transport 底层 | ~0(净) |
| `pkg/server/gateway/server.go` | TLS listener + yamux.Server + AcceptStream loop;删除 prioritySender / chunked.go 调用 | -300 |
| `pkg/server/gateway/http_stream.go` | `HTTPStream` 实现改为对一条 yamux stream 的包装 | -150 |
| `pkg/server/gateway/stream.go` | `Stream` 抽象保留,实现切换 | -100 |
| `pkg/server/gateway/plugin_log.go` | 接收逻辑改用一条 stream | -50 |
| `pkg/worker/tunnel/client.go` | yamux.Client + Register + AcceptStream loop | -500 |
| `cmd/server/main.go` | gRPC.Server → tls.Listen + yamux | ~+30 |
| `cmd/worker/main.go` | grpc dial → tls.Dial + yamux | ~+30 |

### 5.3 删除

| 路径 | 完全删除 | 理由 |
|---|---|---|
| `pkg/worker/tunnel/sender.go` | ✓ | prioritySender / fast / slow lane,yamux 替代 |
| `pkg/worker/tunnel/chunked.go` | ✓ | rxAsm 累积器 + sendBodyChunks,yamux 替代 |
| `pkg/server/gateway/sender.go` | ✓ | 同上 |
| `pkg/server/gateway/chunked.go` | ✓ | 同上 |
| proto 中的 `WorkerMessage` / `ServerMessage` 包装 oneof | ✓ | 不再需要 |
| proto 中的 `BodyChunk` / `BodyEnd` / `*Start` 分离 | ✓ | yamux stream 自身分边界 |
| proto 中的 `HTTPCancelRequest` / `LogsCancelRequest` / `ExecCancelRequest` | ✓ | stream.Close() 替代 |

### 5.4 净代码量预估

```
新增:   ~530 行(transport 包 + 配置 + 测试)
重写:   ~-1070 行(主要是净减)
删除:   ~-1200 行(prioritySender / chunked / sender / cancel frames)
─────────────────────────────────────
净减:   ~1700 行
```

## 6. 关键设计决策

### 6.1 yamux Config 调优

```go
cfg := yamux.DefaultConfig()
cfg.MaxStreamWindowSize = 4 * 1024 * 1024   // 4 MiB,跟现在 InitialWindowSize 一致
cfg.AcceptBacklog       = 256                // 同时多达 256 条 pending stream
cfg.EnableKeepAlive     = true
cfg.KeepAliveInterval   = 20 * time.Second   // 跟现在 gRPC keepalive 一致
cfg.ConnectionWriteTimeout = 10 * time.Second // session-level 写超时
cfg.LogOutput           = io.Discard          // 用我们的 log,屏蔽 yamux 自身的
```

### 6.2 TLS

**worker → server**:`tls.Dial("tcp", addr, &tls.Config{ServerName: ..., ...})` — 复用现有的 `resolveServerAddr` 解析 `grpcs://` 风格 URL,只是把 `grpc.NewClient` 换成 `tls.Dial`。

**server → worker**:不存在(worker 总是拨入端)。

Server 端 listen:`tls.Listen("tcp", addr, &tls.Config{Certificates: ..., ClientAuth: ...})`。本地开发可走明文 TCP(等价于现在 `SERVER_ADDR` 不带 scheme 走 `insecure.NewCredentials`)。

### 6.3 Stream 级别 gzip

每个流的 wire 字节流可以选择性 gzip wrap:

```go
type streamCodec struct {
    r  io.Reader  // 可能是 stream 或 gzip.Reader(stream)
    w  io.Writer  // 可能是 stream 或 gzip.Writer(stream)
}

func newCodec(stream net.Conn, useGzip bool) *streamCodec {
    if useGzip {
        // 注意:gzip.Writer 需要 Close 才能 flush 最后一个 block。
        // 我们在 stream Close 之前必须 Close gzip writer。
        gw := gzip.NewWriter(stream)
        gr, _ := gzip.NewReader(stream)
        return &streamCodec{r: gr, w: gw}
    }
    return &streamCodec{r: stream, w: stream}
}
```

`StreamHeader.gzip` 字段告诉对端"我用 gzip"。**header 自身不压缩**(否则就 chicken-and-egg)。

默认值:
- HTTP request/response、Resource request/response、Pod logs:**gzip on**(JSON / text,压缩比 5-8×)
- Plugin chart blob:**gzip off**(.tgz 本身已经压缩)
- Pod exec、WS proxy:**gzip off**(交互式,延迟敏感)
- Register、Plugin status push、Plugin log chunk:**gzip off**(消息小,gzip 开销大于收益)

### 6.4 Cancel 语义

**取消一个进行中的 RPC = `stream.Close()`**。

调用 Close 后:
- 本端:Write 立刻失败,Read 立刻返 `io.EOF` 或 `yamux.ErrStreamClosed`
- 对端:Read 收到 `io.EOF` 或 err。任何 Write 会失败

handler 需要在 Read 错误时 unwind:关上游连接(K8s exec session、HTTP body 等)。

完全替代现有的 `HttpCancel` / `LogsCancel` / `ExecCancel` 帧。

### 6.5 Half-close 语义

`stream.CloseWrite()` 表示"我这一侧不再写了,但还在读"。对端 Read 收到 `io.EOF`,但仍可 Write。

这是经典 SSH 模式。在我们的场景:
- 单向请求(server 发 ResourceRequest):server 写完 CloseWrite,等 worker 写响应
- 单向 push(worker 发 PluginStatus):worker 写完直接 Close(无需响应)
- 流式响应(SSE):worker 持续写直到上游 EOF 后 CloseWrite,server 一直 Read

### 6.6 Heartbeat 与 Liveness

yamux 自带 keep-alive ping(默认 30s,我们调 20s 跟现在对齐)。失败 N 次或超过 timeout(默认 10s)→ session 关闭 → `session.CloseChan()` 触发 → 所有 stream 自动失败。

**完全移除应用层 Heartbeat 消息**。

### 6.7 Per-stream 超时 / deadline

yamux stream 实现 `net.Conn`,直接用 `SetDeadline / SetReadDeadline / SetWriteDeadline`。

不再需要 `http.ResponseController` 的 trick — 但**给 SSE 写客户端 conn 的 deadline 仍然保留**(这是 server → 浏览器的 HTTP 写,跟 yamux 无关)。

### 6.8 worker 端 stream backpressure

worker 写流时若 yamux 窗口满,Write 会阻塞(per-stream 阻塞,不影响其它 stream)。upstream(VL / vLLM)继续读到 worker 的内存里 → worker 自身内存占用增加。

**Mitigation**:worker 端读 upstream 用固定大小 buffer(32 KiB),写不出去就停读。这跟现在的 streaming 路径模型一样,只是 backpressure 路径更干净。

## 7. 测试计划

### 7.1 单元测试

| 包 | 测试内容 |
|---|---|
| `pkg/transport/yamux` | session setup(client/server 各自 happy + error)、Register 鉴权 OK/失败、stream open/accept、gzip codec round-trip、长度前缀 framing |
| `pkg/server/gateway` | 替换 transport 后保持所有 send/receive 接口语义。所有现有 gateway 单测继续通过(可能要补 mock transport) |

### 7.2 集成测试(用真实 yamux session)

```
1. 启动 mock server(yamux server + 简单 handler)
2. worker dial + register 成功
3. server.SendResourceRequest → assert response
4. server.SendHTTPRequest(buffered) → assert response
5. server.SendHTTPRequestStream → assert chunked delivery
6. worker push PluginStatus → server 收到
7. 并发 100 个 ResourceRequest + 1 个长流 logs:小请求延迟不被长流拖累
8. 长流中途 stream.Close()(server 端):worker 检测到立即停止 upstream
9. worker disconnect → server 端所有 in-flight stream 都失败
```

### 7.3 压力测试(对照组)

跑 `hack/loadtest.sh` 的 HOL / concurrent / cancel 场景,**对比 v1 vs v2 数据**:

| 场景 | v1 期望 | v2 期望 |
|---|---|---|
| 1 个 20 MiB 响应同时 50 个小请求 | 小请求延迟 ~3-5s(round-robin 跨 320 chunk) | 小请求延迟 ~150ms(yamux 自己公平调度) |
| 50 个并发 streaming 取消 | 5-10s 全部清理 | 1-2s 全部清理(yamux 流关闭立刻生效) |
| 跨 WAN(模拟 20 KB/s) | gzip + 现有优化下 ~4 min/10k 日志 | 应至少持平,可能略好(yamux 帧开销小于 gRPC HTTP/2) |
| 1000 个并发 Resource list | 当前 prioritySender 子队列管理压力 | yamux 公平调度 |

### 7.4 兼容性

由于是干净切换,**不需要新老共存测试**。但需要:

- **手动验证**:每个 4 平台(集群管理 / 算力调度 / 模型服务 / 插件管理)的每个页面打开 + 主要操作 = 一遍 smoke test
- 重点关注:Grafana iframe 反代、Pod logs / exec / WS、插件安装日志、模型推理 SSE、日志搜索 SSE

### 7.5 回归专项

每个修复过的 bug 加 regression test:
- `/logs/search` Stop 不卡死其它请求(commit `6d293c24`)
- LLM chat Stop 同上
- 大日志查询 + 并发节点查询(P14 HOL 修复)
- worker 断线后 in-flight HTTP stream 全部失败(P16-C closeWorkerHTTPStreams)
- 跨 WAN gzip 压缩生效(新版用 stream codec 内置)

## 8. Migration 步骤(单 PR 但内部分阶段)

虽然最终是**一次 PR / 一次 commit**,但 PR 内部 commit 可以分阶段,便于 review。

### 8.1 阶段 A:准备(不影响现有功能)

1. 加 `github.com/hashicorp/yamux` 依赖到 `go.mod`
2. 在 `pkg/transport/yamux/` 写好 session / stream / codec / config 包
3. 写新 proto schema 到 `proto/pilot_v2.proto`(暂时跟 v1 并存,先不 regen 影响代码)
4. 单元测试 transport 包

### 8.2 阶段 B:重写 server gateway

5. `pkg/server/gateway/transport.go`:抽象 transport 接口,现有 gRPC 实现 vs 新 yamux 实现
6. 把 `Connect` handler 改成 listener+session 模型
7. 重写 `SendResourceRequest` / `SendHTTPRequest` / `SendHTTPRequestStream` / `OpenStream` 等公共 API 内部,改走 yamux stream
8. 删 prioritySender / chunked / rxAccumulators

### 8.3 阶段 C:重写 worker tunnel

9. 镜像在 worker 端做相同事
10. 删 worker prioritySender / chunked / cancel registry

### 8.4 阶段 D:proto 收口

11. 删旧 proto schema 的 oneof 包装,迁移到新 schema
12. 重新生成 pb.go
13. 全栈 build + tsc 通过

### 8.5 阶段 E:测试 + 文档

14. 跑全部单测
15. 跑集成测试
16. 跑压测对照
17. 手动 smoke test 各页面
18. 更新 CLAUDE.md / docs/clusters.md 等文档

### 8.6 部署

19. **新 server + 新 worker 必须一起部署**(协议不兼容,无版本协商)
20. Sealos / k8s 集成场景:发布 release notes 说明这是 breaking transport change,需要重新部署 worker

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| **yamux 自身 bug** | 库已生产化,HashiCorp Vault/Nomad/Consul 都在用。万一,fork 修补成本可控 |
| **跨 WAN 性能 regression**(yamux 协议可能没 gRPC HTTP/2 调得这么细) | 阶段 E 强制做压测对照。yamux 默认 256 KiB window 我们调到 4 MiB 跟现在一致 |
| **半关 / 取消语义边界 case** | 在每条 RPC 类型单独写测试覆盖。SSH 模式很标准,坑早就被业界踩过 |
| **新老 worker 不兼容,部署混乱** | 文档 + release notes 强调一次性切换。Worker 镜像 tag bump major version |
| **TLS 配置 vs 原 grpcs:// 兼容** | 现有 `resolveServerAddr` 解析 `grpc://` / `grpcs://` 改成解析 `tcp://` / `tcps://`(同时**保留 grpc 风格作为别名**减少配置改动) |
| **TLS 自签证书 / 跳过验证场景** | 保留 `tls.Config{InsecureSkipVerify}` 配置入口,跟现在一样 |
| **生产环境单点切换风险** | 重构期间冻结新业务功能;切换 PR 完成后跑 1 周回归再合并 main |
| **rollback 困难**(因为是 transport 协议改动,worker 也得跟着退) | 旧二进制 + 旧 proto 暂时保留在历史 git tag。需要回滚时打老版本镜像 |

## 10. 性能预期

基于业界 yamux 数据和 HashiCorp Nomad 公开 benchmark:

| 指标 | v1(现状) | v2(yamux)预期 |
|---|---|---|
| 单 RPC 延迟(本地) | ~1 ms | ~0.5 ms(去掉 gRPC 帧开销) |
| 单 RPC 延迟(跨 WAN 20 KB/s) | ~主要受 WAN bound,transport 不是 bottleneck | 持平 |
| 100 并发小 RPC 同时 1 个 20 MiB 大流(本地) | 小 RPC P99 ~50-200 ms(prioritySender 子队列轮询) | 小 RPC P99 ~5-20 ms(yamux 每流独立) |
| 大流取消生效时间 | ~5s(per-write deadline,刚修过) | ~ms 级(stream.Close 立即生效) |
| 内存占用(50 并发 stream) | ~50 × (32 chunks × 64 KiB) ≈ 100 MiB peak | 50 × 256 KiB ≈ 12.5 MiB peak |

## 11. 为什么是"一次干净到位"而不是灰度

考虑过两种方案:

**A. 灰度共存**:proto 加 transport version,worker 自报支持的版本,server 优先用 v2 否则降级 v1。两份代码并存几个 release。

**B. 一次切换**(本方案):新 PR 把 transport 完全替换,worker + server 必须同步部署。

选 B 的理由:
1. 共存方案需要在 server 同时维护两条 transport 实现 → 代码量翻倍 → 失去重构的"减少复杂度"价值
2. 任何 transport 改动都需要在两套实现里各做一遍 → 维护负担
3. 我们的部署模型本来就是"server + worker 同 release",升级时本来就同步 → 灰度收益有限
4. 切换 PR 自身可以做得很扎实(完整测试 + 文档 + rollback 预案),把风险压在切换那一次

## 12. 时间预算

| 阶段 | 工时(focused dev) | 备注 |
|---|---|---|
| A. transport 包 + 测试 | 3 天 | 关键路径,需细致 |
| B. server gateway 重写 | 3 天 | API 保持,内部换实现 |
| C. worker tunnel 重写 | 2 天 | 镜像 B 做一遍 |
| D. proto 收口 + 编译通过 | 1 天 | |
| E. 测试 + 压测 + 手动 smoke + 文档 | 3 天 | |
| **总计** | **~12 天(2 周半)** | |

加上 review + 修复反馈,**完整一个 sprint(3 周)** 比较稳。

## 13. 入口示意代码

### 13.1 worker 端 main 改动

```go
// 现在:
//   conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(creds), ...)
//   stream, err := proto.NewPilotServiceClient(conn).Connect(ctx)
//
// 之后:
conn, err := tls.Dial("tcp", target, tlsConfig)
if err != nil { return err }
session, err := yamux.Client(conn, yamuxCfg)
if err != nil { conn.Close(); return err }
defer session.Close()

// Register
regStream, err := session.OpenStream()
if err != nil { return err }
codec := transport.NewCodec(regStream, false)
if err := codec.Write(&proto.StreamHeader{Kind: proto.StreamKind_REGISTER}); err != nil { return err }
if err := codec.Write(&proto.RegisterRequest{ClusterToken: token, ...}); err != nil { return err }
var ack proto.RegisterAck
if err := codec.Read(&ack); err != nil { return err }
regStream.Close()
if !ack.Success { return ErrRegisterRejected }

// 主循环:accept server 推过来的 stream
for {
    s, err := session.AcceptStream()
    if err != nil { return err }  // session 断开
    go handleIncomingStream(s)
}
```

### 13.2 server 端 SendHTTPRequest 改动

```go
// 现在(简化):
//   gw.sendChunkedHTTPRequest(ctx, w, requestID, method, url, headers, body, false)
//   等 g.pendingHTTP[requestID] channel
//
// 之后:
func (g *GatewayServer) SendHTTPRequest(ctx context.Context, clusterID string, req *HTTPRequest) (*HTTPResponse, error) {
    w, ok := g.GetWorker(clusterID)
    if !ok { return nil, errClusterOffline }
    
    stream, err := w.session.OpenStream()
    if err != nil { return nil, err }
    defer stream.Close()  // 自动取消
    
    // 上下文 deadline 自动应用
    stream.SetDeadline(deadlineFromCtx(ctx))
    
    c := transport.NewCodec(stream, true /*gzip*/)
    if err := c.Write(&proto.StreamHeader{Kind: proto.StreamKind_HTTP_REQUEST}); err != nil { return nil, err }
    if err := c.Write(&proto.HTTPRequestStart{Method: req.Method, Url: req.URL, Headers: req.Headers}); err != nil { return nil, err }
    if len(req.Body) > 0 {
        if _, err := c.WriteBytes(req.Body); err != nil { return nil, err }
    }
    stream.CloseWrite()  // 半关,告诉 worker "请求完了,等响应"
    
    var startResp proto.HTTPResponseStart
    if err := c.Read(&startResp); err != nil { return nil, err }
    body, err := c.ReadAllBytes(maxRespBytes)
    if err != nil { return nil, err }
    
    return &HTTPResponse{Status: startResp.Status, Headers: startResp.Headers, Body: body, Error: startResp.Error}, nil
}
```

### 13.3 server 端 SendHTTPRequestStream 改动

```go
func (g *GatewayServer) SendHTTPRequestStream(ctx context.Context, clusterID string, req *HTTPRequest) (*HTTPStream, error) {
    w, ok := g.GetWorker(clusterID)
    if !ok { return nil, errClusterOffline }
    stream, err := w.session.OpenStream()
    if err != nil { return nil, err }
    // 不 defer Close — 调用方负责
    
    c := transport.NewCodec(stream, false /*SSE 已经 text-stream,不再额外 gzip*/)
    if err := c.Write(&proto.StreamHeader{Kind: proto.StreamKind_HTTP_REQUEST}); err != nil { stream.Close(); return nil, err }
    if err := c.Write(&proto.HTTPRequestStart{Method: req.Method, Url: req.URL, Headers: req.Headers, StreamResponse: true}); err != nil { stream.Close(); return nil, err }
    if len(req.Body) > 0 {
        if _, err := c.WriteBytes(req.Body); err != nil { stream.Close(); return nil, err }
    }
    stream.CloseWrite()
    
    var startResp proto.HTTPResponseStart
    if err := c.Read(&startResp); err != nil { stream.Close(); return nil, err }
    
    // HTTPStream wraps the stream's read side. Close 时关 stream(立即向 worker 取消)。
    return &HTTPStream{
        Status:  startResp.Status,
        Headers: startResp.Headers,
        Error:   startResp.Error,
        Body:    stream,                                       // io.Reader,直接给 handler 用
        Close:   func() { _ = stream.Close() },
    }, nil
}
```

handler 用法:
```go
hs, _ := gw.SendHTTPRequestStream(ctx, cluster, req)
defer hs.Close()
io.Copy(c.Writer, hs.Body)  // 直接 copy 字节
```

**对比现在的 chunks channel 模型,代码极大简化。**

### 13.4 worker 端 handleIncomingStream 调度

```go
func handleIncomingStream(s net.Conn) {
    defer s.Close()
    c := transport.NewCodec(s, false) // header 不压缩
    var hdr proto.StreamHeader
    if err := c.Read(&hdr); err != nil { return }
    c.SetGzip(hdr.Gzip)
    
    switch hdr.Kind {
    case proto.StreamKind_RESOURCE_REQUEST:
        handleResource(s, c, hdr.RequestId)
    case proto.StreamKind_HTTP_REQUEST:
        handleHTTP(s, c, hdr.RequestId)
    case proto.StreamKind_PLUGIN_COMMAND:
        handlePluginCommand(s, c, hdr.RequestId)
    case proto.StreamKind_POD_LOGS:
        handlePodLogs(s, c, hdr.RequestId)
    case proto.StreamKind_POD_EXEC:
        handlePodExec(s, c, hdr.RequestId)
    case proto.StreamKind_WS_PROXY:
        handleWSProxy(s, c, hdr.RequestId)
    default:
        log.Printf("[tunnel] unknown stream kind: %v", hdr.Kind)
    }
}
```

## 14. 后续 follow-up(本 PR 不做)

- prometheus metrics 接 yamux session(num streams、bytes in/out、ping rtt)
- 把 `/api/v1/metrics` 调试端点的 transport 字段更新
- 老 proto pkg 在 git tag 上保留一份,文档说明从哪个 commit 之后启用 v2
- 考虑给 yamux session 加 connection-level encryption-at-rest 检查(虽然 TLS 已经覆盖)

## 15. 总结

| 项 | 数值 |
|---|---|
| 代码净减 | ~1700 行 |
| 删掉的 hand-rolled HTTP/2 等价物 | 10-12 项(15 项中)|
| transport 包外部依赖 | `+yamux v0.1.2` |
| proto 复杂度 | 删掉 oneof 包装 + 三组 *Cancel 帧 + chunked 配对 |
| 业务功能 / API 表面变化 | 0(handler 层不感知) |
| 工时 | ~3 周(包含 review + 反馈) |
| 升级方式 | server + worker 一次性同步部署 |
| 性能预期 | 单 RPC 略好,并发 + 大流取消大幅好 |

**核心收益不是性能,是把架构债一次性清掉**,以后新增 streaming endpoint / cancel 语义 / 流式协议变种,都不再需要手搓 transport 层补丁。

---

## 16. 上线后修订(2026-05)

设计稿假设 `yamux.Stream.Close()` 类似 TCP RST —— 一关,对端立刻知道。phase E 的 integration test 把这个假设打穿:**yamux 是 FIN 不是 RST**,半关后对端可以继续写,读端则会收到 `io.EOF`。这条差别贯穿了所有 streaming 路径,逐个补完:

### 16.1 取消语义(关键修订)

| 路径 | 原设计 | 实际 | 修复 |
|---|---|---|---|
| HTTP streaming(`SendHTTPRequestStream`) | server `CloseWrite` 标记 req 体结束 → worker 后续 Read EOF 触发 cancel | server 永不 `CloseWrite` —— 否则 worker 立刻误判为 cancel,response 还没开始就被撤了 | server 不再 `CloseWrite`;worker `handleStreamingResp` 派一个 cancel-watcher goroutine 阻塞读 1 byte,EOF = cancel,触发 upstream HTTP ctx | 
| Logs streaming(`OpenLogsStream`) | 同上 —— server `CloseWrite`,worker 看 Read EOF 退出 | 同样问题:server 早一秒发 FIN 就让 worker 误以为没人想看,kubectl-logs 还没拉就停 | 同样取消 server 端 `CloseWrite`;worker `LogsManager.HandleStream` 加 cancel-watcher,EOF → `cancel()` → `Pods().GetLogs().Stream(ctx)` 的 ctx 撤销 → 读循环 unwind |
| Exec(`OpenExecStream`) | reader goroutine 读 yamux EOF 后只关 stdinW | bash 看 stdin EOF 不会退出 —— SPDY exec 仍在,用户看不到也输不进 | reader goroutine `defer cancel()`,sessCtx 撤销 → `StreamWithContext` 退出 |
| WS(`OpenWSStream`) | reader pump 退出后 conn 还活着;writer pump 继续读上游写"虚空" | yamux 远端关后本端写永远成功(无 RST 反馈),writer pump 黑洞写到 ctx 超时 | reader pump `defer conn.Close()` 让 writer pump 的 `conn.ReadMessage` 立即返错;另发现一个 pre-existing 反向 bug:上游先关时 writer 退出但 reader 还卡在 `st.ReadMsg`,补 `st.Close()` 让两端互通 |

**通用模式(写给未来的我们)**:

```go
// 任何 server-端打开的、worker 端长时阻塞的 yamux stream:
//
// 1. server 端开完 stream + 写完 start 帧 —— 不要 CloseWrite。
//    FIN 是唯一的 cancel 信号,留给真正取消时用。
// 2. worker 端的 HandleStream 派一个 cancel-watcher goroutine:
//
//        ctx, cancel := context.WithCancel(ctx)
//        defer cancel()
//        go func() {
//            buf := make([]byte, 1)
//            _, _ = st.Reader().Read(buf)
//            cancel()
//        }()
//
//    业务逻辑用这个 ctx;Read 返回(任何原因 —— EOF / 错 / 关)
//    都视为 cancel。1 byte 是为了不消化任何真实数据 —— 这条流
//    的 server→worker 方向除了 cancel FIN 不会再写东西。
// 3. server 端 stream wrapper 的 Close 是真正的 cancel —— consumer
//    `defer stream.Close()` 在 HTTP handler 返回时撤销 yamux 流。
```

### 16.2 测试覆盖

phase E 加了 `pkg/server/gateway/integration_test.go` —— 5 个跑在 `net.Pipe` yamux pair 上的端到端测试:

| 用例 | 覆盖 |
|---|---|
| `TestIntegrationRPCRoundtrip` | 普通 RPC 编解码 + worker 响应 |
| `TestIntegrationStreamCancelPropagates` | server 关 stream,worker cancel-watcher 触发(就是这个用例打穿了原设计) |
| `TestIntegrationConcurrentRPCs` | 100 个并发 RPC 各自隔离 |
| `TestIntegrationLargeResponse` | 4 MiB 单响应跨 yamux flow-control window |
| `TestIntegrationDisconnectCleansSessions` | session 关 → 所有 in-flight call 立即收到错误 |

`-race` 跑通,无 leak。

### 16.3 哨兵帧的语义(集中文档化)

phase D review 发现"一条 yamux stream 上多种消息类型靠哨兵 0-payload 帧切换"的契约散在多个文件里。统一搬到 `pkg/server/gateway/stream.go` 的 package doc(去 grep `Sentinel discriminator (Worker contract)`),covers LogsChunk / ExecOutput / WSFrame / PluginLogChunk 四处。新增 streaming endpoint 用同样套路时遵这套约定即可,不要再造新的 oneof 包装。

### 16.4 性能实测(Apple M1 loopback)

| 用例 | 指标 |
|---|---|
| 普通 RPC | 79–82 µs/op |
| HOL(并发大流 + 小请求) | 188–209 µs/op |
| Stream cancel | 15–17 µs/op |
| 每流内存 | ~10 KB |

跨境实测 T4(深圳→腾讯云)端到端 latency 与 v1 大致持平(网络是瓶颈而非协议),但**取消时间从"客户端 Stop 到 worker 真正停 upstream"由 v1 的 ~5 min 降到 sub-second**(原 lazy detection 等到 per-write deadline 才发现 client 走了)。

### 16.5 没做的(刻意留下)

- yamux session 级 prometheus metrics —— 仍在第 14 节的 follow-up 里,不在 P-Transport-v2 范围
- v1 / v2 灰度切换协议协商 —— 设计稿第 11 节就说不做,实际验证一次性切换 OK
- 替换 worker dial 时的 TLS 配置(还是裸 TCP + 应用层 token);未来如果跨 untrusted 网络再加 TLS

### 16.6 一句话给后来者

> 用 yamux 不是为了快,是为了不再手搓 HTTP/2 的多流特性。FIN 不是 RST 这件事是 P-Transport-v2 上线时唯一翻车的设计假设,补 cancel-watcher 模式后再无类似问题。

