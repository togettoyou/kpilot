# 插件管理（`/plugins`）

> 上层文档：[CLAUDE.md](../CLAUDE.md)。本文档覆盖 Helm chart 注册表 + 集群侧启用机制。

## 插件系统概念

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
  name: volcano
spec:
  type: repo
  version: "1.14.2"
  values: |
    custom:
      scheduler_replicas: 1
status:
  phase: Running  # Pending / Installing / Running / Failed
```

**已内置插件**（按 category 维度组织）：

| 插件               | 分类       | Chart 来源 | 用途                                                |
|------------------|----------|----------|---------------------------------------------------|
| Metrics Server   | monitoring | repo     | K8s Metrics API（`metrics.k8s.io`），驱动 `kubectl top` / HPA / VPA |
| VictoriaMetrics  | monitoring | repo     | 单节点 TSDB，自带 Web UI + scrape 配置                   |
| Node Exporter    | monitoring | repo     | 节点级硬件 + OS 指标（搭 VM 用）                            |
| kube-state-metrics | monitoring | repo   | K8s 对象状态指标（Deployment 副本、Pod phase、Node condition）|
| Grafana          | monitoring | **oci**  | 可视化前端，反代嵌入 + 内置 dashboard + auth.proxy            |
| VictoriaLogs     | logging    | repo     | 日志存储 + 自带 Vector DaemonSet 采集                    |
| Volcano          | scheduling | repo     | Batch 调度器，gang scheduling + Queue + drf 公平共享     |

**计划新增**（Volcano 转向 P2/P3）：

| 插件                          | 分类         | 阶段              | 用途                                                                                                |
|-----------------------------|------------|-----------------|---------------------------------------------------------------------------------------------------|
| volcano-vgpu-device-plugin  | gpu        | Volcano 转向 P2 | Volcano scheduler deviceshare 后端，提供 vGPU 切分 + 硬隔离（HAMi-core）。**上游不发 Helm chart**，需自建 wrapper chart 用 go:embed 内嵌 |
| DCGM Exporter               | monitoring | Volcano 转向 P3 | NVIDIA GPU 物理指标采集（利用率 / 温度 / 功耗 / 显存）                                                                  |

**已弃用**：HAMi（独立部署）—— 与 Volcano 调度器的 deviceshare 路径互斥，已从内置注册表移除。其 vGPU 能力由 volcano-vgpu-device-plugin 替代。

## 全局注册表 CRUD（`/plugins`）

- 卡片按 category 分组（gpu / scheduling / networking / storage / monitoring / logging / security / serving / custom）
- 内置插件只读（带「内置」金色 tag），自定义可编辑/删除/查看
- **添加插件**：name (DNS-1123) + 分类 + Helm chart 来源 + 默认 values（YAML 编辑器）+ 默认安装命名空间
- Chart 三种来源（前端 Radio + 后端 ChartType enum，对称色 tag：cyan / geekblue / purple）：
  - `repo` —— 传统 HTTPS Helm 仓库（`chart_repo` + `chart_name` + 版本，需要 index.yaml）
  - `oci` —— OCI registry（Helm 3.8+，`chart_repo` 存完整 `oci://` URL，`chart_name` 不用）。**v1 只支持公开 registry**
  - `local` —— 上传 .tgz blob，sha256 内容 dedupe
- **删除保护**：自定义插件被任意集群启用中（`phase != Disabled`）→ 409 / `PLUGIN_IN_USE`
- **Namespace 不可自定义**：集群侧启用只接受 `version_override` + `values_override`，命名空间统一由 `Plugin.default_release_namespace`（管理员在 /plugins 编辑）决定。这样 Helm release identity (name, namespace) 在每个集群上稳定，避免后续运维误改 namespace 把旧 release 孤悬
- **List 端点 brief 化**：`store.ListPluginsBrief()` 用 GORM `Omit("default_values")` 把可达 64 KiB 的 YAML blob 从列表响应里剥掉。集群 Plugins 页 5s 轮询命中此端点；EnableDrawer / PluginEditDrawer 打开时再走 `GET /plugins/:id` 拉完整记录给 YAML 编辑器

## 启用机制

- **数据切分**：`Plugin`（全局注册表）/ `PluginBlob`（本地 .tgz 字节，sha256 dedupe）/ `ClusterPlugin`（集群侧启用状态 + 用户 override）
- **Plugin CRD**（`pkg/worker/apis/v1alpha1`）：cluster-scoped。spec 含 chart 来源（`type=repo|oci|local`）+ release identity + values YAML。status 含 phase / observed_version / observed_values_hash / `AttemptHash` / helm_revision。CRD 由 Worker 启动时 `EnsurePluginCRD` 自动 install
- **Worker reconciler**：controller-runtime watch Plugin CRD。添加 finalizer 后执行 Helm；删除走 finalizer pattern。**install/upgrade 统一使用 `Wait + WaitForJobs + Atomic + 5min Timeout`**——Wait 处理 chart 内子组件依赖（如 victoria-metrics-k8s-stack 的 webhook race），Atomic 失败时回滚，不留半装状态
- **AttemptHash 防死循环**：reconcile 前计算 `sha256(chart.type + repo + name + version + sha256 + release.name + release.namespace + canonical(values))`。Phase=Running/Failed 且 AttemptHash 匹配时跳过执行。永久 Failed 需修改 spec 或 disable+re-enable 触发重试
- **Manager SSA**：处理 PluginCommand 时使用 `client.Apply` + `FieldOwner("kpilot")` + `ForceOwnership` 写入 CRD
- **离线 / 重连**：handler 提交前通过 `gw.GetWorker()` 预检；离线返回 503 且不写 DB。`handlePluginStatus` 使用 upsert，自愈"push 成功但 DB 写入失败"场景。`Manager.handleDisable` 找不到 CRD 时 push 空 phase（Server 端翻译为 Disabled）
- **重连补发**（`gateway.replayPendingPluginCommands`）：Worker 重连后扫描 `cluster_plugins`：
  - `phase=Uninstalling && enabled=false` → 重发 disable
  - `phase ∈ {Pending,Installing,Upgrading} && enabled=true` → 重发 enable
  - `Failed` 不补发 —— 终态需用户手动改 spec 或 disable+re-enable，重发同样的 PluginCommand 不会变更 generation，reconciler predicate 会过滤掉，毫无作用
- **Uninstalling 期间禁止 Enable**：`existing.Enabled == false` 时返回 409 / `PLUGIN_UNINSTALLING`，避免在带 deletionTimestamp 的 CRD 上 SSA 修改 spec
- **Helm chart cache**：本地 .tgz 存于 `$DATA_DIR/charts/<sha256>.tgz`，atomic write + sha256 校验。Repo chart 在 `$DATA_DIR/helm/cache/` 缓存，`LoadChart` 命中时跳过 Pull
- **Helm release storage**：secrets driver（v3 默认），keyed by (release_name, release_namespace)
- **失败错误展示**：Failed phase tag hover 触发 Popover（非 Tooltip，可滚动 + 复制按钮 + `overscroll-behavior: contain`）
- **Reconcile-on-Watch 防抖**（`pkg/worker/plugin/reconciler.go::reconcileTriggerPredicate`）：仅 spec generation 变化、Create、Delete、新设 DeletionTimestamp 触发 Reconcile。status-only 写入与 finalizer add/remove 不触发
- **Worker 注册 TOCTOU 保护**：`gateway.Connect` 的 occupied 检查与 slot 写入合并到单次 `g.mu.Lock()`
- **⚠️ Helm SDK 陷阱**：不要使用 `RunWithContext` + `defer cancel()`——install 成功后 deferred cancel 会污染 K8s client transport，导致后续 K8s 读取静默挂起。使用 `Run()` 不带 ctx，disable 期间的 install 等待 Helm 自身 timeout（10min）

## Server 侧 values 占位符

`pkg/server/gateway/plugin.go::expandKPilotVars`——插件启用前，Server 替换 values YAML 中的 `${KPILOT_*}` token。token 名匹配 `[A-Z0-9_]+`（regex 强制大写）。

| Token                       | 含义                                                                                                       |
|-----------------------------|----------------------------------------------------------------------------------------------------------|
| `${KPILOT_CLUSTER_ID}`      | 集群 UUID。反代插件用于构造 sub-path（如 Grafana root_url=`/api/v1/clusters/${KPILOT_CLUSTER_ID}/proxy/grafana/`） |
| `${KPILOT_CLUSTER_DOMAIN}`  | K8s DNS suffix（默认 `cluster.local`，Worker register 时上报）。chart 默认 values 中需要写入 in-cluster Service FQDN 时使用 |

新增变量：在 `expandKPilotVars` 的 map 中追加一行即可。

## Server 侧 dashboard overlay

`pkg/server/dashboards/`——Grafana 内置 dashboard JSON（NodeExporterFull ~660KB / VictoriaLogs Explorer ~30KB）通过 `//go:embed` 编译进 Server，在 `BuildEnableCommand` 中 deep-merge 到 Grafana plugin 的 values。**未写入 default_values**，因为 700KB 会导致 EnableDrawer 的 CodeMirror 长时间无响应；用户 values 优先级更高，可覆盖任意 dashboard。
