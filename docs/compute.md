# 算力管理（`/compute`）

> 上层文档：[CLAUDE.md](../CLAUDE.md)。本文档覆盖 GPU 资源运营 + 任务调度平台的全部子页面。

GPU 资源运营 + 任务调度平台。三层能力：
1. **观测层**（已有）：资源概览、节点/卡/任务利用率、GPU 监控（DCGM, P5b）
2. **调度层**（计划）：基于 Volcano 的任务调度——Queue（资源池）/ PodGroup / Job CRD 视图，gang scheduling、优先级、抢占
3. **治理层**（计划）：基于 Volcano queue + K8s ResourceQuota 联合的配额、设备健康告警、GPU-Hour 计费

依赖插件：HAMi（必需，vGPU 切分）、DCGM Exporter（监控）、Volcano（调度）。全部通过「插件管理」启用，未启用时对应 sub-page 由 DepGate 显示安装引导。

## 1. 集群选择（`/compute`）

- 顶级 landing 页，集群卡片网格，点击进入算力面板
- 不提供集群 CRUD 操作。集群的增删改在「集群管理」完成；本页仅用于选择集群上下文

## 2. 资源概览（`/compute/:id/overview`）

单页 dashboard，自上而下：

- **页头**：标题 + 副标题展示集群规模（"X 个 GPU 节点 · Y 张物理卡"）+ 刷新按钮
- **KPI 三联仪表盘**：vGPU / 显存 / 算力，三张等宽 dashboard-style Progress（3/4 弧 gauge）
- **型号分布 + Top 5 显存占用**：两栏可视化，每行一个 Progress 条 + 标签 + 实际值
- **节点利用率网格**：每个节点一张 mini-card（节点名 + 状态徽章 + 卡数 + 三轴 mini progress + 详情按钮），点详情打开 `NodeDetailDrawer`：节点级 gauges + 每张物理卡 inline + 卡上 pods
- **Tabs 详情**：底部 Tabs 切换「显卡明细」/「任务明细」两个表格。显卡表带 `CardDetailDrawer`，任务表带 namespace/phase/node 列过滤 + 客户端排序分页

依赖 HAMi 插件（`DepGate` 跟监控页同款 dep-check）。

## 3. 算力关键设计

- **数据获取**：单端点 `/api/v1/clusters/:id/gpu` → Worker `gpu-summary` action 聚合返回。`useGPUData` hook 一份 fetch + dep check + 自动轮询，HAMi Running 时每 10s 重拉
- **后端解析**（`pkg/worker/proxy/gpu.go`）：
  - **节点端**：`hami.io/node-nvidia-register` annotation，**先尝试 colon-comma 编码格式**（HAMi <= 2.4，7 或 9 字段）**再 fallback JSON**（新版本）
  - **Pod 端**：`hami.io/vgpu-devices-allocated` annotation 解出每容器/每卡的 (UUID, type, mem, cores) 元组，attribute 到具体物理卡。`cores=0 → 100%` 跟 HAMi-WebUI 同款约定
  - **Pod 元数据**：`createdAt` / `startedAt` 走 PodScheduled / PodInitialized condition；`appName` 取 `app.kubernetes.io/name` 或 `app` label；`resourcePool` / `flavor` / `priority` 各取对应 annotation。终止态 pod (Succeeded/Failed) 不计入占用
  - **Init container** 取 max 不取 sum，跟 K8s 调度器 effective-request 一致
- **KPI 优先 cards 求和**：`rollupKPIs` / `NodeTile` / `NodeDetailDrawer` 优先读 `node.cards[]`，从每张卡的 `slots / devmem / devcore / used*` 累加。**仅当 cards 为空时回落到 node 级 `allocatable / capacity`**。原因：HAMi 在 Node 上报的 `nvidia.com/gpu` 是物理卡数（非 slot 数），且 kwok mock 与部分 HAMi 配置不会在 capacity 里写入 `nvidia.com/gpumem` / `nvidia.com/gpucores`，从 node 级读取会得到 `0/2` 或 `0/0` 这类不准确的值；per-card 累加才能得到真实数值
- **缓存**（`pkg/worker/snapshot/`）：client-go SharedInformerFactory，启动时 List 一次 + watch 长连接，WaitForCacheSync 阻塞到 ready 才进 tunnel.Run。`gpuSummary` 从 lister 读（微秒级，zero API call）
- **Worker clientset 单例**：snapshot / logs manager / exec manager 共享一份 `kubernetes.NewForConfig`，避免每个 consumer 各自维护一套 http.Transport 连接池
- **客户端分页**：GPU pod 数量上限约等于集群总 vGPU 切片数（典型几百，极端几千），ProTable 的客户端分页/排序/列过滤足以应对
- **节点页解耦**：K8s 节点概览（`pages/ClusterDetail/Nodes/`）仅展示 K8s 原语（CPU / 内存 / 状态），GPU 相关信息全部归到算力管理；避免 K8s 节点页随加速器种类（未来可能加 TPU / FPGA）持续膨胀
