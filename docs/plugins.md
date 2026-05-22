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

| 插件                          | 分类         | Chart 来源 | 用途                                                                  |
|-----------------------------|------------|----------|---------------------------------------------------------------------|
| Metrics Server              | monitoring | repo     | K8s Metrics API（`metrics.k8s.io`），驱动 `kubectl top` / HPA / VPA |
| VictoriaMetrics             | monitoring | repo     | 单节点 TSDB，自带 Web UI + scrape 配置                                |
| Node Exporter               | monitoring | repo     | 节点级硬件 + OS 指标（搭 VM 用）                                       |
| kube-state-metrics          | monitoring | repo     | K8s 对象状态指标（Deployment 副本、Pod phase、Node condition）         |
| NVIDIA DCGM Exporter        | monitoring | repo     | 物理 GPU 指标 DaemonSet（`DCGM_FI_DEV_*`：利用率 / 温度 / 功耗 / framebuffer 显存 / SM clock / tensor 活跃度）暴露 `:9400` 上的 Prometheus 端点。**算力调度平台直接通过 server-side PromQL 自绘三个页**（`/compute/:id/gpu-monitoring` 自绘图表 + `/device-health` 告警 + `/gpu-hour` 计费报表），**不通过 Grafana** —— Grafana 仅服务于集群管理的通用监控。前置：每个 GPU 节点要装 NVIDIA driver + nvidia-container-runtime（与 vGPU device-plugin 同款依赖）。**默认 values 关掉 `serviceMonitor.enabled`**：chart 默认会创建 `monitoring.coreos.com/v1 ServiceMonitor`,需要 prometheus-operator CRD;KPilot 走 VictoriaMetrics + `prometheus.io/scrape` 注解,装 ServiceMonitor 反而让 Helm install 失败 |
| Grafana                     | monitoring | **oci**  | 可视化前端，反代嵌入 + 内置 dashboard + auth.proxy。**定位**：集群管理的 `/clusters/:id/grafana` escape hatch（power user 自定义 dashboard / datasource / alert）；集群监控 + 日志 + 算力调度 GPU/Volcano 所有可视化页都已改自绘，不嵌 Grafana |
| VictoriaLogs                | logging    | repo     | 日志存储 + 自带 Vector DaemonSet 采集                                |
| Volcano                     | scheduling | repo     | Batch 调度器，gang scheduling + Queue + drf 公平共享；默认装在 `volcano-system`，默认 scheduler 配置已启 `deviceshare` 以配合 vGPU 后端 |
| Volcano vGPU<br/>(`volcano-vgpu-device-plugin`) | scheduling | **local**| Volcano scheduler deviceshare 的后端 device-plugin（HAMi-core fork）：把物理 GPU 注册为 `volcano.sh/vgpu-{number,memory,cores}` 资源；驱动 `/compute/:id/vgpu` 实况页。display_name 缩短为 "Volcano vGPU" 适配 antd Card 单行 ellipsis；默认装在 `volcano-system`（chart 把两个 ConfigMap 也写到 release namespace，依赖 device-plugin 二进制内的 `kube-system → volcano-system` fallback 链找到 `volcano-vgpu-device-config`） |

**已弃用**：HAMi（独立部署）—— 与 Volcano 调度器的 deviceshare 路径互斥，已从内置注册表移除。其 vGPU 能力由 volcano-vgpu-device-plugin 替代。

### 内置 local chart 模式（volcano-vgpu-device-plugin）

`volcano-vgpu-device-plugin` 是 KPilot 第一个 `ChartType=Local` 的内置插件——上游只发 raw YAML 不发 Helm chart，所以 chart 源码（Chart.yaml / values.yaml / templates/\*）committed 在 `pkg/server/plugins/charts/<name>/` 下，由 server 在启动时即时打包：

1. `pkg/server/plugins/charts.go` 用 `go:embed` 把 chart 目录打包进 server binary。templates/ 用 `all:` 前缀避免 `_helpers.tpl` 被 embed 默认规则跳过
2. 启动时调用 `PackageVolcanoVGPU()`：把 embed.FS mirror 到临时目录，`loader.LoadDir` → `chartutil.Save` → 读 `<name>-<version>.tgz` bytes，sha256
3. `store.UpsertPluginBlob` 按 sha256 dedupe 写入 `plugin_blobs` 表；同 sha256 的 blob 不重复插入
4. `seed.go::seedLocalChartBlobs` 把 blob ID 回填到 builtinPlugins 表对应行的 `ChartBlobID` —— 这一步发生在 `SeedBuiltinPlugins` upsert Plugin 行之前
5. 启用时走与用户上传 .tgz 完全相同的 worker 路径

`DB = db` 必须在 `SeedBuiltinPlugins` 之前赋值（`6bd6181`），否则 seed 内的 `UpsertPluginBlob` 用包级 `store.DB` 触发 nil deref。

新增 local 内置：

1. 在 `pkg/server/plugins/charts/<name>/` 加 chart 源码
2. `pkg/server/plugins/charts.go` 加 `embed.FS` + `PackageXxx()` 函数
3. `seed.go` 加 builtin row + 在 `seedLocalChartBlobs()` 加打包调用 + ChartBlobID 回填

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
- **状态写入并发保护**：`store.PersistClusterPluginStatusIfActive` 把"读 ClusterPlugin → 判断 enabled → upsert status"合并成一个 GORM 事务。Disable 操作把行置成 `enabled=false`、phase=Uninstalling 之后，可能在事务窗口内仍有 Worker 旧 PluginStatus push 上来（Pending/Installing 等），如果用 read-modify-write 两步会把已 Disable 的行重新拉回 Running。事务里判 `enabled=true`，否则 `pluginservice/status.go` log "late status echo ignored" 静默丢弃。终结状态（Disabled 主动写、Uninstalling phase 写）走非条件 upsert，不进这个 guard
- **重连补发**（`gateway.replayPendingPluginCommands`）：Worker 重连后扫描 `cluster_plugins`：
  - `phase=Uninstalling && enabled=false` → 重发 disable
  - `phase ∈ {Pending,Installing,Upgrading} && enabled=true` → 重发 enable
  - `Failed` 不补发 —— 终态需用户手动改 spec 或 disable+re-enable，重发同样的 PluginCommand 不会变更 generation，reconciler predicate 会过滤掉，毫无作用
- **Uninstalling 期间禁止 Enable**：`existing.Enabled == false` 时返回 409 / `PLUGIN_UNINSTALLING`，避免在带 deletionTimestamp 的 CRD 上 SSA 修改 spec
- **Helm chart cache**：本地 .tgz 存于 `$DATA_DIR/charts/<sha256>.tgz`，atomic write + sha256 校验。Repo chart 在 `$DATA_DIR/helm/cache/` 缓存，`LoadChart` 命中时跳过 Pull
- **Helm release storage**：secrets driver（v3 默认），keyed by (release_name, release_namespace)
- **失败错误展示**：Failed phase tag hover 触发 Popover（非 Tooltip，可滚动 + 复制按钮 + `overscroll-behavior: contain`）
- **实时安装日志**:Worker 把 Helm SDK 的 `inst.Log` callback 接到 `tunnel.PushPluginLogLine`,加上 reconciler 里几条关键里程碑(chart 加载 / helm install starting / 完成或失败),按行用 `STREAM_PLUGIN_LOG_PUSH` 推回 Server(每行一条短 yamux stream,只发 PluginLogChunk 不带终止帧 —— 见 [docs/transport-v2.md](transport-v2.md) §16.5)。安装结束时 `PushPluginLogEnd` 才发哨兵 + PluginLogEnd 终态帧。Server 端 `pkg/server/gateway/plugin_log.go` 维护 per-`(cluster, plugin)` ring buffer(500 条 / 10min TTL)+ 订阅者 fanout;WS 端点 `/api/v1/clusters/:id/plugins/:name/install-log` 上线时先 replay buffer 再订阅 live。前端 `<PluginInstallLogDrawer>` 渲染三种帧:`kind=chunk`(进度行)/ `kind=end`(终态成功失败 banner)/ `kind=reset`(gateway 在已 ended 的 plugin 上检测到新操作时下发,前端见到就清空 entries / endStatus,避免「再次启用时打开日志只看到上一次的旧 uninstall log」)。终端 end 帧到达后**不主动关闭 WS**,否则 ring buffer 的 end-frame replay 会让下次 reset 帧没机会到达;server 端 10min 会话 TTL 自己关空闲订阅者(`reapPluginLogs` goroutine 在 `NewGatewayServer` 启动),drawer 关闭时也会断 WS。两个触发点:用户在 `EnableDrawer` 点提交后自动开启该 drawer(看启用进度);卡片在 Pending/Installing/Upgrading/Uninstalling/Failed phase 显示「查看日志」按钮(回头看进度或排查失败)。不做 DB 持久化 —— buffer TTL 过后只剩 phase + message
- **Reconcile-on-Watch 防抖**（`pkg/worker/plugin/reconciler.go::reconcileTriggerPredicate`）：仅 spec generation 变化、Create、Delete、新设 DeletionTimestamp 触发 Reconcile。status-only 写入与 finalizer add/remove 不触发
- **Worker 注册 TOCTOU 保护**：`gateway.Connect` 的 occupied 检查与 slot 写入合并到单次 `g.mu.Lock()`
- **⚠️ Helm SDK 陷阱**：不要使用 `RunWithContext` + `defer cancel()`——install 成功后 deferred cancel 会污染 K8s client transport，导致后续 K8s 读取静默挂起。使用 `Run()` 不带 ctx，disable 期间的 install 等待 Helm 自身 timeout（10min）

## Server 侧 values 占位符

`pkg/server/pluginservice/command.go::expandKPilotVars`——插件启用前，Server 替换 values YAML 中的 `${KPILOT_*}` token。token 名匹配 `[A-Z0-9_]+`（regex 强制大写）。

| Token                       | 含义                                                                                                       |
|-----------------------------|----------------------------------------------------------------------------------------------------------|
| `${KPILOT_CLUSTER_ID}`      | 集群 UUID。反代插件用于构造 sub-path（如 Grafana root_url=`/api/v1/clusters/${KPILOT_CLUSTER_ID}/proxy/grafana/`） |
| `${KPILOT_CLUSTER_DOMAIN}`  | K8s DNS suffix（默认 `cluster.local`，Worker register 时上报）。chart 默认 values 中需要写入 in-cluster Service FQDN 时使用 |

新增变量：在 `expandKPilotVars` 的 map 中追加一行即可。

## Server 侧 dashboard overlay

`pkg/server/dashboards/`——Grafana 内置 dashboard JSON（NodeExporterFull ~660KB / VictoriaLogs Explorer ~30KB）通过 `//go:embed` 编译进 Server，在 `BuildEnableCommand` 中 deep-merge 到 Grafana plugin 的 values。**未写入 default_values**，因为 700KB 会导致 EnableDrawer 的 CodeMirror 长时间无响应；用户 values 优先级更高，可覆盖任意 dashboard。
