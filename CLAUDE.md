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
- `Register`（携带 Token）
- `Heartbeat`
- `NodeListPush`（Node 变更事件驱动上报；重连注册成功后立即推送一次全量）
- `ResourceListResponse / ResourceGetResponse / ResourceApplyResponse / ResourceDeleteResponse`
- `PluginStatusPush`

**Server → Worker（ServerMessage）：**
- `RegisterAck`
- `ResourceList / ResourceGet / ResourceApply / ResourceDelete` 请求
- `PluginEnable / PluginDisable` 命令

两种通信模式：
- **Push**：Worker 主动上报（`request_id` 为空），由事件驱动（如 Node 变更）或重连触发
- **Request-Response**：Server 带 `request_id` 发请求，Worker echo 回去

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

**支持的插件：**

| 插件            | 用途                                   |
|-----------------|----------------------------------------|
| HAMI            | GPU 虚拟化，给 Node 打 GPU 标签，支持 vGPU 管理 |
| VictoriaMetrics | 集群监控                               |
| VictoriaLogs    | 容器日志收集                           |
| Gateway         | 网关（暂定）                           |
| KServe          | 模型推理服务（暂定）                   |

---

## 功能模块

### 1. 集群管理
- 创建集群条目，生成并展示 ClusterToken（仅创建时显示一次）
- 查看集群列表（名称、在线状态、描述、创建/更新时间）
- 编辑集群名称和描述
- 重新生成 Token（旧 Token 立即失效）
- 删除集群

### 2. 节点概览
- 展示集群所有节点信息
- 数据来源：Worker 读取 K8s Node 对象（标准字段 + HAMI 写入的 GPU 标签）
- 字段：CPU（可分配/总量）、内存（可分配/总量）、GPU 型号、GPU 数量

### 3. 工作负载管理
- 通过 Worker 代理 K8s API，支持完整 CRUD（列表、查看 YAML、编辑、删除）
- 工作负载：Deployment、StatefulSet、DaemonSet、Pod
- 网络：Service、Ingress
- 存储：PersistentVolumeClaim、PersistentVolume（集群级，无命名空间）
- 配置：ConfigMap、Secret
- 列表使用 K8s Table API（同 kubectl 默认展示，server 端计算列，仅传输元数据+单元格值，不传输完整 YAML）
- 展示全部列（含 wide 列，等价于 `kubectl -o wide`）
- 服务端游标分页（limit + continue token），支持前后翻页
- 工具栏：手动刷新 + 定时刷新（5s/10s/30s/60s）
- 全局命名空间选择器（顶部栏，进入工作负载相关页面时显示，PV 页面自动隐藏；按集群独立保存；支持客户端搜索 + 刷新）
- kube-* 命名空间只读（前端隐藏操作按钮，后端返回 403）
- YAML 编辑器：CodeMirror 6，有语法高亮，status 区块视觉变暗（不可改）
- **通用 Apply YAML**：用户输入或拖拽上传 .yaml/.yml/.json，支持多文档 `---` 分隔，每条独立 SSA，返回逐条结果（成功/失败 + 错误消息）
- **资源详情（Describe）**：所有工作负载操作栏带"详情"按钮，调用 `k8s.io/kubectl/pkg/describe` 输出与 `kubectl describe` 一致的文本，前端做最小化高亮（key 着色 + Events Type Normal/Warning 着色）
- **Pod 日志**：WebSocket 流式 follow，可选容器、tail 行数（100/500/1000/5000）、previous 实例；前端 rAF 节流避免高吞吐场景的渲染抖动
- **Pod 终端（Exec）**：xterm.js + FitAddon，Worker 端默认 `/bin/bash`，不存在自动回退 `/bin/sh`；二进制 WS 帧（首字节为类型）

### 4. 插件管理
- 查看可用插件列表及安装状态
- 启用/禁用插件，配置插件参数

### 5. GPU 管理
- 依赖 HAMI 插件
- 管理 vGPU 分配，查看 GPU 使用详情（已分配/总量算力、显存）

### 6. 模型管理
- LLM 部署管理（创建/查看/删除推理服务）
- 后续结合 KServe

### 7. 监控中心
- 代理查询 VictoriaMetrics（依赖 VictoriaMetrics 插件）

### 8. 日志中心
- 代理查询 VictoriaLogs（依赖 VictoriaLogs 插件）

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
│   │   │   ├── handler/     # Gin Handler（auth、cluster、node、workload）
│   │   │   ├── middleware/  # JWT 中间件
│   │   │   └── router.go    # 路由注册
│   │   ├── service/         # 业务逻辑层（待实现）
│   │   ├── store/           # PostgreSQL CRUD（GORM）
│   │   └── gateway/         # gRPC Server 端（Worker 连接管理、节点缓存）
│   ├── worker/
│   │   ├── controller/      # K8s Controller（Plugin CRD 等，待实现）
│   │   ├── collector/       # 节点信息采集（controller-runtime Watch）
│   │   ├── proxy/           # K8s 资源代理（Table API list、get、apply、delete）
│   │   └── tunnel/          # gRPC Client（注册、心跳、消息收发）
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
| `ADMIN_USERNAME` | `admin` | 管理员用户名 |
| `ADMIN_PASSWORD` | `admin123` | 管理员密码 |
| `JWT_SECRET` | 随机 | JWT 签名密钥，未设置则每次重启失效 |
| `CORS_ORIGINS` | 空（开发宽松模式） | 生产环境设置前端域名，逗号分隔，如 `https://kpilot.example.com` |

### gRPC 配置
- Server 最大消息收发均为 **32 MB**（默认 4 MB 不够大集群 Table API 响应）

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

### gRPC 与 Worker 通信
- **gRPC stream 写入必须串行化**：`grpc.ClientStream` / `grpc.ServerStream` 的 `Send` 不是并发安全的。Server 端用 `ConnectedWorker.sendMu`，Worker 端用 `Client.sendMu`。任何并发 Send 都要先拿锁
- **一次性请求-响应**（list/get/apply/delete K8s 资源）：用 `gateway.SendResourceRequest(ctx, clusterID, req)`，内部按 request_id 注册 pending channel，超时由 ctx 控制
- **流式会话**（Pod 日志 / exec）：用 `gateway.OpenStream(clusterID)` 拿到 `*Stream`，`Stream.Send(payload)` 写、`<-Stream.Recv()` 读、`Stream.Close()` 关。Stream 的 send-on-closed 防御已在 `Stream.deliver` 内做了 closeMu 保护，**新增流类型时套这个模式**
- **Worker 断开时**：gateway `unregister` 会自动 `closeClusterStreams` 清理所有该集群的活跃 stream，WS handler 会从 `<-stream.Recv()` 拿到 `ok=false` 退出

### K8s 资源代理（Worker 端）
- **列表**：用 K8s Table API（`Accept: application/json;as=Table;v=v1;g=meta.k8s.io`），仅传元数据 + 单元格值，不传完整 spec/status
- **写入**：用 Server-Side Apply（`Patch` + `ApplyPatchType`，`fieldManager=kpilot`，`force=true`），**不要用 Update**——SSA 幂等且无需携带 resourceVersion，避免并发 409
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

### CORS
- 白名单制，从 `cfg.CORSOrigins` 读取
- 空列表 = dev 模式（任意 origin），生产必须显式设置
- 永远带 `Access-Control-Allow-Credentials: true`（前端依赖 cookie）

### 包组织
```
pkg/
├── server/
│   ├── api/
│   │   ├── handler/   # gin handler，纯 HTTP 转换层，不写业务
│   │   ├── middleware/# JWT 等
│   │   └── router.go
│   ├── service/       # 业务逻辑（待补充，目前 handler 直接调 store + gateway）
│   ├── store/         # GORM CRUD，纯数据库
│   └── gateway/       # gRPC server + Worker 连接管理 + stream 路由
├── worker/
│   ├── proxy/         # K8s 资源代理 + logs/exec manager
│   ├── collector/     # 节点信息采集（controller-runtime watch）
│   └── tunnel/        # gRPC client + 心跳 + 消息分发
└── common/
    ├── proto/         # protoc 生成，不手动编辑
    └── types/         # 跨包共享类型
```

handler 不直接写 SQL / 不调 K8s API，所有外部依赖通过 store / gateway 接入。

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
│   ├── Clusters/                # 集群管理
│   ├── ClusterDetail/
│   │   ├── Nodes/               # 节点概览
│   │   └── Workloads/           # 工作负载（含 YamlEditor）
│   ├── Plugins/                 # 插件管理（占位）
│   └── exception/404/           # 404 页
├── services/kpilot/             # API 服务（auth.ts、cluster.ts、node.ts、workload.ts）
├── components/                  # 公共组件（Footer、LangDropdown、AvatarDropdown）
├── locales/                     # zh-CN / en-US（menu.ts、pages.ts）
├── global.less                  # 全局样式 + ProLayout CSS 覆盖
└── app.tsx                      # 全局布局、动态菜单注入、认证初始化
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
- **编辑（Apply）**：使用 K8s **Server-Side Apply**（`Patch` + `ApplyPatchType`，`fieldManager=kpilot`，`force=true`），幂等、无需携带 `resourceVersion`，不会因并发更新产生 409 冲突。
- **错误透传**：K8s 操作失败用 `apiErrWorker`（HTTP 400，code=WORKER_ERROR，message=K8s 原始错误），区别于服务器内部错误（500）。
- **通用 Apply YAML**：`POST /api/v1/clusters/:id/apply`，body 是纯文本（`Content-Type: text/plain`）。Server 端用 `apimachinery/pkg/util/yaml.NewYAMLOrJSONDecoder` 流式解析多文档，逐条提取 GVK + name + namespace 后走与单资源相同的 SSA 通道。响应 `{results: [...]}` 一份文档一条结果，前端按 `success` 渲染部分失败。
- **Describe**：Worker 端走 `k8s.io/kubectl/pkg/describe` 的 `DescriberFor(GVK.GroupKind(), cfg)`（`ShowEvents: true`），返回纯文本经 gRPC 透传给 Server，再以 `text/plain` 返回前端。前端只做两类高亮：行内 `key:` 着色（lookahead 排除 taint 表达式如 `node.kubernetes.io/unreachable:NoExecute`），Events 段内 Type 列 Normal/Warning 着色。
- **Pod 日志**：WS 端点 `/api/v1/clusters/:id/workloads/pods/:name/logs`。Server 通过 `gateway.OpenStream` 拿 sessionID 双向流，发 `LogsStartRequest` 给 Worker；Worker 用 `clientset.CoreV1().Pods(ns).GetLogs(...).Stream(ctx)` 4 KiB chunk 转发，EOF 发 `LogsEnd`。前端用 rAF 批量 flush 行缓冲，避免每条消息触发 React re-render。
- **Pod 终端（Exec）**：WS 端点 `/api/v1/clusters/:id/workloads/pods/:name/exec`，二进制帧首字节为类型（client→server: 0=stdin / 1=resize JSON；server→client: 1=stdout / 2=stderr / 3=end）。Worker 端 `ExecManager` 维护 sessionID → `{cancel, stdinW, resizeCh, closed, closeMu}`，dispatcher handler 必须快返回（实际 IO 在管理器 goroutine 里做）。Shell 选择由 Worker 决定：先探测 `/bin/bash`，不存在静默回退 `/bin/sh`，前端无须传参。

---

## 开发阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| P1 | 项目脚手架 + Proto 设计 + gRPC 连接/注册 + PostgreSQL schema + JWT 认证 | ✅ 完成 |
| P2 | 集群管理 UI + 节点概览（Worker 采集上报） | ✅ 完成 |
| P3 | 工作负载管理（CRUD 代理 + 通用 Apply YAML + Describe + Pod 日志/终端 + 全局命名空间选择器） | ✅ 完成 |
| P4 | 插件系统（CRD + Helm + 状态同步） | 待开始 ← 下一步 |
| P5 | GPU 管理（HAMI 集成） | 待开始 |
| P6 | 监控中心 + 日志中心 | 待开始 |
| P7 | 模型管理（LLM + KServe） | 待开始 |
