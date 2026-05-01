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
- 工具栏：命名空间筛选、手动刷新 + 定时刷新（5s/10s/30s/60s）
- kube-* 命名空间只读（前端隐藏操作按钮，后端返回 403）
- YAML 编辑器：CodeMirror 6，有语法高亮，status 区块视觉变暗（不可改）

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
  pollingInterval: 10000,
  formatResult: (res) => res,
});
```
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
│   │   ├── ClusterLayout.tsx    # 集群详情侧边栏布局
│   │   ├── Nodes/               # 节点概览
│   │   └── Workloads/           # 工作负载（含 YamlEditor）
│   └── exception/404/           # 404 页
├── services/kpilot/             # API 服务（auth.ts、cluster.ts、node.ts、workload.ts）
├── components/                  # 公共组件（Footer、LangDropdown、AvatarDropdown）
├── locales/                     # zh-CN / en-US（menu.ts、pages.ts）
└── app.tsx                      # 全局布局、认证初始化
```

### 工作负载页关键设计说明

- **Table API**：`listWorkloads` 使用 `Accept: application/json;as=Table;v=v1;g=meta.k8s.io`，Worker 的 `proxy.listTable` 通过 `rest.HTTPClientFor(cfg)` 构建带认证的 HTTP 客户端直接请求 K8s API Server。`includeObject=Metadata` 确保只传输元数据。
- **列定义**：前端动态解析 Table API 的 `columnDefinitions`，所有列（含 priority>0 wide 列）均展示。列名通过 `COL_I18N` 映射到 i18n key。
- **集群级资源**：`CLUSTER_SCOPED` 集合（目前含 `persistentvolumes`）控制是否显示命名空间列和命名空间筛选器。
- **错误透传**：K8s 操作失败用 `apiErrWorker`（HTTP 400，code=WORKER_ERROR，message=K8s 原始错误），区别于服务器内部错误（500）。

---

## 开发阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| P1 | 项目脚手架 + Proto 设计 + gRPC 连接/注册 + PostgreSQL schema + JWT 认证 | ✅ 完成 |
| P2 | 集群管理 UI + 节点概览（Worker 采集上报） | ✅ 完成 |
| P3 | 工作负载管理（K8s 资源 CRUD 代理） | ✅ 完成 |
| P4 | 插件系统（CRD + Helm + 状态同步） | 待开始 |
| P5 | GPU 管理（HAMI 集成） | 待开始 |
| P6 | 监控中心 + 日志中心 | 待开始 |
| P7 | 模型管理（LLM + KServe） | 待开始 |
