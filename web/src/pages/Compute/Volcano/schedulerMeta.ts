// schedulerMeta — actions and plugins recognised by the Volcano
// scheduler, with short Chinese descriptions for the in-page help
// experience. The scheduler page renders these alongside the user's
// actual config so beginners can read what each knob does without
// jumping out to the Volcano docs.
//
// Sources: Volcano source pkg/scheduler/{actions,plugins}/*.go and
// upstream docs. Keep entries terse — one sentence each. Anything
// not in this file falls through to a generic "未知 / 自定义" rendering
// so user-extended schedulers don't break the page.

export interface Meta {
  // Display label (the canonical Volcano name — kept English even in
  // zh-CN since these are well-known terms).
  label: string;
  // One-line zh-CN description aimed at a Volcano beginner.
  desc: string;
}

// Actions run in order each scheduling cycle. The order in the
// configmap matters — preempt before allocate gives different
// behaviour than allocate before preempt. We list defaults a typical
// install ships with first; rare ones at the end.
export const ACTIONS_META: Record<string, Meta> = {
  enqueue: {
    label: 'enqueue',
    desc: '把 Pending 状态的 PodGroup 推进到 Inqueue —— 决定本轮哪些作业能进入调度循环（受 overcommit / proportion 等插件限制）。',
  },
  allocate: {
    label: 'allocate',
    desc: '给已 Inqueue 的 PodGroup 在节点上找资源并预留。是最核心的调度阶段。',
  },
  preempt: {
    label: 'preempt',
    desc: '同 Queue 内的高优先级作业可以驱逐已运行的低优先级作业（preempt within queue）。',
  },
  reclaim: {
    label: 'reclaim',
    desc: '跨 Queue 资源回收：自己 Queue 不够用时，从其它"有空闲且 reclaimable=true"的 Queue 抢资源回来。',
  },
  backfill: {
    label: 'backfill',
    desc: '给资源请求模糊（best-effort）的小作业填空闲槽位 —— 只在大作业还没排到的间隙发生，不阻塞主调度。',
  },
  shuffle: {
    label: 'shuffle',
    desc: '节点级再平衡：Volcano 1.7+ 才有，把压力大节点上的 pod 迁到轻载节点，需要配合驱逐策略。',
  },
};

// Plugins drive the scoring + admission logic. They're grouped into
// "tiers" in the configmap: tier-1 plugins evaluate first, only when
// they all pass do we move to tier-2. This lets you put "must
// satisfy" hard rules (gang, priority) in tier-1 and "nice to have"
// scoring (binpack, drf) in tier-2 — common pattern in production.
export const PLUGINS_META: Record<string, Meta> = {
  priority: {
    label: 'priority',
    desc: '按 PriorityClass 给 PodGroup 排序，高优先级先调度、被抢占的优先级低。',
  },
  gang: {
    label: 'gang',
    desc: '强制 minMember 个 pod 必须同时调度成功，否则本组都不启动。分布式训练 / MPI 必备。',
  },
  conformance: {
    label: 'conformance',
    desc: '把控制器自身的 pod（kube-system / volcano-system）排除在 Volcano 调度之外，让默认调度器接管。',
  },
  drf: {
    label: 'drf',
    desc: 'Dominant Resource Fairness —— 多用户共享时，按"用户最紧张那个资源"的比例公平分配。',
  },
  proportion: {
    label: 'proportion',
    desc: '按 Queue.weight 比例切分集群资源；多 Queue 共存的核心策略。',
  },
  predicates: {
    label: 'predicates',
    desc: 'K8s 原生节点筛选：亲和、污点、资源是否够。沿用 default-scheduler 的所有 predicate。',
  },
  nodeorder: {
    label: 'nodeorder',
    desc: '节点打分：综合空闲资源、镜像本地性、节点平衡度。allocate 阶段挑节点用的。',
  },
  binpack: {
    label: 'binpack',
    desc: '装箱策略：把 pod 集中到少数节点，留出整块空节点给将来的大作业。跟 nodeorder 互补。',
  },
  overcommit: {
    label: 'overcommit',
    desc: '允许 Queue 在调度时短暂超额（防止 enqueue 阶段过早卡死）。生产环境常和 proportion 一起开。',
  },
  deviceshare: {
    label: 'deviceshare',
    desc: 'GPU 设备共享调度。启用后才识别 volcano.sh/vgpu-* 资源；和 volcano-vgpu-device-plugin 配套使用。',
  },
  tdm: {
    label: 'tdm',
    desc: 'Time Division Multiplexing —— 时间维度的节点亲和（例如离线作业晚上跑、白天让出）。',
  },
  'numa-aware': {
    label: 'numa-aware',
    desc: 'NUMA 拓扑感知：把 CPU + 内存绑定到同一个 NUMA 节点上，减少跨 socket 访问开销。',
  },
  'network-topology-aware': {
    label: 'network-topology-aware',
    desc: '网络拓扑感知：配合 HyperNode 把 NCCL 任务收紧到同一机架 / spine 内，减少跨拓扑通信。',
  },
  'task-topology': {
    label: 'task-topology',
    desc: 'Job 内任务亲和：master + worker 协同放置，例如 ps + worker 必须在不同节点。',
  },
  usage: {
    label: 'usage',
    desc: '基于实时利用率给节点打分，避开热点节点。需要 metrics 数据源（Prometheus / VictoriaMetrics）。',
  },
  extender: {
    label: 'extender',
    desc: '调度器扩展点：通过 webhook 接外部决策服务。复杂场景的逃生口。',
  },
  cdp: {
    label: 'cdp',
    desc: 'Capacity Definition Plugin —— 动态算力供给（例如根据时段从云上弹出节点）。',
  },
  resourcequota: {
    label: 'resourcequota',
    desc: '让 Volcano 调度器尊重 K8s 原生 ResourceQuota；和 Volcano queue 配额并行起作用。',
  },
  podgroup: {
    label: 'podgroup',
    desc: '处理 PodGroup 状态机的内置插件（一般无需手动加，gang 已经覆盖大部分场景）。',
  },
};

// metaFor returns a Meta entry for any name; falls back to a generic
// "user-defined" descriptor for plugins/actions we don't recognise
// (custom builds, internal forks).
export function metaForAction(name: string): Meta {
  return (
    ACTIONS_META[name] ?? {
      label: name,
      desc: '自定义 action（不在 KPilot 内置说明清单里）。',
    }
  );
}

export function metaForPlugin(name: string): Meta {
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
