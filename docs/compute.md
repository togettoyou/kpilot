# 算力调度（`/compute`）

> 上层文档：[CLAUDE.md](../CLAUDE.md)。本文档覆盖基于 Volcano 的批量调度平台。

KPilot 的算力调度平台 = **Volcano 批量调度**为核心，**vGPU 虚拟化**为子能力。定位是 AI / HPC workload 的作业编排面板，而非 GPU 监控仪表盘。

三层能力：

1. **作业调度层**（核心）：Volcano Queue / Job / PodGroup CR 浏览器，作业提交向导，调度策略只读视图
2. **GPU 虚拟化层**：通过 [`volcano-vgpu-device-plugin`](https://github.com/Project-HAMi/volcano-vgpu-device-plugin)（Volcano scheduler 的 deviceshare 后端，使用 HAMi-core 做 hard isolation）提供 vGPU 切分、显存 / 算力限制；KPilot 不再独立部署 HAMi
3. **治理层**（计划）：Volcano queue 配额 + 设备健康告警 + GPU-Hour 计费

依赖插件：**Volcano**（必需）+ **volcano-vgpu-device-plugin**（GPU 节点必需）。两者通过「插件管理」启用。

## 1. 集群选择（`/compute`）

- 顶级 landing 页，集群卡片网格，点击进入算力调度面板
- 不提供集群 CRUD 操作。集群的增删改在「集群管理」完成；本页仅用于选择集群上下文

## 2. Volcano 核心对接（计划）

> 这一节描述目标形态。当前 Phase 1 还在做 HAMi 拆除，Volcano CR 浏览器尚未落地。

- **Queue 浏览**：列表 + 详情 + YAML 编辑（CR 浏览器复用），重点展示 Queue 的 capability/guarantee 配额 + 当前用量
- **Job 浏览**：list / get / delete + 状态机展示（Pending / Running / Completed / Failed），下钻 PodGroup → Pod
- **PodGroup 浏览**：minMember / minResources / Phase 展示
- **作业提交向导**：表单选 Queue + 资源（CPU/GPU/内存）+ 镜像 + 命令 → 拼出 `batch.volcano.sh/v1alpha1 Job` CR 提交
- **集群调度策略**：只读展示 `volcano-scheduler-configmap` 当前启用的 plugins/actions（编辑成本太高，先只读）

## 3. vGPU 资源面板（迁移中）

> Phase 2 完成后会复活。当前依赖 HAMi annotation 的解析器还在，老的 HAMi 集群仍能渲染数据。

- **数据获取**：单端点 `/api/v1/clusters/:id/gpu` → Worker `gpu-summary` action 聚合返回。`useGPUData` hook 一份 fetch + dep check + 自动轮询
- **DepGate**：检查 `volcano-vgpu-device-plugin` 在集群上 `Phase=Running`；未启用 → Result 引导用户去插件管理
- **页面布局**（资源概览，作为算力调度页的一个 tab）：
  - **页头**：标题 + 副标题（"X 个 GPU 节点 · Y 张物理卡"）
  - **KPI 三联仪表盘**：vGPU / 显存 / 算力，三张等宽 dashboard-style Progress
  - **型号分布 + Top 5 显存占用**：两栏可视化
  - **节点利用率网格**：每个节点 mini-card，点详情打开 `NodeDetailDrawer`
  - **Tabs 详情**：「显卡明细」/「任务明细」两个表格

## 4. 关键设计

- **Volcano 优先**：调度 + GPU 隔离都收敛到 Volcano 生态。HAMi 独立 device plugin 不再支持，它的角色被 `volcano-vgpu-device-plugin` 替代——后者使用同款 HAMi-core 库，但跟 Volcano scheduler 的 deviceshare 插件深度集成
- **`schedulerName: volcano`** 是入场券：所有要走 vGPU 调度 / queue 配额的 Pod 必须显式指定 `schedulerName: volcano`，否则走 default-scheduler，绕过 deviceshare
- **资源标签**：用 `volcano.sh/vgpu-number` / `volcano.sh/vgpu-memory` / `volcano.sh/vgpu-cores` 替代旧的 `nvidia.com/gpu*` 系列
- **节点端 annotation**：`volcano.sh/node-vgpu-register`（设备清单）+ `volcano.sh/node-vgpu-handshake`（活性）+ `volcano.sh/node-vgpu-register`（已注册标记）
- **Pod 端 annotation**：`volcano.sh/vgpu-ids-new`（已分配设备 ID）+ `volcano.sh/devices-to-allocate`（待分配）+ `volcano.sh/vgpu-node`（被调度到的节点）+ `volcano.sh/vgpu-mode`（hami-core / mig）
- **缓存**（`pkg/worker/snapshot/`）：client-go SharedInformerFactory，启动时 List + watch 长连接，WaitForCacheSync 阻塞到 ready 才进 tunnel.Run。`gpuSummary` 从 lister 读（微秒级，zero API call）
- **Worker clientset 单例**：snapshot / logs manager / exec manager 共享一份 `kubernetes.NewForConfig`，避免每个 consumer 各自维护一套 http.Transport 连接池
- **客户端分页**：GPU pod 数量上限约等于集群总 vGPU 切片数（典型几百，极端几千），ProTable 的客户端分页 / 排序 / 列过滤足以应对
- **节点页解耦**：K8s 节点概览（`pages/ClusterDetail/Nodes/`）仅展示 K8s 原语（CPU / 内存 / 状态），GPU 相关信息全部归到算力调度

## 历史 / 迁移

- 老版本（pre-Volcano-pivot）：使用独立 HAMi 部署，解析 `hami.io/*` annotation。该路径已弃用
- 当前过渡期：HAMi 内置插件已删除，`gpu.go` 解析器仍读 hami.io，Phase 2 重写
- 集群里现有的 HAMi Helm release 不会被 KPilot 主动卸载——用户手动 `helm uninstall hami` 后部署 volcano-vgpu-device-plugin 即可
