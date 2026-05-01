# KPilot

**A Kubernetes-native GPU orchestration pilot.**

核心架构：Server（中心控制面）+ Worker（集群侧 Operator），通过 gRPC 双向流连接。

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
  │  client-go
  ▼
K8s Cluster
```

---

## Worker 注册流程

1. 管理员在 Server UI 创建集群条目
2. Server 生成唯一 ClusterToken
3. 管理员使用 Server 生成的 YAML（内嵌 ClusterToken + Server gRPC 地址）在目标集群部署 Worker
4. Worker 启动，携带 Token 发起 gRPC 连接
5. Server 验证 Token，将连接与集群绑定，标记集群 Online

---

## gRPC 协议

单条双向流，用 `request_id` 实现请求-响应配对，同时支持 Worker 主动 Push。

**Worker → Server（WorkerMessage）：**
- `Register`（携带 Token）
- `Heartbeat`
- `NodeListPush`（周期性主动上报节点信息）
- `ResourceListResponse / ResourceGetResponse / ResourceApplyResponse / ResourceDeleteResponse`
- `PluginStatusPush`

**Server → Worker（ServerMessage）：**
- `RegisterAck`
- `ResourceList / ResourceGet / ResourceApply / ResourceDelete` 请求
- `PluginEnable / PluginDisable` 命令

两种通信模式：
- **Push**：Worker 周期性上报（`request_id` 为空）
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
| 插件 | 用途 |
|------|------|
| HAMI | GPU 虚拟化，给 Node 打 GPU 标签，支持 vGPU 管理 |
| VictoriaMetrics | 集群监控 |
| VictoriaLogs | 容器日志收集 |
| Gateway | 网关（暂定） |
| KServe | 模型推理服务（暂定） |

---

## 功能模块

### 1. 集群管理
- 创建集群条目，生成 Worker 部署 YAML（含 Token）
- 查看集群列表、在线状态、基本信息

### 2. 节点概览
- 展示集群所有节点信息
- 数据来源：Worker 读取 K8s Node 对象（标准字段 + HAMI 写入的 GPU 标签）
- 字段：CPU（已用/总量）、内存（已用/总量）、GPU 型号、GPU 数量

### 3. 工作负载管理
- 通过 Worker 代理 K8s API，支持完整 CRUD
- P0 资源：Deployment、StatefulSet、DaemonSet、Pod、Service、ConfigMap、Secret、Ingress

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
│   │   ├── api/             # HTTP 路由 + Handler（Gin）
│   │   ├── service/         # 业务逻辑层
│   │   ├── store/           # PostgreSQL CRUD（GORM）
│   │   └── gateway/         # gRPC Server 端逻辑
│   ├── worker/
│   │   ├── controller/      # K8s Controller（监听 Plugin CRD 等）
│   │   ├── collector/       # 节点信息采集上报
│   │   ├── proxy/           # K8s 资源代理
│   │   └── tunnel/          # gRPC Client 端逻辑
│   └── common/
│       ├── proto/           # protobuf 生成代码（不手动编辑）
│       └── types/           # 共享类型
├── proto/                   # .proto 源文件
├── web/                     # 前端（Ant Design Pro，React + TypeScript）
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
| 前端 | React + TypeScript + Ant Design Pro |

---

## 开发阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| P1 | 项目脚手架 + Proto 设计 + gRPC 连接/注册 + PostgreSQL schema | 待开始 |
| P2 | 集群管理 UI + 节点概览（Worker 采集上报） | 待开始 |
| P3 | 工作负载管理（K8s 资源 CRUD 代理） | 待开始 |
| P4 | 插件系统（CRD + Helm + 状态同步） | 待开始 |
| P5 | GPU 管理（HAMI 集成） | 待开始 |
| P6 | 监控中心 + 日志中心 | 待开始 |
| P7 | 模型管理（LLM + KServe） | 待开始 |
