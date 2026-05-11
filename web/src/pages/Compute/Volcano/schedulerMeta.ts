// schedulerMeta — full typed schema for volcano-scheduler-configmap.
//
// Sources: Volcano source pkg/scheduler/conf/scheduler_conf.go (the
// PluginOption struct) + pkg/scheduler/{actions,plugins}/*.go (the
// per-plugin / per-action `arguments` map readers).
//
// The Scheduler page uses three pieces from here:
//   1. ACTIONS_META / PLUGINS_META — name + one-line desc rendered in
//      help collapses and tooltips on chips.
//   2. ACTIONS_META[a].args / PLUGINS_META[p].args — typed schema for
//      action `configurations[].arguments` and plugin `arguments`
//      maps. Drives the auto-generated form fields under each
//      plugin / action card.
//   3. ENABLE_FIELDS — the 25 generic Enabled* booleans every plugin
//      accepts at the top-level (not under arguments). Rendered as a
//      collapsible "高级开关" grid per plugin.
//
// Anything not in this file falls through to a generic "未知 / 自定义"
// rendering and a raw key/value editor — user-extended schedulers
// don't break the page.

// ─── Types ──────────────────────────────────────────────────────────────

export interface Meta {
  // Display label (the canonical Volcano name — kept English even in
  // zh-CN since these are well-known terms).
  label: string;
  // One-line zh-CN description aimed at a Volcano beginner.
  desc: string;
}

export type ArgType = 'int' | 'float' | 'bool' | 'string' | 'object';

export interface ArgSpec {
  // YAML key as parsed by Volcano. Some keys are dotted ("binpack.weight"),
  // some camelCase ("resourceStrategyFitWeight") — preserve verbatim.
  key: string;
  // zh-CN label rendered above the input.
  label: string;
  // One-line hint rendered as Form.Item extra.
  desc: string;
  type: ArgType;
  // Default Volcano applies when the key is absent. Shown as
  // placeholder; not written to YAML unless the user explicitly types
  // it (otherwise we'd bloat every saved configmap with defaults that
  // Volcano already supplies in code).
  default?: number | boolean | string;
  // Numeric clamps for int / float inputs.
  min?: number;
  max?: number;
}

export interface PluginMeta extends Meta {
  args?: ArgSpec[];
  // Enable* yaml keys this plugin actually consumes. The 25-field
  // PluginOption struct is generic — every YAML accepts every flag —
  // but each plugin only registers a subset of session callbacks, so
  // most flags are no-ops per plugin. Source-derived from `ssn.AddXxxFn`
  // grep across pkg/scheduler/plugins/<p>/*.go. If omitted (custom /
  // unrecognised plugin) the UI falls back to showing all 25.
  callbacks?: string[];
}

export interface ActionMeta extends Meta {
  args?: ArgSpec[];
}

export interface EnableSpec {
  // Exact YAML key as PluginOption struct declares it. Volcano's tags
  // are inconsistent (some "enableX", some "enabledX", one literal
  // "EnabledClusterOrder" uppercase) — preserve verbatim, the
  // scheduler parser is byte-exact.
  key: string;
  // zh-CN label for the switch.
  label: string;
  // Short explanation of what the callback does, so users know what
  // they're disabling.
  desc: string;
}

// ─── 25 generic Enabled* booleans ───────────────────────────────────────
//
// Every plugin accepts these top-level (NOT under arguments). They
// gate which session callbacks the plugin registers. Disabling one is
// only meaningful if the plugin actually implements that callback; a
// flag on a plugin that doesn't implement the corresponding Fn is a
// no-op. We expose all 25 anyway — Volcano keeps adding plugins and
// changing what's implemented; the user is responsible for picking
// the ones that matter for their plugin choice.
//
// Order matches PluginOption struct in pkg/scheduler/conf/scheduler_conf.go.

export const ENABLE_FIELDS: EnableSpec[] = [
  {
    key: 'enableJobOrder',
    label: 'JobOrder',
    desc: '作业排序 callback：决定同 tier 内 PodGroup 谁先调度（priority / drf / sla 等用）',
  },
  {
    key: 'enableHierarchy',
    label: 'Hierarchy',
    desc: '分级共享：多层 Queue 之间继承 / 分配资源（proportion / capacity 高级用法）',
  },
  {
    key: 'enableJobReady',
    label: 'JobReady',
    desc: '判断作业是否满足 minMember 可以启动（gang 的核心 callback）',
  },
  {
    key: 'enableJobPipelined',
    label: 'JobPipelined',
    desc: '判断作业资源是否已 pipelined（预占）但还没真正起 pod',
  },
  {
    key: 'enableTaskOrder',
    label: 'TaskOrder',
    desc: '同 Job 内任务之间的顺序（task-topology 等用）',
  },
  {
    key: 'enablePreemptable',
    label: 'Preemptable',
    desc: '同 Queue 内是否允许抢占该作业（gang / drf 默认参与判断）',
  },
  {
    key: 'enableReclaimable',
    label: 'Reclaimable',
    desc: '跨 Queue 资源回收时是否允许从该作业回收（proportion / capacity 用）',
  },
  {
    key: 'enablePreemptive',
    label: 'Preemptive',
    desc: '是否允许该 Queue / Job 主动发起抢占',
  },
  {
    key: 'enableQueueOrder',
    label: 'QueueOrder',
    desc: 'Queue 之间排序（proportion / capacity / drf 都参与）',
  },
  {
    key: 'EnabledClusterOrder',
    label: 'ClusterOrder',
    desc: '多集群调度时的集群排序（注意 YAML key 是首字母大写 EnabledClusterOrder）',
  },
  {
    key: 'enablePredicate',
    label: 'Predicate',
    desc: '节点筛选硬规则（predicates / deviceshare / numa-aware 都注册）',
  },
  {
    key: 'enableBestNode',
    label: 'BestNode',
    desc: '在节点打分后选「最佳节点」的钩子（task-topology 用）',
  },
  {
    key: 'enableNodeOrder',
    label: 'NodeOrder',
    desc: '节点打分（nodeorder / binpack / usage / resource-strategy-fit 都贡献分数）',
  },
  {
    key: 'enableTargetJob',
    label: 'TargetJob',
    desc: '挑选「本轮重点调度的 Job」（sla 等用）',
  },
  {
    key: 'enableReservedNodes',
    label: 'ReservedNodes',
    desc: '为预占资源标记 reserved 节点（提升后续 binpack 命中）',
  },
  {
    key: 'enableJobEnqueued',
    label: 'JobEnqueued',
    desc: 'enqueue 阶段的准入判断（overcommit / proportion 决定 Pending → Inqueue）',
  },
  {
    key: 'enabledVictim',
    label: 'Victim',
    desc: '抢占目标选择（preempt action 用，决定驱逐哪个低优先级 pod）',
  },
  {
    key: 'enableJobStarving',
    label: 'JobStarving',
    desc: '判断作业是否「饥饿」需要保护（sla 等用）',
  },
  {
    key: 'enabledOverused',
    label: 'Overused',
    desc: 'Queue 是否过载（proportion / capacity 用，过载时拒绝新作业入队）',
  },
  {
    key: 'enabledAllocatable',
    label: 'Allocatable',
    desc: '资源是否可分配的判断（preempt / reclaim 用，比 Preemptable 更细）',
  },
  {
    key: 'enabledHyperNodeOrder',
    label: 'HyperNodeOrder',
    desc: 'HyperNode 之间的排序（network-topology-aware 用）',
  },
  {
    key: 'enabledSubJobReady',
    label: 'SubJobReady',
    desc: 'PodGroup 子组 Ready 判断（含层级 gang 的高级用法）',
  },
  {
    key: 'enabledSubJobPipelined',
    label: 'SubJobPipelined',
    desc: 'PodGroup 子组 Pipelined 判断',
  },
  {
    key: 'enabledSubJobOrder',
    label: 'SubJobOrder',
    desc: 'PodGroup 子组之间的顺序',
  },
  {
    key: 'enabledHyperNodeGradient',
    label: 'HyperNodeGradient',
    desc: 'HyperNode 评分梯度（network-topology-aware）',
  },
];

// ─── Actions ────────────────────────────────────────────────────────────

export const ACTIONS_META: Record<string, ActionMeta> = {
  enqueue: {
    label: 'enqueue',
    desc: '把 Pending 状态的 PodGroup 推进到 Inqueue —— 决定本轮哪些作业能进入调度循环（受 overcommit / proportion 等插件限制）。',
  },
  allocate: {
    label: 'allocate',
    desc: '给已 Inqueue 的 PodGroup 在节点上找资源并预留。是最核心的调度阶段。',
    args: [
      {
        key: 'predicateErrorCacheEnable',
        label: 'predicateErrorCacheEnable',
        desc: '本轮内缓存节点 predicate 失败结果，避免同一节点被反复评估。建议保持默认 true。',
        type: 'bool',
        default: true,
      },
    ],
  },
  preempt: {
    label: 'preempt',
    desc: '同 Queue 内的高优先级作业可以驱逐已运行的低优先级作业（preempt within queue）。',
    args: [
      {
        key: 'predicateErrorCacheEnable',
        label: 'predicateErrorCacheEnable',
        desc: '本轮内缓存节点 predicate 失败结果，避免反复评估。',
        type: 'bool',
        default: true,
      },
      {
        key: 'enableTopologyAwarePreemption',
        label: 'enableTopologyAwarePreemption',
        desc: '启用拓扑感知抢占（按 HyperNode 范围限定候选受害节点，减小波及面）。',
        type: 'bool',
        default: false,
      },
      {
        key: 'topologyAwarePreemptWorkerNum',
        label: 'topologyAwarePreemptWorkerNum',
        desc: '拓扑感知抢占的并发 worker 数。',
        type: 'int',
        min: 1,
      },
      {
        key: 'minCandidateNodesPercentage',
        label: 'minCandidateNodesPercentage',
        desc: '候选节点比例下限（百分比）—— 总节点数 × 此比例 决定每轮考察的最小节点数。',
        type: 'int',
        min: 0,
        max: 100,
      },
      {
        key: 'minCandidateNodesAbsolute',
        label: 'minCandidateNodesAbsolute',
        desc: '候选节点绝对下限。两者取较大值。',
        type: 'int',
        min: 0,
      },
      {
        key: 'maxCandidateNodesAbsolute',
        label: 'maxCandidateNodesAbsolute',
        desc: '候选节点上限，避免大集群下评估开销失控。',
        type: 'int',
        min: 0,
      },
    ],
  },
  reclaim: {
    label: 'reclaim',
    desc: '跨 Queue 资源回收：自己 Queue 不够用时，从其它「有空闲且 reclaimable=true」的 Queue 抢资源回来。',
    args: [
      {
        key: 'predicateErrorCacheEnable',
        label: 'predicateErrorCacheEnable',
        desc: '本轮内缓存节点 predicate 失败结果。',
        type: 'bool',
        default: true,
      },
    ],
  },
  backfill: {
    label: 'backfill',
    desc: '给资源请求模糊（best-effort）的小作业填空闲槽位 —— 只在大作业还没排到的间隙发生，不阻塞主调度。',
    args: [
      {
        key: 'predicateErrorCacheEnable',
        label: 'predicateErrorCacheEnable',
        desc: '本轮内缓存节点 predicate 失败结果。',
        type: 'bool',
        default: true,
      },
    ],
  },
  shuffle: {
    label: 'shuffle',
    desc: '节点级再平衡：Volcano 1.7+ 才有，把压力大节点上的 pod 迁到轻载节点，需要配合驱逐策略。',
  },
};

// ─── Plugins ────────────────────────────────────────────────────────────

export const PLUGINS_META: Record<string, PluginMeta> = {
  priority: {
    label: 'priority',
    desc: '按 PriorityClass 给 PodGroup 排序，高优先级先调度、被抢占的优先级低。',
    callbacks: [
      'enableJobOrder',
      'enableTaskOrder',
      'enablePreemptable',
      'enableJobStarving',
      'enabledSubJobOrder',
    ],
  },
  gang: {
    label: 'gang',
    desc: '强制 minMember 个 pod 必须同时调度成功，否则本组都不启动。分布式训练 / MPI 必备。',
    callbacks: [
      'enableJobOrder',
      'enableJobReady',
      'enableJobPipelined',
      'enableJobStarving',
      'enablePreemptable',
      'enableReclaimable',
      'enabledSubJobReady',
      'enabledSubJobPipelined',
      'enabledSubJobOrder',
    ],
  },
  conformance: {
    label: 'conformance',
    desc: '把控制器自身的 pod（kube-system / volcano-system）排除在 Volcano 调度之外，让默认调度器接管。',
    callbacks: ['enablePreemptable', 'enableReclaimable'],
  },
  drf: {
    label: 'drf',
    desc: 'Dominant Resource Fairness —— 多用户共享时，按「用户最紧张那个资源」的比例公平分配。',
    callbacks: [
      'enableJobOrder',
      'enableQueueOrder',
      'enablePreemptable',
      'enableReclaimable',
      'enableHierarchy',
    ],
  },
  proportion: {
    label: 'proportion',
    desc: '按 Queue.weight 比例切分集群资源；多 Queue 共存的核心策略。',
    callbacks: [
      'enableQueueOrder',
      'enableJobEnqueued',
      'enabledOverused',
      'enabledAllocatable',
      'enablePreemptive',
      'enablePredicate',
      'enableReclaimable',
    ],
  },
  predicates: {
    label: 'predicates',
    desc: 'K8s 原生节点筛选：亲和、污点、资源是否够。沿用 default-scheduler 的所有 predicate。',
    callbacks: ['enablePredicate', 'enableNodeOrder'],
    args: [
      {
        key: 'predicate.NodeAffinityEnable',
        label: 'NodeAffinity',
        desc: '是否启用 NodeAffinity / NodeSelector 筛选。',
        type: 'bool',
        default: true,
      },
      {
        key: 'predicate.NodePortsEnable',
        label: 'NodePorts',
        desc: 'NodePort 冲突检查。',
        type: 'bool',
        default: true,
      },
      {
        key: 'predicate.TaintTolerationEnable',
        label: 'TaintToleration',
        desc: '污点 / 容忍匹配。',
        type: 'bool',
        default: true,
      },
      {
        key: 'predicate.PodAffinityEnable',
        label: 'PodAffinity',
        desc: 'Pod 间亲和 / 反亲和。',
        type: 'bool',
        default: true,
      },
      {
        key: 'predicate.NodeVolumeLimitsEnable',
        label: 'NodeVolumeLimits',
        desc: '节点挂卷数量上限检查。',
        type: 'bool',
        default: true,
      },
      {
        key: 'predicate.VolumeZoneEnable',
        label: 'VolumeZone',
        desc: 'PV 与节点拓扑域（zone）匹配。',
        type: 'bool',
        default: true,
      },
      {
        key: 'predicate.PodTopologySpreadEnable',
        label: 'PodTopologySpread',
        desc: 'Pod Topology Spread Constraints 检查。',
        type: 'bool',
        default: true,
      },
      {
        key: 'predicate.VolumeBindingEnable',
        label: 'VolumeBinding',
        desc: 'PVC / PV 绑定检查（动态制备 PV 时影响调度时机）。',
        type: 'bool',
        default: true,
      },
      {
        key: 'predicate.DynamicResourceAllocationEnable',
        label: 'DynamicResourceAllocation',
        desc: 'K8s DRA（Dynamic Resource Allocation）筛选；需要集群启用 DynamicResourceAllocation feature gate。',
        type: 'bool',
        default: false,
      },
      {
        key: 'predicate.CacheEnable',
        label: 'CachePredicate',
        desc: '本轮调度内缓存 predicate 失败结果，避免对相同节点 / Pod 组合重复计算。',
        type: 'bool',
        default: false,
      },
    ],
  },
  nodeorder: {
    label: 'nodeorder',
    desc: '节点打分：综合空闲资源、镜像本地性、节点平衡度。allocate 阶段挑节点用的。',
    callbacks: ['enableNodeOrder'],
    args: [
      {
        key: 'nodeaffinity.weight',
        label: 'NodeAffinity 权重',
        desc: '节点亲和度打分权重。',
        type: 'int',
        default: 2,
        min: 0,
      },
      {
        key: 'podaffinity.weight',
        label: 'PodAffinity 权重',
        desc: 'Pod 间亲和打分权重。',
        type: 'int',
        default: 2,
        min: 0,
      },
      {
        key: 'leastrequested.weight',
        label: 'LeastRequested 权重',
        desc: '「优先空节点」策略权重 —— 越大越倾向把作业分散到空闲节点。',
        type: 'int',
        default: 1,
        min: 0,
      },
      {
        key: 'mostrequested.weight',
        label: 'MostRequested 权重',
        desc: '「优先打满」策略权重 —— 与 LeastRequested 相反，倾向把资源集中。',
        type: 'int',
        default: 0,
        min: 0,
      },
      {
        key: 'balancedresource.weight',
        label: 'BalancedResource 权重',
        desc: 'CPU / Memory 占用平衡度打分。',
        type: 'int',
        default: 1,
        min: 0,
      },
      {
        key: 'tainttoleration.weight',
        label: 'TaintToleration 权重',
        desc: '污点匹配打分权重。',
        type: 'int',
        default: 2,
        min: 0,
      },
      {
        key: 'imagelocality.weight',
        label: 'ImageLocality 权重',
        desc: '镜像已存在节点的打分权重（大幅减少拉镜像耗时）。',
        type: 'int',
        default: 1,
        min: 0,
      },
      {
        key: 'podtopologyspread.weight',
        label: 'PodTopologySpread 权重',
        desc: 'Pod 跨拓扑域分散度打分。',
        type: 'int',
        default: 2,
        min: 0,
      },
    ],
  },
  binpack: {
    label: 'binpack',
    desc: '装箱策略：把 pod 集中到少数节点，留出整块空节点给将来的大作业。跟 nodeorder 互补。',
    callbacks: ['enableNodeOrder'],
    args: [
      {
        key: 'binpack.weight',
        label: '插件整体权重',
        desc: 'binpack 在节点打分总分中所占比例。',
        type: 'int',
        default: 1,
        min: 0,
      },
      {
        key: 'binpack.cpu',
        label: 'CPU 权重',
        desc: 'CPU 在装箱评分中的权重。',
        type: 'int',
        default: 1,
        min: 0,
      },
      {
        key: 'binpack.memory',
        label: 'Memory 权重',
        desc: '内存在装箱评分中的权重。',
        type: 'int',
        default: 1,
        min: 0,
      },
      {
        key: 'binpack.resources',
        label: '额外参与装箱的资源',
        desc: '逗号分隔的扩展资源列表，例如 nvidia.com/gpu,volcano.sh/vgpu-memory。每项可单独配 binpack.resources.<name> 权重。',
        type: 'string',
      },
    ],
  },
  overcommit: {
    label: 'overcommit',
    desc: '允许 Queue 在调度时短暂超额（防止 enqueue 阶段过早卡死）。生产环境常和 proportion 一起开。',
    callbacks: ['enableJobEnqueued'],
    args: [
      {
        key: 'overcommit-factor',
        label: 'overcommit-factor',
        desc: '超额因子，例如 1.2 表示允许 Queue 短暂占用配额的 120%。',
        type: 'float',
        default: 1.2,
        min: 1,
      },
    ],
  },
  deviceshare: {
    label: 'deviceshare',
    desc: 'GPU 设备共享调度。启用后才识别 volcano.sh/vgpu-* 资源；和 volcano-vgpu-device-plugin 配套使用。',
    callbacks: ['enablePredicate', 'enableNodeOrder'],
    args: [
      {
        key: 'deviceshare.GPUSharingEnable',
        label: 'GPUSharing',
        desc: '允许同卡多 pod 共享（按显存切分）。',
        type: 'bool',
        default: false,
      },
      {
        key: 'deviceshare.GPUNumberEnable',
        label: 'GPUNumber',
        desc: '按整卡数量调度（不切分，每 pod 占整卡）。',
        type: 'bool',
        default: false,
      },
      {
        key: 'deviceshare.NodeLockEnable',
        label: 'NodeLock',
        desc: '节点级互斥锁：同时刻同节点只允许一个 deviceshare 调度，避免并发竞争。',
        type: 'bool',
        default: false,
      },
      {
        key: 'deviceshare.VGPUEnable',
        label: 'VGPU',
        desc: '启用 volcano-vgpu-device-plugin 的 vGPU 切分（HAMi-core）。算力调度推荐。',
        type: 'bool',
        default: false,
      },
      {
        key: 'deviceshare.AscendMindClusterVNPUEnable',
        label: 'AscendMindClusterVNPU',
        desc: '昇腾 MindCluster vNPU 切分。',
        type: 'bool',
        default: false,
      },
      {
        key: 'deviceshare.AscendHAMiVNPUEnable',
        label: 'AscendHAMiVNPU',
        desc: '昇腾 HAMi-core vNPU 切分。',
        type: 'bool',
        default: false,
      },
      {
        key: 'deviceshare.SchedulePolicy',
        label: 'SchedulePolicy',
        desc: 'vGPU 分配策略：binpack（往同一卡上塞）或 spread（散到不同卡）。',
        type: 'string',
        default: 'binpack',
      },
      {
        key: 'deviceshare.ScheduleWeight',
        label: 'ScheduleWeight',
        desc: 'deviceshare 在节点打分总分中的权重。',
        type: 'int',
        default: 10,
        min: 0,
      },
      {
        key: 'deviceshare.KnownGeometriesCMName',
        label: 'KnownGeometriesCMName',
        desc: 'GPU 几何切分配置 ConfigMap 名称（高级用法，需配套自定义 vGPU 配置）。',
        type: 'string',
      },
      {
        key: 'deviceshare.KnownGeometriesCMNamespace',
        label: 'KnownGeometriesCMNamespace',
        desc: '上述 ConfigMap 所在命名空间。',
        type: 'string',
      },
      {
        key: 'deviceshare.GPUExclusiveRules',
        label: 'GPUExclusiveRules',
        desc: 'GPU 独占规则数组（按 GPU 型号 / 资源声明独占；复杂嵌套，建议 YAML 视图编辑）。',
        type: 'object',
      },
    ],
  },
  tdm: {
    label: 'tdm',
    desc: 'Time Division Multiplexing —— 时间维度的节点亲和（例如离线作业晚上跑、白天让出）。',
    callbacks: [
      'enableJobOrder',
      'enableJobPipelined',
      'enableJobStarving',
      'enableNodeOrder',
      'enablePredicate',
      'enablePreemptable',
      'enabledVictim',
    ],
    args: [
      {
        key: 'tdm.evict.period',
        label: 'evict.period',
        desc: '空窗期到达后驱逐占用节点的轮询间隔，例如 1m / 30s（Go duration 格式）。',
        type: 'string',
        default: '1m',
      },
    ],
  },
  'numa-aware': {
    label: 'numa-aware',
    desc: 'NUMA 拓扑感知：把 CPU + 内存绑定到同一个 NUMA 节点上，减少跨 socket 访问开销。',
    callbacks: ['enablePredicate', 'enableNodeOrder'],
    args: [
      {
        key: 'weight',
        label: '插件整体权重',
        desc: 'NUMA 评分在节点总分中的占比。',
        type: 'int',
        default: 10,
        min: 0,
      },
    ],
  },
  'network-topology-aware': {
    label: 'network-topology-aware',
    desc: '网络拓扑感知：配合 HyperNode 把 NCCL 任务收紧到同一机架 / spine 内，减少跨拓扑通信。',
    callbacks: [
      'enableNodeOrder',
      'enabledHyperNodeOrder',
      'enabledHyperNodeGradient',
    ],
    args: [
      {
        key: 'weight',
        label: '插件整体权重',
        desc: '在节点 / HyperNode 总分中的权重。',
        type: 'int',
        default: 1,
        min: 0,
      },
      {
        key: 'hypernode.binpack.cpu',
        label: 'HyperNode CPU 权重',
        desc: 'HyperNode 内 CPU 装箱评分权重。',
        type: 'int',
        default: 1,
        min: 0,
      },
      {
        key: 'hypernode.binpack.memory',
        label: 'HyperNode Memory 权重',
        desc: 'HyperNode 内内存装箱评分权重。',
        type: 'int',
        default: 1,
        min: 0,
      },
      {
        key: 'hypernode.binpack.resources',
        label: 'HyperNode 额外资源',
        desc: '逗号分隔扩展资源列表。',
        type: 'string',
      },
      {
        key: 'hypernode.binpack.normal-pod.enable',
        label: '对普通 Pod 启用',
        desc: '默认只对 PodGroup 起作用；开启后对独立 Pod 也应用 HyperNode 装箱。',
        type: 'bool',
        default: false,
      },
      {
        key: 'hypernode.binpack.normal-pod.fading',
        label: '普通 Pod 衰减系数',
        desc: '普通 Pod 评分相对 PodGroup 的衰减比例，0–1 之间。',
        type: 'float',
        default: 0.5,
        min: 0,
        max: 1,
      },
    ],
  },
  'task-topology': {
    label: 'task-topology',
    desc: 'Job 内任务亲和：master + worker 协同放置，例如 ps + worker 必须在不同节点。',
    callbacks: ['enableTaskOrder', 'enableNodeOrder'],
    args: [
      {
        key: 'task-topology.weight',
        label: '插件整体权重',
        desc: 'task-topology 在节点打分中的权重。',
        type: 'int',
        default: 10,
        min: 0,
      },
    ],
  },
  usage: {
    label: 'usage',
    desc: '基于实时利用率给节点打分，避开热点节点。需要 metrics 数据源（Prometheus / VictoriaMetrics）。',
    callbacks: ['enableNodeOrder', 'enablePredicate'],
    args: [
      {
        key: 'usage.weight',
        label: '插件整体权重',
        desc: 'usage 评分在节点总分中的占比。',
        type: 'int',
        default: 5,
        min: 0,
      },
      {
        key: 'cpu.weight',
        label: 'CPU 利用率权重',
        desc: 'CPU 实时利用率在 usage 打分内的子权重。',
        type: 'int',
        default: 1,
        min: 0,
      },
      {
        key: 'memory.weight',
        label: 'Memory 利用率权重',
        desc: '内存实时利用率子权重。',
        type: 'int',
        default: 1,
        min: 0,
      },
      {
        key: 'thresholds',
        label: 'thresholds',
        desc: '触发拒绝调度的阈值，结构如 { cpu: 80, memory: 80 }（百分比）。复杂嵌套，建议 YAML 视图编辑。',
        type: 'object',
      },
    ],
  },
  extender: {
    label: 'extender',
    desc: '调度器扩展点：通过 webhook 接外部决策服务。复杂场景的逃生口。',
    callbacks: [
      'enablePredicate',
      'enableNodeOrder',
      'enableJobReady',
      'enableJobEnqueued',
      'enabledOverused',
      'enablePreemptable',
      'enableReclaimable',
    ],
    args: [
      {
        key: 'extender.ignorable',
        label: 'ignorable',
        desc: 'webhook 不可达时是否忽略（false=直接拒绝调度，true=跳过 extender 继续）。',
        type: 'bool',
        default: false,
      },
      {
        key: 'extender.urlPrefix',
        label: 'urlPrefix',
        desc: 'extender webhook 基础 URL。',
        type: 'string',
      },
      {
        key: 'extender.httpTimeout',
        label: 'httpTimeout',
        desc: 'HTTP 调用超时，Go duration 格式（如 3s）。',
        type: 'string',
        default: '1s',
      },
      {
        key: 'extender.managedResources',
        label: 'managedResources',
        desc: 'extender 关心的资源名数组（如 nvidia.com/gpu）；Pod 不请求这些资源时跳过 extender 调用。',
        type: 'object',
      },
      {
        key: 'extender.predicateVerb',
        label: 'predicateVerb',
        desc: '远端 predicate 接口的子路径（默认 predicate）。',
        type: 'string',
      },
      {
        key: 'extender.prioritizeVerb',
        label: 'prioritizeVerb',
        desc: '远端 prioritize 接口的子路径。',
        type: 'string',
      },
      {
        key: 'extender.preemptableVerb',
        label: 'preemptableVerb',
        desc: '远端 preemptable 接口的子路径。',
        type: 'string',
      },
      {
        key: 'extender.reclaimableVerb',
        label: 'reclaimableVerb',
        desc: '远端 reclaimable 接口的子路径。',
        type: 'string',
      },
      {
        key: 'extender.queueOverusedVerb',
        label: 'queueOverusedVerb',
        desc: '远端 queueOverused 接口的子路径。',
        type: 'string',
      },
      {
        key: 'extender.jobEnqueueableVerb',
        label: 'jobEnqueueableVerb',
        desc: '远端 jobEnqueueable 接口的子路径。',
        type: 'string',
      },
      {
        key: 'extender.jobReadyVerb',
        label: 'jobReadyVerb',
        desc: '远端 jobReady 接口的子路径。',
        type: 'string',
      },
      {
        key: 'extender.allocateFuncVerb',
        label: 'allocateFuncVerb',
        desc: 'allocate 阶段回调 webhook 的子路径。',
        type: 'string',
      },
      {
        key: 'extender.deallocateFuncVerb',
        label: 'deallocateFuncVerb',
        desc: 'deallocate 阶段回调 webhook 的子路径。',
        type: 'string',
      },
      {
        key: 'extender.onSessionOpenVerb',
        label: 'onSessionOpenVerb',
        desc: 'session 开启时的钩子子路径。',
        type: 'string',
      },
      {
        key: 'extender.onSessionCloseVerb',
        label: 'onSessionCloseVerb',
        desc: 'session 关闭时的钩子子路径。',
        type: 'string',
      },
    ],
  },
  capacity: {
    label: 'capacity',
    desc: 'Capacity 调度（V1.9+）：按 Queue 的 deserved/capability 资源声明做容量调度，是 proportion 的精细化版本。',
    callbacks: [
      'enableQueueOrder',
      'enableJobEnqueued',
      'enabledAllocatable',
      'enablePreemptive',
      'enablePredicate',
      'enableReclaimable',
      'enableHierarchy',
    ],
  },
  resourcequota: {
    label: 'resourcequota',
    desc: '让 Volcano 调度器尊重 K8s 原生 ResourceQuota；和 Volcano queue 配额并行起作用。',
    callbacks: ['enableJobEnqueued'],
  },
  pdb: {
    label: 'pdb',
    desc: '尊重 K8s PodDisruptionBudget：抢占 / 回收时不破坏 PDB 约束。',
    callbacks: ['enablePreemptable', 'enableReclaimable', 'enabledVictim'],
  },
  cdp: {
    label: 'cdp',
    desc: 'Cooldown Protection：作业刚启动后的冷却保护，避免立刻被抢占 / 回收。',
    callbacks: ['enablePreemptable', 'enableReclaimable'],
  },
  sla: {
    label: 'sla',
    desc: 'SLA 保障：给 Job annotation 设置 sla-waiting-time，超时未调度的作业升优先级。',
    callbacks: ['enableJobOrder', 'enableJobPipelined', 'enableJobEnqueued'],
    args: [
      {
        key: 'sla-waiting-time',
        label: 'sla-waiting-time',
        desc: '默认 SLA 等待时间，Go duration 格式（如 1h30m）；Job 自身 annotation 可覆盖。',
        type: 'string',
      },
    ],
  },
  nodegroup: {
    label: 'nodegroup',
    desc: '按 Queue.spec.affinity.nodeGroupAffinity 的节点组亲和性筛选节点。',
    callbacks: ['enablePredicate', 'enableNodeOrder'],
    args: [
      {
        key: 'strict',
        label: 'strict',
        desc: '严格模式：不匹配 nodeGroup 的节点直接拒绝，而不是只打分。',
        type: 'bool',
        default: true,
      },
      {
        key: 'enablePreferredOrder',
        label: 'enablePreferredOrder',
        desc: '启用 preferred 顺序排序（影响 preferredAffinity 行为）。',
        type: 'bool',
        default: false,
      },
    ],
  },
  'resource-strategy-fit': {
    label: 'resource-strategy-fit',
    desc: '基于资源策略的节点打分（按节点资源整体偏好做加权，配合 LeastRequest / MostRequest 微调）。',
    callbacks: ['enablePredicate', 'enableNodeOrder'],
    args: [
      {
        key: 'resourceStrategyFitWeight',
        label: 'resourceStrategyFitWeight',
        desc: 'resource-strategy-fit 在节点总分中的权重。',
        type: 'int',
        default: 10,
        min: 0,
      },
      {
        key: 'sra.weight',
        label: 'sra.weight',
        desc: 'SRA（Spread-Reservation-Aware）子打分权重。',
        type: 'int',
        min: 0,
      },
      {
        key: 'resources',
        label: 'resources',
        desc: '按资源粒度的策略配置 (map[ResourceName]ResourcesType)，嵌套结构，建议在 YAML 视图编辑。',
        type: 'object',
      },
      {
        key: 'proportional',
        label: 'proportional',
        desc: '按比例分配的子策略配置（嵌套结构，YAML 视图编辑）。',
        type: 'object',
      },
      {
        key: 'sra',
        label: 'sra',
        desc: 'SRA 子策略配置（嵌套结构，YAML 视图编辑）。',
        type: 'object',
      },
    ],
  },
  rescheduling: {
    label: 'rescheduling',
    desc: '基于指标的周期性 rescheduling（迁移占用过高节点上的低优先级 pod）。',
    callbacks: ['enabledVictim'],
    args: [
      {
        key: 'interval',
        label: 'interval',
        desc: '检查间隔，Go duration 格式（如 5m）。',
        type: 'string',
        default: '5m',
      },
      {
        key: 'metricsPeriod',
        label: 'metricsPeriod',
        desc: '采集 metrics 的回看窗口。',
        type: 'string',
        default: '5m',
      },
      {
        key: 'strategies',
        label: 'strategies',
        desc: '具体策略数组（复杂嵌套，建议 YAML 视图编辑）。',
        type: 'object',
      },
    ],
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────

// metaFor returns a Meta entry for any name; falls back to a generic
// "user-defined" descriptor for plugins/actions we don't recognise
// (custom builds, internal forks).
export function metaForAction(name: string): ActionMeta {
  return (
    ACTIONS_META[name] ?? {
      label: name,
      desc: '自定义 action（不在 KPilot 内置说明清单里）。',
    }
  );
}

export function metaForPlugin(name: string): PluginMeta {
  return (
    PLUGINS_META[name] ?? {
      label: name,
      desc: '自定义 plugin（不在 KPilot 内置说明清单里）。',
    }
  );
}

// Sorted name lists for Select option rendering — built-ins first
// (declared above), in declaration order so the Select dropdown is
// stable and predictable.
export const ACTION_NAMES = Object.keys(ACTIONS_META);
export const PLUGIN_NAMES = Object.keys(PLUGINS_META);

// Set of all keys known to ArgSpec / EnableSpec / "name" — used by the
// form view to bucket a PluginEntry's keys into "known typed",
// "unknown extra". Unknown extras get rendered in a small key/value
// editor below the typed fields so user-added fields survive
// round-trip.
export function knownPluginKeys(pluginName: string): Set<string> {
  const set = new Set<string>(['name']);
  for (const e of ENABLE_FIELDS) set.add(e.key);
  const meta = PLUGINS_META[pluginName];
  if (meta?.args) for (const a of meta.args) set.add(a.key);
  return set;
}
