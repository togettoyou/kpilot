# 集群管理（`/clusters`）

> 上层文档：[CLAUDE.md](../CLAUDE.md)。本文档覆盖通用 K8s 管理面板的全部子页面。

通用 K8s 管理面板，不做 GPU / 模型相关的特殊化。

## 1. 集群列表（`/clusters`）

- 卡片网格 UI，每张卡显示集群状态 + 描述，整体可点 → 进入 K8s 详情
- 顶部 KPI 统计：总集群 / 在线 / 离线
- `tabular-nums` 防 10s 轮询时数字宽度抖动
- 卡片右上角 `...` Dropdown：编辑 / 重新生成 Token / 删除
- 删除集群级联清 `cluster_plugins` 行（事务，避免 FK 孤悬）
- 排序按 `created_at asc`，新加的不挤掉已有位置（用户按空间记忆）

## 2. 节点概览（`/clusters/:id/nodes`）

- 走通用 workloads proxy（`/workloads/nodes`，K8s Table API）
- 列定义直接来自 kubectl printer：NAME / STATUS / ROLES / AGE / VERSION / INTERNAL-IP / EXTERNAL-IP / OS-IMAGE / KERNEL-VERSION / CONTAINER-RUNTIME（跟 `kubectl get node -o wide` 对齐）
- STATUS 列识别 `Ready,SchedulingDisabled` 这种 kubectl 拼接格式，每段一个色 Tag
- ROLES 列 comma-split，每个角色单独 Tag
- COL_I18N map 把英文 printer header 翻译到 zh-CN
- **行操作四个按钮**：
  - **详情** → 调 describe，DescribeDrawer 显示文本 dump（事件、conditions、allocated 等）
  - **概览** → NodeDetailDrawer 结构化卡片：基本/网络/调度/资源/conditions/labels/annotations
  - **查看** → NodeYamlDrawer 只读 YAML
  - **禁用调度 / 启用调度** → cordon/uncordon
- **Node 写操作收敛到专用端点**：`POST /workloads/nodes/:name/cordon` body 仅 `{cordon: bool}`，Server 端构造 strategic merge patch `{"spec":{"unschedulable":<bool>}}`，客户端无法注入其他字段
- **通用 PUT/DELETE 对 Node 一律返回 403 NODE_PROTECTED**——Edit YAML 修改 Node 风险过高，scoped action 是唯一写入路径

## 3. 工作负载（`/clusters/:id/workloads/:type`）

- 通过 Worker 代理 K8s API，支持完整 CRUD
- **菜单分组**：
  - 工作负载：Deployment / StatefulSet / DaemonSet / ReplicaSet / Pod / Job / CronJob / HPA
  - 网络：Service / EndpointSlice / Ingress / NetworkPolicy / GatewayClass / Gateway / HTTPRoute / GRPCRoute
  - 存储：PVC / PV / StorageClass
  - 配置：ConfigMap / Secret
  - 安全：ServiceAccount / Role / RoleBinding / ClusterRole / ClusterRoleBinding（RBAC 全套）
  - 策略：ResourceQuota / LimitRange / PodDisruptionBudget / PriorityClass / RuntimeClass（GPU / AI 调度场景下 PriorityClass + RuntimeClass 跟 Volcano 联动）
  - 扩展：CRD + DRA + 准入控制。DRA 子组含 ResourceClaim / ClaimTemplate / DeviceClass / ResourceSlice。准入控制子组含 ValidatingWebhookConfiguration / MutatingWebhookConfiguration / ValidatingAdmissionPolicy（K8s 1.30 GA）。三级嵌套缩进较深，全局 `siderWidth=220`（默认 208 会截断中文标签）
- **集群级资源**：`CLUSTER_SCOPED_TYPES`（`web/src/services/kpilot/workload.ts`）包含 `persistentvolumes` / `storageclasses` / `gatewayclasses` / `deviceclasses` / `resourceslices` / `customresourcedefinitions` / `clusterroles` / `clusterrolebindings` / `priorityclasses` / `runtimeclasses` / `validatingwebhookconfigurations` / `mutatingwebhookconfigurations` / `validatingadmissionpolicies` / `nodes`。这些资源的命名空间列与顶部 NamespacePicker 自动隐藏
- **DRA**：`resource.k8s.io/v1`（GA since K8s 1.34）。OrbStack 等发行版默认未开启 DRA feature gate，请求返回 `no matches for kind`；与 Gateway API 未安装 CRD 时为同款 graceful degradation
- 列表使用 K8s Table API（与 kubectl 默认展示一致），server 端计算列，仅传输元数据 + 单元格值
- 展示全部列（含 wide 列，等价于 `kubectl -o wide`）
- 服务端游标分页（`limit + continue` token）
- 工具栏：当前页客户端搜索（name + namespace + 所有动态列子串匹配）、手动刷新 + 定时刷新（5s/10s/30s/60s）
- **全局命名空间选择器**（顶部栏）：namespace-scoped 工作负载页面显示；cluster-scoped 资源自动隐藏；按集群独立保存；默认"全部命名空间"
- YAML 编辑器：CodeMirror 6，语法高亮，status 区块视觉变暗
- **编辑（kubectl-edit 语义）**：单条编辑使用 PUT（dynamic.Update），body 携带 `metadata.resourceVersion`；并发修改返回 409 → 前端展示 `WORKER_CONFLICT`
- **通用 Apply YAML 抽屉**：用户输入或拖拽 .yaml/.yml/.json，多文档以 `---` 分隔。两个按钮：
  - **应用**（POST `/apply`）：每条文档 SSA（`apply` action），kubectl-apply 语义
  - **删除**（POST `/delete-yaml`）：按 GVK + name + namespace 调用 `delete` action，kubectl-delete-f 语义；带 modal.confirm 二次确认
  - 失败列表支持「展开/收起」+ `maxHeight: 240px overflowY:auto`
  - 同款保护规则在 `validateDoc` 中基于解析 GVK 拦截（含 Node）
- **资源详情（Describe）**：操作栏「详情」按钮调用 `k8s.io/kubectl/pkg/describe`：内置 kind 走 `DescriberFor`（字段语义感知）；CRD/CR fallback 到 `GenericDescriberFor`。前端做最小化高亮（key 着色 + Events Type Normal/Warning 着色）
- **CR 实例浏览器**（CRD 行「查看实例」 → `/workloads/_cr?group=...&version=...&kind=...&scope=...`）：
  - 复用 WorkloadsContent，dynamic GVK 通过 URL query 传递，Worker 使用 `dynamic.Interface` + RESTMapper 解析
  - CRD 版本选择优先 storage version，否则首个 served version，最后 versions[0]
  - 标题 = Kind + 灰色 group/version 副标题，左侧带图标返回按钮
  - **菜单状态保持**：`/workloads/_cr` 在 `app.tsx buildClusterSubMenu` 注册为 CRDs 菜单的 `hideInMenu: true` 子路由
- **Pod 日志**：WebSocket 流式 follow，可选容器、tail 行数（100/500/1000/5000）、previous 实例；前端 rAF 节流避免高吞吐场景的渲染抖动；内置客户端 grep（200ms 防抖，字符串 / 正则双模式，匹配高亮 + "匹配 X / 共 Y 行" 计数）
- **Pod 终端（Exec）**：xterm.js + FitAddon，Worker 端默认 `/bin/bash`，不存在时自动回退 `/bin/sh`；二进制 WS 帧（首字节为类型）
- **Pod 即时指标**：Pods 行操作栏「指标」按钮 → `GET /api/v1/clusters/:id/pods/:namespace/:name/top`，Server 拉 `metrics.k8s.io/v1beta1 PodMetrics` 转成 `{containers: [{name, cpu_milli, memory_bytes}]}`。Drawer 5s 自动刷新；"no matches for kind PodMetrics" 与 "podmetrics ... not found" 都翻译成 404 / `RESOURCE_NOT_AVAILABLE`，前端显示「请确认 Metrics Server 插件已启用」+ 跳插件管理。**路由用 `/pods/...` 前缀而非 `/workloads/pods/...`**，避免 Gin v1.12 的 GET radix 树静态段 `pods` 抢走 `:type` 通配的所有 `/workloads/pods/...` 流量

### 写操作 protection（基于已解析 GVK）

关键：**所有 protection 检查必须基于解析后的 GVK，不能依赖 URL `:type` 段**——`_cr` URL 可以指向任意 GVK，仅靠 `:type` 判断会被绕过。

五道闸门（在 `ApplyWorkload` PUT、`DeleteWorkload` DELETE、`validateDoc` 批量 YAML 三处统一应用）：

| 检查 | 触发条件 | 返回码 |
|---|---|---|
| `isProtectedNamespace(ns)` | namespace 以 `kube-` / `kpilot-` 开头 | 403 / `NAMESPACE_PROTECTED` |
| `isProtectedCRDDefinitionGVK(gvk, name)` | `apiextensions.k8s.io/v1 CRD` + `*.kpilot.io` 名 | 403 / `CRD_PROTECTED` |
| `isProtectedCRGroup(gvk.group)` | group `kpilot.io` 或 `*.kpilot.io` | 403 / `CRD_PROTECTED` |
| `isNoGenericWriteGVK(gvk)` | core `Node`（cordon 走专用端点） | 403 / `NODE_PROTECTED` |
| `isProtectedSystemNameGVK(gvk, name)` | RBAC `system:*` ClusterRole / ClusterRoleBinding，或 `system-*` PriorityClass | 403 / `SYSTEM_PROTECTED` |

Scoped action 端点的安全模式：
- 路径：`POST /api/v1/clusters/:id/workloads/<kind>/:name/<action>`
- Body：业务字段（如 `{cordon: bool}`），**不接受任意 patch / spec body**
- Server 端构造 patch JSON（如 `{"spec":{"unschedulable":<bool>}}`），通过 gRPC 下发 Worker
- Worker 通过 `patch` action（StrategicMergePatchType）应用

### K8s 资源代理（Worker 端）

- **列表**：用 K8s Table API（`Accept: application/json;as=Table;v=v1;g=meta.k8s.io`），仅传元数据 + 单元格值
- **GVK 来源**：server handler 的 `resolveGVK(c)` 把 URL `:type` 解析成 GVK：
  - 内置 kind：从 `resourceGVK` 白名单查
  - `_cr` 哨兵：从 query param `?group=&version=&kind=` 拿
  - 一处加 GVK 全部联通；新增内置 kind 加进 `resourceGVK` map 即可
- **资源客户端选择**（worker `proxy.resourceClient(mapping, namespace)`）：根据 `mapping.Scope` 自动决定 namespace-scoped 还是 cluster-scoped 路径。namespace-scoped + 空 namespace → fallback 到 `"default"`
- **写动作语义**（按用户意图选）：
  - `update`（PUT，dynamic.Update）—— **单条 Edit YAML 保存**（kubectl-edit）。body 必须含 `metadata.resourceVersion`，K8s 拒绝过期版本（409 conflict）
  - `apply`（Patch + ApplyPatchType，SSA，`fieldManager=kpilot`，`force=true`）—— **批量 Apply YAML 抽屉**（kubectl-apply 语义）。无需 resourceVersion，幂等
  - `patch`（Patch + StrategicMergePatchType，`fieldManager=kpilot`）—— **scoped 操作**（如 cordon），Server 端构造 patch body，客户端无法注入其他字段
  - `delete`（dynamic.Delete）—— Apply YAML 抽屉的删除按钮也走该 action
- **Describe**：优先 `describe.DescriberFor(gk, cfg)`（内置 kind 走专用 describer）；返回 `(nil, false)` 时 fallback 到 `describe.GenericDescriberFor(mapping, cfg)`（与 kubectl 自身的 fallback 一致）。kubectl 历史上对畸形 unstructured 有 panic 案例，所以 `describe()` 用命名返回 + `defer recover()` 把 panic 转成 fail 响应而不是杀 worker
- **RESTMapper 缓存**：controller-runtime 的 `apiutil.NewDynamicRESTMapper` 自带 `lazyRESTMapper`，遇到 `meta.NoMatchError` 会自动 reload + retry 一次。新安装 CRD 后首次查询 GVK 时自动刷新
- **操作超时拆分**：`readWorkerTimeout=120s`（list / get / describe / list-full）vs `writeWorkerTimeout=30s`（apply / update / patch / delete / cordon）。读路径放宽是因为大集群的 describe + 大 CRD list 在 30s 下经常 ctx.Err()；写路径保持紧因为它是有副作用的，admission webhook 卡住要尽快退出。Server handler 与 Worker proxy 两端用同一组数值，避免一端先放弃浪费另一端的工作
- **HTTP/WS 反代 URL scheme 校验**：`HTTPProxy.do` 和 `WSManager.Start` 入口校验 `req.Url` 必须是 http/https（WS 还允许 ws/wss），是防御纵深 —— Server 今天构造 FQDN 不会出问题，但 future regression 不应让 Worker 去 dial unix:// / file://
- **流式**（logs/exec/反代 WS）：分别由 `LogsManager` / `ExecManager` / `WSManager` 维护 sessionID → cancel func / pipe / chan 的映射，分发器的 stdin/resize/cancel handler 必须**快返回**。session ctx 派生自 `tunnel.Client.StreamContext()`，tunnel 断开时一并 cancel —— 不会等到下次 Send 失败才退出。Pod 日志另有 `maxLogBytes=64 MiB` 累计字节封顶，超过即 LogsEnd 关掉（chatty pod 长 follow 不会无限堆）；exec writer 写 tunnel 失败时调 onSendErr cancel 整个 session，避免 SPDY executor 在 Server 收不到的情况下继续跑用户 shell

## 4. 集群侧插件（`/clusters/:id/plugins`）

- 全局插件注册表的只读视图，每张卡片显示该集群上的 phase（Loading 转圈 / Running 绿勾 / Failed 红叉）
- 点击「启用」打开 drawer，可改 `version` 与 `values`；命名空间不可改（详见 [docs/plugins.md](plugins.md)）
- 详细启用机制见 [docs/plugins.md](plugins.md)

## 5. 监控 / 日志（`/clusters/:id/monitoring` `/clusters/:id/logging`）

- 共享 `web/src/components/GrafanaEmbed/`，区别只在依赖列表 + dashboard UID + i18n 前缀
- **依赖检查**：拉 `/api/v1/clusters/:id/plugins`，按 phase 分四桶（ready / installing / failed / missing）。allReady → 渲染 iframe；其他状态显示 antd `Result`，installing 期间每 5s 自动 poll
- **iframe URL**：`/api/v1/clusters/:id/proxy/grafana/d/<dashboardUID>/?theme=light|dark`
- **主题同步**：KPilot 切主题 → effect 读 `iframe.contentWindow.location.href`（同源） → 改 `?theme=` 参数 → 写回 `iframe.src`
- **滚动隔离**：iframe 内部 document（同源）的 `documentElement` 和 `body` 注入 `overscroll-behavior: contain`
- **Worker 反代后端**（`pkg/server/api/handler/proxy.go`）：HTTP 请求/响应走 `SendHTTPRequest`，WebSocket 走 `OpenStream`（复用 Pod logs/exec 的 Stream 框架）。`proxiableServices` map 是反代白名单（目前只 grafana）
- **认证链**：浏览器带 KPilot JWT → Server JWT middleware 验证 → `resolveUsername(c)` 提取用户名 → 反代时 inject `X-WEBAUTH-USER` → Grafana auth.proxy 自动建用户登录（`auto_sign_up=true`，role=Viewer 只读）
- **`proxyResolveCache`**（30s TTL）：缓存 `(cluster, plugin) → (release_namespace, Phase=Running)`，避免每个反代请求都 3 次 DB 查
- **Grafana 配置要点**（`pkg/server/store/seed.go::Grafana`）：
  - `auth.proxy` 启用 + auto_sign_up + Viewer 角色
  - `serve_from_sub_path=true` + 相对 root_url 带 `${KPILOT_CLUSTER_ID}` 占位符
  - `[security] allow_embedding=true`
  - `[live] allowed_origins="*"` 让 Grafana Live WS 接受 KPilot 域 Origin
  - 预配 VictoriaMetrics（type=prometheus）+ VictoriaLogs（type=`victoriametrics-logs-datasource`，自动从 grafana.com 装 plugin）
- **dashboard UID**：monitoring=`rYdddlPWk`（NodeExporterFull）、logging=`g6mvjz`（VL Explorer K8S）

## 集群详情导航（动态菜单）

- `app.tsx` 在 `@@initialState` 里跟踪 `currentClusterId`，`onPageChange` 监听 location 变化更新它
- `extractClusterId(pathname)` 同时识别 `/clusters/:id` 与 `/compute/:id`，单一 `currentClusterId` 状态驱动两个平台的 sider sub-menu 注入
- `menuDataRender` 读 `currentClusterId`，有值就调用 `buildClusterSubMenu(id)` / `buildComputeSubMenu(id)` 注入子菜单
- ProLayout 配置：`splitMenus: true`（顶栏只显示一层）+ `suppressSiderWhenMenuEmpty: true`（无子菜单时侧边栏自动隐藏）+ `siderWidth: 220`（默认 208 在三级嵌套下截字）
- 菜单 i18n：name 字段会自动拼接父级 locale → `menu.{parent}.{name}`
- `menuItemRender` 始终用 `<Link>` 包裹 `defaultDom`，避免 Umi 默认实现给选中项跳过 Link 包裹导致的 1px 抖动
