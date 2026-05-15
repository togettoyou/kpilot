export default {
  // Embedded Grafana page (shared between monitoring and logging)
  'pages.embed.depState.ready': 'Running',
  'pages.embed.depState.installing': 'Installing',
  'pages.embed.depState.failed': 'Failed',
  'pages.embed.depState.missing': 'Not enabled',
  'pages.embed.cta.goPlugins': 'Go to plugins',
  'pages.embed.cta.refresh': 'Refresh',
  'pages.embed.cta.enable': 'Enable',
  'pages.embed.openFullscreen': 'Open in new tab',
  'pages.embed.openFullscreen.tooltip':
    'Open Grafana fullscreen in a new tab for a wider dashboard view.',

  // Compute Scheduling sub-pages
  'pages.compute.landing.title': 'Compute Scheduling',
  'pages.compute.landing.subtitle':
    'Volcano-powered batch scheduling + GPU virtualization. Pick a cluster.',
  'pages.compute.landing.empty.title': 'No clusters yet',
  'pages.compute.landing.empty.hint':
    'Add and connect a cluster in Cluster Management first, then come back here',
  'pages.compute.landing.empty.action': 'Go to Cluster Management',
  'pages.compute.volcano.notInstalled.title': 'Volcano is not installed on this cluster',
  'pages.compute.volcano.notInstalled.subTitle':
    'Queue / Job / PodGroup are provided by the Volcano scheduler. Enable the Volcano plugin on this cluster, then come back.',
  'pages.compute.volcano.notInstalled.action': 'Go to plugins and enable Volcano',

  // Form / YAML dual-view shared copy
  'pages.compute.form.tab.form': 'Form',
  'pages.compute.form.tab.yaml': 'YAML',
  'pages.compute.form.yamlError': 'YAML parse failed, can\'t switch view',

  // Queue form + actions
  'pages.compute.queue.create': 'New Queue',
  'pages.compute.queue.col.state': 'State',
  'pages.compute.queue.col.detail': 'Spec / Allocated',
  'pages.compute.queue.action.open': 'Open',
  'pages.compute.queue.action.close': 'Close',
  'pages.compute.queue.confirm.open': 'Open queue "{name}"? PodGroups in this queue can be scheduled again.',
  'pages.compute.queue.confirm.close': 'Close queue "{name}"? No new PodGroups will be scheduled; running ones are unaffected.',
  'pages.compute.queue.opened': 'Open command sent',
  'pages.compute.queue.closed': 'Close command sent',
  'pages.compute.queueForm.title': 'New Volcano Queue',
  'pages.compute.queueForm.editTitle': 'Edit Volcano Queue',
  'pages.compute.queueForm.submit': 'Create',
  'pages.compute.queueForm.update': 'Save',
  'pages.compute.queueForm.success': 'Queue created',
  'pages.compute.queueForm.updated': 'Queue updated',
  'pages.compute.queueForm.name': 'Name',
  'pages.compute.queueForm.name.extra': 'DNS-1123: lowercase, digits, hyphens, up to 63 chars',
  // ResourceIntro — one-line "what is this" hint at the top of each CR page
  'pages.compute.intro.queue':
    'Resource-pool abstraction. Allocates exclusive/shared quotas to workloads; the capacity / proportion plugins divide cluster resources by weight.',
  'pages.compute.intro.job':
    'Volcano-native batch job. Adds gang scheduling (minAvailable pods must start together), multi-task coordination, and Queue quotas on top of native K8s Job. Essential for distributed training / MPI.',
  'pages.compute.intro.cronjob':
    'Cron-triggered Volcano Job. Same idea as K8s CronJob, but the produced instances are vcjobs (gang-scheduled).',
  'pages.compute.intro.podgroup':
    'The gang-scheduling unit: all-or-nothing scheduling for a pod set, avoiding "half-started" distributed-job deadlocks. Auto-created by Volcano Job; also creatable standalone for raw Pods.',
  'pages.compute.intro.hypernode':
    'Network-topology grouping. Models switch tiers (rack / spine / cluster); the network-topology-aware plugin uses it to keep training jobs inside a single NCCL domain.',
  'pages.compute.intro.jobflow':
    'DAG orchestration over Volcano Jobs. Each node references a JobTemplate; dependsOn (optionally with HTTP / TCP / task-status probes) defines edges. Fits pipelines like data-prep → train → eval. Requires the jobflow sub-chart to be enabled.',
  'pages.compute.intro.jobtemplate':
    'Reusable Volcano Job blueprint. Does nothing on its own — referenced by JobFlow, so you don\'t inline a full JobSpec in every flow node. Requires the jobflow sub-chart.',
  'pages.compute.intro.numatopology':
    'Per-node NUMA topology + CPU layout. Auto-maintained by the volcano-resource-exporter DaemonSet (read-only). The numa-aware plugin scores nodes using this data.',
  'pages.compute.intro.nodeshard':
    'Carves a subset of nodes for a specific Volcano scheduler instance. Only relevant when running multiple Volcano schedulers; single-scheduler clusters (most cases) do not need this. Requires Volcano 1.10+.',
  'pages.compute.intro.colocationconfiguration':
    'Memory-QoS overlay for online/offline colocation. Configures memory.high / memory.low / memory.min cgroup ratios for the matchLabels-selected pods. Requires volcano-agent + kernel cgroup memory support.',
  'pages.compute.intro.vgpu':
    'Live Volcano vGPU breakdown: every physical card\'s UUID / model / memory + compute utilization, and the Pods currently slicing it. Requires the volcano-vgpu-device-plugin installed cluster-side (Plugins → vGPU), and deviceshare.VGPUEnable turned on in the scheduler config.',

  // vGPU page
  'pages.compute.vgpu.kpi.nodes.healthy': '{n} healthy',
  'pages.compute.vgpu.kpi.nodes.degraded': '{n} degraded',
  'pages.compute.vgpu.search.placeholder': 'Search pod name / namespace',
  'pages.compute.vgpu.search.empty': 'No nodes or pods matching "{q}"',
  'pages.compute.vgpu.healthBanner.title':
    '{cards} card(s) on {nodes} node(s) reporting issues',
  'pages.compute.vgpu.healthBanner.desc':
    'Expand the affected node row to see which cards are bad, or check node / device-plugin status in cluster management.',
  'pages.compute.vgpu.empty.title':
    'Cluster has GPUs but nothing is using vGPU.',
  'pages.compute.vgpu.empty.desc':
    'Submit a test Volcano Job to verify the scheduling path.',
  'pages.compute.vgpu.empty.action': 'Go to jobs →',
  'pages.compute.jobForm.immutable.banner.title':
    'Most Volcano Job fields are immutable after creation',
  'pages.compute.jobForm.immutable.banner.desc':
    'Only minAvailable, each task\'s replicas, and priorityClassName can be updated. To change the image, command, env, resources, imagePullPolicy, or any other field, delete this Job and create a new one.',
  'pages.compute.jobForm.immutable.violation':
    'These fields are immutable on a Volcano Job: {fields}. Delete the Job and recreate it.',
  'pages.compute.vgpu.card.col.cores.tip':
    'compute share — percentage (0-100) allocated to the vGPU. HAMi enforces memory strictly; cores is advisory: the scheduler uses it for scoring but does not hard-enforce SM time-slice partitioning.',
  'pages.compute.vgpu.kpi.cards': 'Cards',
  'pages.compute.vgpu.kpi.slots': 'vGPU slots',
  'pages.compute.vgpu.kpi.memory': 'Memory',
  'pages.compute.vgpu.kpi.cores': 'Cores',
  'pages.compute.vgpu.kpi.nodes': 'GPU nodes',
  'pages.compute.vgpu.node.title': 'Nodes',
  'pages.compute.vgpu.node.col.name': 'Node',
  'pages.compute.vgpu.node.col.health': 'Health',
  'pages.compute.vgpu.node.col.cards': 'Cards',
  'pages.compute.vgpu.node.col.slots': 'Slots',
  'pages.compute.vgpu.node.col.memory': 'Memory',
  'pages.compute.vgpu.node.col.cores': 'Cores',
  'pages.compute.vgpu.node.col.types': 'GPU types',
  'pages.compute.vgpu.card.col.type': 'Model',
  'pages.compute.vgpu.card.col.health': 'Health',
  'pages.compute.vgpu.card.col.sharing': 'Sharing',
  'pages.compute.vgpu.card.col.slots': 'Slots',
  'pages.compute.vgpu.card.col.memory': 'Memory',
  'pages.compute.vgpu.card.col.cores': 'Cores',
  'pages.compute.vgpu.card.col.pods': 'Pods',
  'pages.compute.vgpu.card.pods.idle': 'idle',
  'pages.compute.vgpu.notInstalled.title': 'vGPU device-plugin not installed',
  'pages.compute.vgpu.notInstalled.subTitle':
    'Enable volcano-vgpu-device-plugin on this cluster to see GPU slicing data. Once the DaemonSet is ready this page populates automatically.',
  'pages.compute.vgpu.notInstalled.action': 'Go to plugins',

  'pages.compute.queueForm.weight': 'Weight',
  'pages.compute.queueForm.weight.extra': 'Resources are split between queues proportional to weight; higher = preferred',
  'pages.compute.queueForm.priority': 'Priority',
  'pages.compute.queueForm.priority.extra':
    'Optional, non-negative integer (default 0). Higher = scheduled first AND reclaimed last (counter-intuitive: high-priority queues lose resources last).',
  'pages.compute.queueForm.reclaimable': 'Reclaimable',
  'pages.compute.queueForm.reclaimable.extra': 'Allow other queues to reclaim this queue\'s resources under contention',
  'pages.compute.queueForm.parent': 'Parent queue',
  'pages.compute.queueForm.parent.extra': 'Optional — set when building hierarchical queues',
  'pages.compute.queueForm.capability': 'Capability (resource cap)',
  'pages.compute.queueForm.capability.extra':
    'Upper resource bound. Keys can be any K8s resource: cpu / memory / nvidia.com/gpu / volcano.sh/vgpu-{number,memory,cores}. Leave empty to keep unlimited.',
  'pages.compute.queueForm.capability.add': 'Add resource',
  'pages.compute.queueForm.deserved': 'Deserved',
  'pages.compute.queueForm.deserved.extra':
    'Resources the queue is normally entitled to. Excess can be lent to other queues and reclaimed back. Used by capacity / proportion plugins.',
  'pages.compute.queueForm.deserved.add': 'Add resource',
  'pages.compute.queueForm.guarantee': 'Guarantee',
  'pages.compute.queueForm.guarantee.extra':
    'Reserved resources — never lent out even if idle. Strong minimum reservation.',
  'pages.compute.queueForm.guarantee.add': 'Add resource',
  'pages.compute.queueForm.type': 'Type',
  'pages.compute.queueForm.type.extra':
    'Optional; defaults to "kube". Used in multi-cluster setups to tag queue origin.',
  'pages.compute.queueForm.affinity': 'Node-group affinity',
  'pages.compute.queueForm.affinity.extra':
    'Optional; consumed by the nodegroup scheduler plugin. Enter node-group names below; for richer affinity shapes edit via the YAML view.',
  'pages.compute.queueForm.affinity.required': 'Affinity – required',
  'pages.compute.queueForm.affinity.preferred': 'Affinity – preferred',
  'pages.compute.queueForm.antiAffinity.required': 'Anti-affinity – required',
  'pages.compute.queueForm.antiAffinity.preferred': 'Anti-affinity – preferred',
  'pages.compute.queueForm.affinity.placeholder': 'Comma- or enter-separated nodeGroup names',

  // Job form + actions
  'pages.compute.job.create': 'New Job',
  'pages.compute.job.action.menu': 'Action',
  'pages.compute.job.action.resume': 'Resume',
  'pages.compute.job.action.abort': 'Abort',
  'pages.compute.job.action.restart': 'Restart',
  'pages.compute.job.action.complete': 'Complete',
  'pages.compute.job.action.terminate': 'Terminate',
  'pages.compute.job.action.confirm': 'Run "{action}" on job "{name}"?',
  'pages.compute.job.commandSent': 'Command sent — the controller will process it shortly',
  'pages.compute.jobForm.title': 'New Volcano Job',
  'pages.compute.jobForm.editTitle': 'Edit Volcano Job',
  'pages.compute.jobForm.submit': 'Submit',
  'pages.compute.jobForm.update': 'Save',
  'pages.compute.jobForm.success': 'Job submitted',
  'pages.compute.jobForm.updated': 'Job updated',
  'pages.compute.jobForm.section.basic': 'Basics',
  'pages.compute.jobForm.section.tasks': 'Tasks',
  'pages.compute.jobForm.name': 'Name',
  'pages.compute.jobForm.namespace': 'Namespace',
  'pages.compute.jobForm.queue': 'Queue',
  'pages.compute.jobForm.queue.extra': 'Leave empty to use the default queue',
  'pages.compute.jobForm.priority': 'PriorityClass',
  'pages.compute.jobForm.minAvailable': 'minAvailable',
  'pages.compute.jobForm.minAvailable.extra':
    'Gang-scheduling minimum: this many pods must be co-scheduled before any can start. Defaults to total task replicas.',
  'pages.compute.jobForm.minSuccess': 'minSuccess',
  'pages.compute.jobForm.minSuccess.extra':
    'Job is marked Completed once this many pods reach Succeeded. Leave empty to use Volcano default (= total task replicas).',
  'pages.compute.jobForm.maxRetry': 'maxRetry',
  'pages.compute.jobForm.maxRetry.extra':
    'Maximum retries before the Job is marked Failed. Defaults to 3.',
  'pages.compute.jobForm.ttl': 'ttlSecondsAfterFinished',
  'pages.compute.jobForm.ttl.extra':
    'Seconds to wait after the Job reaches a terminal state before auto-deletion. 0 = delete immediately; empty = never auto-delete.',
  'pages.compute.jobForm.runningEstimate': 'Running estimate',
  'pages.compute.jobForm.runningEstimate.extra':
    'Go duration string (e.g. 1h30m / 45m / 2h). Hint consumed by the sla plugin and estimate-aware schedulers.',
  'pages.compute.jobForm.networkTopology': 'Network topology',
  'pages.compute.jobForm.networkTopology.extra':
    'Works with HyperNode CRD: bind the Job\'s pods to a topology domain. Volcano propagates this to the generated PodGroup.',
  'pages.compute.jobForm.ntMode': 'Mode',
  'pages.compute.jobForm.ntMode.placeholder': 'Disabled',
  'pages.compute.jobForm.ntTierAllowed': 'highestTierAllowed',
  'pages.compute.jobForm.ntTierName': 'highestTierName',
  'pages.compute.jobForm.plugins': 'Volcano plugins',
  'pages.compute.jobForm.plugins.extra':
    'env injects index env vars; svc creates a headless Service; ssh wires up authorized_keys; mpi/pytorch/tensorflow set up the matching distributed runtime',
  'pages.compute.jobForm.task.add': 'Add task',
  'pages.compute.jobForm.task.name': 'Task name',
  'pages.compute.jobForm.task.replicas': 'Replicas',
  'pages.compute.jobForm.task.restartPolicy': 'Restart policy',
  'pages.compute.jobForm.task.minAvailable': 'minAvailable',
  'pages.compute.jobForm.task.minAvailable.tip':
    'Minimum pods of THIS task that must co-schedule (independent of job-level minAvailable).',
  'pages.compute.jobForm.task.maxRetry': 'maxRetry',
  'pages.compute.jobForm.task.maxRetry.tip':
    'Retry budget for this task (independent of job-level maxRetry).',
  'pages.compute.jobForm.task.topologyPolicy': 'topologyPolicy',
  'pages.compute.jobForm.task.topologyPolicy.tip':
    'NUMA policy: none / best-effort / restricted / single-numa-node',
  'pages.compute.jobForm.task.topologyPolicy.placeholder': 'Unconstrained',
  'pages.compute.jobForm.task.resources.extras':
    'Extended resources (GPU / ephemeral-storage / hugepages-* / custom) — written to limits per K8s convention',
  'pages.compute.jobForm.task.resources.extras.add': 'Add resource',
  'pages.compute.queueForm.extras.label':
    'Other resources (nvidia.com/gpu / ephemeral-storage / custom extended)',
  'pages.compute.queueForm.gpu.number': 'vGPU slots',
  'pages.compute.queueForm.gpu.number.tip':
    'Queue-wide vGPU slot quota (volcano.sh/vgpu-number). Sum of all running pods\' vgpu-number cannot exceed this. Empty = no limit.',
  'pages.compute.queueForm.gpu.memory': 'vGPU memory',
  'pages.compute.queueForm.gpu.memory.tip':
    'Queue-wide vGPU memory quota in MiB (volcano.sh/vgpu-memory). Sum of all running pods\' vgpu-memory cannot exceed this. Empty = no limit.',
  'pages.compute.queueForm.gpu.cores': 'vGPU cores',
  'pages.compute.queueForm.gpu.cores.tip':
    'Queue-wide vGPU compute share quota (volcano.sh/vgpu-cores, summed %). Empty = no limit. Advisory: HAMi does not hard-enforce SM time-slicing by default.',
  'pages.compute.jobForm.task.image': 'Image',
  'pages.compute.jobForm.task.imagePullPolicy': 'Pull policy',
  'pages.compute.jobForm.task.imagePullPolicy.placeholder': 'Auto',
  'pages.compute.jobForm.task.imagePullPolicy.tip':
    'imagePullPolicy. Leave empty to let kubelet derive from the image tag (:latest / no tag → Always; otherwise → IfNotPresent).',
  'pages.compute.jobForm.task.command': 'command',
  'pages.compute.jobForm.task.args': 'args',
  'pages.compute.jobForm.task.resources': 'Resource requests (empty = unlimited)',
  'pages.compute.jobForm.task.gpu.number': 'GPU count',
  'pages.compute.jobForm.task.gpu.number.tip':
    'Requested vGPU slots (volcano.sh/vgpu-number). 1 = whole card on a non-shared cluster; under HAMi this is the number of slices. Empty = no GPU.',
  'pages.compute.jobForm.task.gpu.memory': 'GPU memory',
  'pages.compute.jobForm.task.gpu.memory.tip':
    'Memory cap per vGPU slot, in MiB (volcano.sh/vgpu-memory). Enforced inside the container by HAMi. Empty = no per-slice memory limit.',
  'pages.compute.jobForm.task.gpu.cores': 'GPU cores',
  'pages.compute.jobForm.task.gpu.cores.tip':
    'SM compute share per vGPU slot, 0-100% (volcano.sh/vgpu-cores). Advisory: HAMi does not hard-enforce SM time-slicing by default; mostly used for scheduler scoring. Empty = no cap.',

  // CronJob form + actions
  'pages.compute.cronJob.create': 'New CronJob',
  'pages.compute.cronJob.col.state': 'State',
  'pages.compute.cronJob.action.suspend': 'Suspend',
  'pages.compute.cronJob.action.resume': 'Resume',
  'pages.compute.cronJob.confirm.suspend': 'Suspend cronjob "{name}"? No new jobs will trigger until you resume.',
  'pages.compute.cronJob.confirm.resume': 'Resume cronjob "{name}"?',
  'pages.compute.cronJob.suspended': 'Suspended',
  'pages.compute.cronJob.resumed': 'Resumed',
  'pages.compute.cronJobForm.title': 'New Volcano CronJob',
  'pages.compute.cronJobForm.editTitle': 'Edit Volcano CronJob',
  'pages.compute.cronJobForm.submit': 'Submit',
  'pages.compute.cronJobForm.update': 'Save',
  'pages.compute.cronJobForm.success': 'CronJob created',
  'pages.compute.cronJobForm.updated': 'CronJob updated',
  'pages.compute.cronJobForm.schedule': 'Cron schedule',
  'pages.compute.cronJobForm.schedule.extra': 'Standard 5-field cron, e.g. "0 * * * *" = every hour at :00',
  'pages.compute.cronJobForm.concurrency': 'Concurrency policy',
  'pages.compute.cronJobForm.timeZone': 'Time zone',
  'pages.compute.cronJobForm.timeZone.extra':
    'IANA TZ name (e.g. Asia/Shanghai). Leave empty to use the controller-manager container\'s local TZ.',
  'pages.compute.cronJobForm.startingDeadline': 'startingDeadlineSeconds',
  'pages.compute.cronJobForm.startingDeadline.extra':
    'Max seconds late a missed trigger can be before it counts as Failed. Empty = no limit.',
  'pages.compute.cronJobForm.successHistory': 'Successful job history',
  'pages.compute.cronJobForm.failedHistory': 'Failed job history',

  // Scheduler configmap viewer / editor
  'pages.compute.scheduler.title': 'Volcano scheduler config',

  // Scheduling overview dashboard
  'pages.compute.overview.title': 'Volcano overview',
  'pages.compute.overview.truncated':
    'Some resource counts exceeded the list endpoint cap (500). Charts only reflect what was returned.',
  'pages.compute.overview.empty':
    'No Volcano resources in the current namespace',
  'pages.compute.overview.kpi.queues': 'Queues',
  'pages.compute.overview.kpi.jobs': 'Jobs',
  'pages.compute.overview.kpi.pods.running': 'Running pods',
  'pages.compute.overview.kpi.pods.pending': 'Pending pods',
  'pages.compute.overview.kpi.jobs.failed': 'Failed jobs',
  'pages.compute.overview.kpi.cronjobs': 'CronJobs',
  'pages.compute.overview.kpi.hypernodes': 'HyperNodes',
  'pages.compute.overview.queues.title': 'Queue resource usage',
  'pages.compute.overview.queues.subtitle':
    '{n} queue(s) · bounded by util desc first, then unbounded by absolute use',
  'pages.compute.overview.queues.empty':
    'No queues, or no capability / allocated data on any queue',
  'pages.compute.overview.queues.col.queue': 'Queue',
  'pages.compute.overview.jobs.empty':
    'No Volcano jobs in this namespace',
  'pages.compute.overview.hypernodes.title': 'HyperNode tier distribution',
  'pages.compute.overview.hypernodes.subtitle': '{n} HyperNode(s)',
  'pages.compute.overview.kpi.wait.max': 'Max wait',
  'pages.compute.overview.capacity.title': 'Cluster resource utilization',
  'pages.compute.overview.capacity.overloaded':
    'Utilization is over 85% — scheduling pressure',
  'pages.compute.overview.gauge.cpu': 'CPU',
  'pages.compute.overview.gauge.memory': 'Memory',
  'pages.compute.overview.gauge.gpu': 'GPU',
  'pages.compute.overview.gauge.unbounded': 'Unbounded',
  'pages.compute.overview.scheduler.title': 'Scheduler snapshot',
  'pages.compute.overview.scheduler.actions': 'Actions',
  'pages.compute.overview.scheduler.tier': 'Tier {n}',
  'pages.compute.overview.jobByQueue.title': 'Queue × job state',
  'pages.compute.overview.jobByQueue.subtitle':
    'Job state distribution stacked per queue',
  'pages.compute.overview.jobByQueue.empty': 'No jobs to stack',
  'pages.compute.overview.hierarchy.title': 'Queue hierarchy',
  'pages.compute.overview.hierarchy.subtitle': 'Built from spec.parent',
  'pages.compute.overview.hierarchy.empty':
    'No queues, or all queues are flat (no parent relations)',
  'pages.compute.overview.failed.title': 'Failed jobs',
  'pages.compute.overview.failed.empty':
    'No failed / terminated / aborted jobs ✓',
  'pages.compute.overview.failed.jump': 'View all jobs',
  'pages.compute.overview.recent.title': 'Recent jobs',
  'pages.compute.overview.recent.empty': 'No jobs in this namespace',
  'pages.compute.overview.recent.jump': 'View all jobs',
  'pages.compute.overview.phases.title': 'Job / PodGroup / JobFlow phases',
  'pages.compute.overview.phases.subtitle':
    'Horizontal stacked bars — segment length = count',
  'pages.compute.overview.phases.kind.job': 'Job',
  'pages.compute.overview.phases.kind.podgroup': 'PodGroup',
  'pages.compute.overview.phases.kind.jobflow': 'JobFlow',
  'pages.compute.overview.pendingByQueue.title': 'Pending pods by queue',
  'pages.compute.overview.pendingByQueue.subtitle':
    'Sorted desc by pending count (top 10)',
  'pages.compute.overview.pendingByQueue.empty': 'No pods are pending ✓',
  'pages.compute.overview.hierarchy.flat':
    'All queues are flat — no parent relations',
  'pages.compute.overview.unused.title': 'Not in use:',
  'pages.compute.overview.unused.jobflows': 'JobFlow',
  'pages.compute.overview.unused.hypernodes': 'HyperNode',
  'pages.compute.job.stateFilter': 'Filtered: state = {state}',
  'pages.compute.scheduler.intro':
    'Volcano schedules in two layers: actions control the per-round workflow (when to enqueue / allocate / preempt); plugins layer scoring + constraints in tiers (a tier must pass before the next one runs). Hover the ⓘ icons for one-liners; the collapsible reference at the bottom lists every action and plugin.',
  'pages.compute.scheduler.save': 'Save',
  'pages.compute.scheduler.saved': 'Saved — Volcano will pick up the new config in a few seconds',
  'pages.compute.scheduler.addTier': 'Add Tier',
  'pages.compute.scheduler.actions': 'Actions',
  'pages.compute.scheduler.actions.tip':
    'Phases run in order each cycle. Common: enqueue → allocate → backfill. Add preempt + reclaim if you need preemption.',
  'pages.compute.scheduler.actions.placeholder': 'Pick the actions to enable',
  'pages.compute.scheduler.tiers': 'Plugin Tiers',
  'pages.compute.scheduler.tiers.tip':
    'A tier is a group of plugins. Tiers are evaluated in order; a tier must pass before the next one runs. Convention: tier 1 holds hard constraints (priority / gang), tier 2 holds scoring + fairness (drf / proportion / nodeorder).',
  'pages.compute.scheduler.plugins.placeholder': 'Pick the plugins for this tier',
  'pages.compute.scheduler.noTiers': 'No tiers yet. Click "Add Tier" above to start.',
  'pages.compute.scheduler.help.actions': 'Action reference',
  'pages.compute.scheduler.help.plugins': 'Plugin reference',
  'pages.compute.scheduler.notFound.title': 'Scheduler ConfigMap not found',
  'pages.compute.scheduler.notFound.subtitle':
    'Could not find volcano-scheduler-configmap in namespace "{ns}". Make sure the Volcano plugin is enabled.',
  'pages.compute.scheduler.tier': 'Tier {n}',
  'pages.compute.scheduler.tier.pluginCount': '{n} plugin(s)',
  'pages.compute.scheduler.flow.title': 'Scheduling data flow',
  'pages.compute.scheduler.flow.button': 'View data flow',
  'pages.compute.scheduler.flow.fitView': 'Reset zoom',
  'pages.compute.scheduler.flow.start': 'Pending PodGroup',
  'pages.compute.scheduler.flow.start.desc':
    'Pending jobs entering the scheduling loop',
  'pages.compute.scheduler.flow.end': 'Scheduled',
  'pages.compute.scheduler.flow.end.desc': 'Pods bound to nodes',
  'pages.compute.scheduler.flow.empty':
    'No actions configured — no flow to render.',
  'pages.compute.scheduler.noPluginsInTier':
    'No plugins in this tier. Click "Add plugin" below to add one.',
  'pages.compute.scheduler.addPlugin': 'Add plugin',
  'pages.compute.scheduler.add': 'Add',
  'pages.compute.scheduler.plugin.args': 'Plugin arguments',
  'pages.compute.scheduler.plugin.enables': 'Advanced switches ({n} callbacks)',
  'pages.compute.scheduler.plugin.enables.none':
    'This plugin does not register any session callbacks gated by enable switches.',
  'pages.compute.scheduler.plugin.extras': 'Other fields',
  'pages.compute.scheduler.plugin.extras.hint':
    'The following keys are outside KPilot\'s known schema and are preserved as-is. Switch to the YAML view to edit them.',
  'pages.compute.scheduler.action.params': 'Action arguments (configurations)',
  'pages.compute.scheduler.metrics': 'Metrics data source',
  'pages.compute.scheduler.metrics.tip':
    'Metrics source for plugins (mainly usage) that need real-time node CPU/memory utilization. Volcano periodically polls this endpoint and feeds the readings into node scoring. Common keys: type (prometheus / prometheus_adaptor / elasticsearch), address, interval, tls.insecureSkipVerify; elasticsearch also accepts elasticsearch.index / .username / .password. Without this, usage-style plugins have no data to score on.',
  'pages.compute.scheduler.metrics.add': 'Add',
  'pages.compute.scheduler.metrics.empty':
    'No metrics source configured (usage-style plugins will be inert)',

  // Shared: result-truncated banner for list endpoints
  'pages.compute.list.truncated':
    'Result truncated to first {n} rows. Narrow the namespace or filter for more.',

  // Queue columns / cell text
  'pages.compute.queue.col.name': 'Name',
  'pages.compute.queue.col.parent': 'Parent',
  'pages.compute.queue.col.age': 'Age',
  'pages.compute.queue.state.unknown': 'Unknown',
  'pages.compute.queue.detail.weight': 'Weight',
  'pages.compute.queue.detail.notReclaimable': 'Not reclaimable',
  'pages.compute.queue.detail.unlimited': 'Unlimited',

  // Job columns
  'pages.compute.job.col.name': 'Name',
  'pages.compute.job.col.namespace': 'Namespace',
  'pages.compute.job.col.state': 'State',
  'pages.compute.job.col.queue': 'Queue',
  'pages.compute.job.col.minAvailable': 'minAvailable',
  'pages.compute.job.col.tasks': 'Tasks',
  'pages.compute.job.col.pods': 'Pods',
  'pages.compute.job.col.plugins': 'Plugins',
  'pages.compute.job.col.age': 'Age',

  // QueueForm capability tooltips
  'pages.compute.queueForm.tooltip.cpu': 'K8s quantity string. e.g. 10, 500m',
  'pages.compute.queueForm.tooltip.memory': 'K8s quantity string. e.g. 100Gi, 512Mi',
  'pages.compute.queueForm.tooltip.vgpuMemory': 'Unit: MiB',
  'pages.compute.queueForm.tooltip.vgpuCores': 'Percentage 0-100',

  // CronJob columns / state text
  'pages.compute.cronJob.col.name': 'Name',
  'pages.compute.cronJob.col.namespace': 'Namespace',
  'pages.compute.cronJob.col.schedule': 'Schedule',
  'pages.compute.cronJob.col.concurrency': 'Concurrency',
  'pages.compute.cronJob.col.active': 'Active',
  'pages.compute.cronJob.col.lastSchedule': 'Last schedule',
  'pages.compute.cronJob.col.age': 'Age',
  'pages.compute.cronJob.state.suspended': 'Suspended',
  'pages.compute.cronJob.state.running': 'Running',
  'pages.compute.cronJob.lastScheduleAgo': '{age} ago',

  // PodGroup columns
  'pages.compute.podGroup.col.name': 'Name',
  'pages.compute.podGroup.col.namespace': 'Namespace',
  'pages.compute.podGroup.col.phase': 'Phase',
  'pages.compute.podGroup.col.queue': 'Queue',
  'pages.compute.podGroup.col.minMember': 'minMember',
  'pages.compute.podGroup.col.minResources': 'minResources',
  'pages.compute.podGroup.col.pods': 'Pods',
  'pages.compute.podGroup.col.age': 'Age',

  // PodGroup form
  'pages.compute.podGroup.create': 'New PodGroup',
  'pages.compute.podGroupForm.title': 'New Volcano PodGroup',
  'pages.compute.podGroupForm.editTitle': 'Edit Volcano PodGroup',
  'pages.compute.podGroupForm.submit': 'Create',
  'pages.compute.podGroupForm.update': 'Save',
  'pages.compute.podGroupForm.success': 'PodGroup created',
  'pages.compute.podGroupForm.updated': 'PodGroup updated',
  'pages.compute.podGroupForm.name': 'Name',
  'pages.compute.podGroupForm.namespace': 'Namespace',
  'pages.compute.podGroupForm.queue': 'Queue',
  'pages.compute.podGroupForm.queue.extra': 'Leave empty to use the default queue',
  'pages.compute.podGroupForm.priority': 'priorityClassName',
  'pages.compute.podGroupForm.minMember': 'Min members to co-schedule (minMember)',
  'pages.compute.podGroupForm.minMember.extra':
    'Gang minimum pods. 0 disables gang scheduling — pods schedule independently',
  'pages.compute.podGroupForm.minTaskMember': 'Per-task minimums (minTaskMember)',
  'pages.compute.podGroupForm.minTaskMember.extra':
    'Per-task name → minimum count. Pick one of minTaskMember or subGroupPolicy; new configs should prefer subGroupPolicy (edit via YAML view)',
  'pages.compute.podGroupForm.minTaskMember.add': 'Add task',
  'pages.compute.podGroupForm.minResources': 'Minimum resources (minResources)',
  'pages.compute.podGroupForm.minResources.extra':
    'Resources the scheduler must reserve before the PodGroup is marked ready',
  'pages.compute.podGroupForm.minResources.add': 'Add resource',
  'pages.compute.podGroupForm.networkTopology': 'Network topology',
  'pages.compute.podGroupForm.networkTopology.extra':
    'Works with HyperNode CRD: constrain the PodGroup\'s pods to a network topology domain (rack / spine / ...)',
  'pages.compute.podGroupForm.ntMode': 'Mode',
  'pages.compute.podGroupForm.ntMode.placeholder': 'Disabled',
  'pages.compute.podGroupForm.ntMode.extra':
    'hard = required; soft = best-effort. Leave unset to disable topology-aware scheduling',
  'pages.compute.podGroupForm.ntTierAllowed': 'Highest tier allowed',
  'pages.compute.podGroupForm.ntTierAllowed.extra':
    'Maximum HyperNode tier pods can span; smaller = tighter. Mutually exclusive with highestTierName',
  'pages.compute.podGroupForm.ntTierName': 'Highest tier name',
  'pages.compute.podGroupForm.ntTierName.extra':
    'Mutually exclusive with highestTierAllowed; matches HyperNode.spec.tierName',

  // HyperNode columns
  'pages.compute.hyperNode.col.name': 'Name',
  'pages.compute.hyperNode.col.tier': 'Tier',
  'pages.compute.hyperNode.col.members': 'Members',
  'pages.compute.hyperNode.col.age': 'Age',

  // HyperNode form
  'pages.compute.hyperNode.create': 'New HyperNode',
  'pages.compute.hyperNodeForm.title': 'New Volcano HyperNode',
  'pages.compute.hyperNodeForm.editTitle': 'Edit Volcano HyperNode',
  'pages.compute.hyperNodeForm.submit': 'Create',
  'pages.compute.hyperNodeForm.update': 'Save',
  'pages.compute.hyperNodeForm.success': 'HyperNode created',
  'pages.compute.hyperNodeForm.updated': 'HyperNode updated',
  'pages.compute.hyperNodeForm.name': 'Name',
  'pages.compute.hyperNodeForm.tier': 'Tier',
  'pages.compute.hyperNodeForm.tier.extra':
    'Depth in the topology tree, >= 0. e.g. tier 0 = node, tier 1 = rack, tier 2 = spine / pod-of-racks',
  'pages.compute.hyperNodeForm.tierName': 'Tier name',
  'pages.compute.hyperNodeForm.tierName.extra':
    'Optional; PodGroup matches this via highestTierName when set',
  'pages.compute.hyperNodeForm.members': 'Members',
  'pages.compute.hyperNodeForm.members.extra':
    'Each member is either a Node or a lower-tier HyperNode. Pick exactly one selector branch: exactMatch / regexMatch / labelMatch',
  'pages.compute.hyperNodeForm.members.add': 'Add member',
  'pages.compute.hyperNodeForm.member.title': 'Member {n}',
  'pages.compute.hyperNodeForm.member.type': 'Type',
  'pages.compute.hyperNodeForm.member.selectorType': 'Selector',
  'pages.compute.hyperNodeForm.member.exactName': 'Exact name',
  'pages.compute.hyperNodeForm.member.exactName.extra':
    'Exact Node or lower HyperNode name (must already exist)',
  'pages.compute.hyperNodeForm.member.regex': 'Regex pattern',
  'pages.compute.hyperNodeForm.member.regex.extra':
    'RE2 pattern matched against resource names, e.g. ^node-[0-9]+$',
  'pages.compute.hyperNodeForm.member.labels.extra':
    'Match by node labels (only effective when member type is Node)',
  'pages.compute.hyperNodeForm.member.labels.add': 'Add label',

  // YAML-only create/edit drawer (shared)
  'pages.compute.yamlDrawer.success': 'Applied',
  'pages.compute.yamlDrawer.submit': 'Create',
  'pages.compute.yamlDrawer.save': 'Save',

  // JobFlow (flow.volcano.sh/v1alpha1)
  'pages.compute.jobFlow.create': 'New JobFlow',
  'pages.compute.jobFlow.create.title': 'New JobFlow',
  'pages.compute.jobFlow.edit.title': 'Edit JobFlow',
  'pages.compute.jobFlow.col.name': 'Name',
  'pages.compute.jobFlow.col.namespace': 'Namespace',
  'pages.compute.jobFlow.col.phase': 'Phase',
  'pages.compute.jobFlow.col.flows': 'Flows',
  'pages.compute.jobFlow.col.progress': 'Progress',
  'pages.compute.jobFlow.col.retainPolicy': 'Retain policy',
  'pages.compute.jobFlow.col.age': 'Age',

  // JobTemplate (flow.volcano.sh/v1alpha1)
  'pages.compute.jobTemplate.create': 'New JobTemplate',
  'pages.compute.jobTemplate.create.title': 'New JobTemplate',
  'pages.compute.jobTemplate.edit.title': 'Edit JobTemplate',
  'pages.compute.jobTemplate.col.name': 'Name',
  'pages.compute.jobTemplate.col.namespace': 'Namespace',
  'pages.compute.jobTemplate.col.queue': 'Queue',
  'pages.compute.jobTemplate.col.minAvailable': 'minAvailable',
  'pages.compute.jobTemplate.col.tasks': 'Tasks',
  'pages.compute.jobTemplate.col.priorityClassName': 'PriorityClass',
  'pages.compute.jobTemplate.col.age': 'Age',

  // Numatopology (nodeinfo.volcano.sh/v1alpha1) — read-only
  'pages.compute.numa.col.node': 'Node',
  'pages.compute.numa.col.policies': 'Policies',
  'pages.compute.numa.col.numaResources': 'NUMA resources',
  'pages.compute.numa.col.cpuCount': 'CPU count',
  'pages.compute.numa.col.reserved': 'Reserved',
  'pages.compute.numa.col.age': 'Age',

  // NodeShard (shard.volcano.sh/v1alpha1)
  'pages.compute.nodeShard.create': 'New NodeShard',
  'pages.compute.nodeShard.create.title': 'New NodeShard',
  'pages.compute.nodeShard.edit.title': 'Edit NodeShard',
  'pages.compute.nodeShard.created': 'NodeShard created',
  'pages.compute.nodeShard.updated': 'NodeShard updated',
  'pages.compute.nodeShard.name': 'Name',
  'pages.compute.nodeShard.name.extra':
    'DNS-1123 — shard identifier for multi-scheduler setups',
  'pages.compute.nodeShard.nodesDesired': 'Desired nodes',
  'pages.compute.nodeShard.nodesDesired.extra':
    "Names of nodes this shard should manage. The controller diffs against the live node set and surfaces toAdd / toRemove.",
  'pages.compute.nodeShard.nodesDesired.placeholder':
    'Comma- or enter-separated node names',
  'pages.compute.nodeShard.col.name': 'Name',
  'pages.compute.nodeShard.col.desired': 'Desired',
  'pages.compute.nodeShard.col.status': 'Status',
  'pages.compute.nodeShard.col.lastUpdate': 'Last update',
  'pages.compute.nodeShard.col.age': 'Age',

  // ColocationConfiguration (config.volcano.sh/v1alpha1)
  'pages.compute.colocation.create': 'New ColocationConfig',
  'pages.compute.colocation.create.title': 'New ColocationConfiguration',
  'pages.compute.colocation.edit.title': 'Edit ColocationConfiguration',
  'pages.compute.colocation.created': 'Created',
  'pages.compute.colocation.updated': 'Updated',
  'pages.compute.colocation.name': 'Name',
  'pages.compute.colocation.namespace': 'Namespace',
  'pages.compute.colocation.highRatio.extra':
    'Memory throttling ratio 0-100 (default 100)',
  'pages.compute.colocation.lowRatio.extra':
    'Memory priority protection ratio 0-100 (default 0)',
  'pages.compute.colocation.minRatio.extra':
    'Absolute memory protection ratio 0-100 (default 0)',
  'pages.compute.colocation.matchLabels': 'matchLabels',
  'pages.compute.colocation.matchLabels.extra':
    'Selects Pods via matchLabels. For complex selectors (matchExpressions etc.) use the YAML view.',
  'pages.compute.colocation.matchLabels.add': 'Add label',
  'pages.compute.colocation.matchExpressions.preserved':
    'This resource has matchExpressions selectors that are not editable in the form. They will be preserved on save — switch to YAML view to edit them.',
  'pages.compute.colocation.col.name': 'Name',
  'pages.compute.colocation.col.namespace': 'Namespace',
  'pages.compute.colocation.col.selector': 'Selector',
  'pages.compute.colocation.col.available': 'Available',
  'pages.compute.colocation.col.age': 'Age',

  // Plugin install log (Cluster Plugins page → View log)
  'pages.clusterPlugins.viewLog': 'View log',
  'pages.pluginInstallLog.title': '{name} · operation log',
  'pages.pluginInstallLog.running': 'In progress',
  'pages.pluginInstallLog.success': 'Success',
  'pages.pluginInstallLog.failed': 'Failed',
  'pages.pluginInstallLog.empty': 'Connecting to log stream…',
  'pages.pluginInstallLog.unavailable': 'Unavailable',
  'pages.pluginInstallLog.stale':
    'No log available: the 10-minute retention window has expired, or no operation is currently running. Re-run enable / disable to start a new log session.',

  'pages.models.landing.title': 'Model Serving',
  'pages.models.landing.subtitle':
    'Registry, deployment, chat playground, and routing — coming soon',
  'pages.models.landing.comingSoon': 'Coming soon',
  'pages.models.landing.registry.title': 'Model registry',
  'pages.models.landing.registry.desc':
    'Curated catalog of deployable models: runtime (vLLM / SGLang / TGI), images, recommended GPU shape',
  'pages.models.landing.deploy.title': 'Deployment',
  'pages.models.landing.deploy.desc':
    'Pick a model + target cluster + GPU count + replicas; produces Deployment + Service applied to the cluster',
  'pages.models.landing.chat.title': 'Chat playground',
  'pages.models.landing.chat.desc':
    'Built-in chat UI to verify a deployed model is up and behaving',
  'pages.models.landing.routing.title': 'Routing',
  'pages.models.landing.routing.desc':
    'OpenAI-compatible gateway: route by model param, support canary / A/B',

  // monitoring page (deps: grafana + victoria-metrics, dashboard: NodeExporterFull)
  'pages.monitoring.missing.title': 'Monitoring plugins are not enabled yet',
  'pages.monitoring.missing.subTitle':
    'Enable Grafana and VictoriaMetrics on this cluster — the dashboard will load here automatically once they finish installing.',
  'pages.monitoring.installing.title': 'Monitoring plugins are installing',
  'pages.monitoring.installing.subTitle':
    "Installation usually takes 1–2 minutes; this page auto-refreshes every 5s and will switch to the dashboard once it's ready.",
  'pages.monitoring.failed.title': 'Monitoring plugins failed to install',
  'pages.monitoring.failed.subTitle':
    'Open the plugins page to inspect the error and re-enable, or adjust values and retry.',
  'pages.monitoring.recommended':
    'Consider also enabling {names} for richer node-level metrics.',

  // logging page (deps: grafana + victoria-logs, dashboard: VictoriaLogs Explorer K8S)
  'pages.logging.missing.title': 'Logging plugins are not enabled yet',
  'pages.logging.missing.subTitle':
    'Enable Grafana and VictoriaLogs on this cluster — the dashboard will load here automatically once they finish installing.',
  'pages.logging.installing.title': 'Logging plugins are installing',
  'pages.logging.installing.subTitle':
    "Installation usually takes 1–2 minutes; this page auto-refreshes every 5s and will switch to the dashboard once it's ready.",
  'pages.logging.failed.title': 'Logging plugins failed to install',
  'pages.logging.failed.subTitle':
    'Open the plugins page to inspect the error and re-enable, or adjust values and retry.',
  'pages.logging.recommended':
    'Consider also enabling {names}.',

  'pages.layouts.userLayout.title':
    'Unified GPU + Model platform for Kubernetes',

  // plugin management
  'pages.plugins.title': 'Plugin Management',
  'pages.plugins.subtitle': 'Manage Helm chart plugins',
  'pages.plugins.add': 'Add Plugin',
  'pages.plugins.edit': 'Edit',
  'pages.plugins.delete': 'Delete',
  'pages.plugins.delete.confirm': 'Delete plugin "{name}"?',
  'pages.plugins.delete.success': 'Plugin deleted',
  'pages.plugins.enable.reset.unavailable':
    'Registry defaults could not be loaded — reset is disabled. Check network or retry.',
  'pages.plugins.builtin': 'Built-in',
  'pages.plugins.empty': 'No plugins',
  'pages.plugins.repoTag': 'Helm Repo',
  'pages.plugins.ociTag': 'OCI',
  'pages.plugins.localTag': 'Local',
  'pages.plugins.category.gpu': 'GPU',
  'pages.plugins.category.scheduling': 'Scheduling',
  'pages.plugins.category.networking': 'Networking',
  'pages.plugins.category.storage': 'Storage',
  'pages.plugins.category.monitoring': 'Monitoring',
  'pages.plugins.category.logging': 'Logging',
  'pages.plugins.category.security': 'Security',
  'pages.plugins.category.serving': 'Serving',
  'pages.plugins.category.custom': 'Custom',
  'pages.plugins.form.name': 'Name',
  'pages.plugins.form.namePlaceholder':
    'lowercase letters, digits, and hyphens (used as CRD name)',
  'pages.plugins.form.displayName': 'Display Name',
  'pages.plugins.form.description': 'Description',
  'pages.plugins.form.category': 'Category',
  'pages.plugins.form.iconURL': 'Icon URL',
  'pages.plugins.form.chartType': 'Chart Source',
  'pages.plugins.form.chartType.repo': 'Helm Repository',
  'pages.plugins.form.chartType.oci': 'OCI Registry',
  'pages.plugins.form.chartType.local': 'Local File',
  'pages.plugins.form.ociRef': 'OCI Reference',
  'pages.plugins.form.ociRef.hint':
    'Full oci:// URL, e.g. oci://docker.io/envoyproxy/gateway-helm',
  'pages.plugins.form.ociRef.invalid': 'Must start with oci://',
  'pages.plugins.form.chartRepo': 'Repo URL',
  'pages.plugins.form.chartRepoPlaceholder':
    'e.g. https://volcano-sh.github.io/helm-charts',
  'pages.plugins.form.chartName': 'Chart Name',
  'pages.plugins.form.chartNamePlaceholder': 'e.g. volcano',
  'pages.plugins.form.defaultVersion': 'Default Version',
  'pages.plugins.form.defaultVersionPlaceholder':
    'Leave empty to use the latest',
  'pages.plugins.form.defaultValues': 'Default values (YAML)',
  'pages.plugins.form.defaultReleaseNamespace': 'Default install namespace',
  'pages.plugins.form.upload': 'Upload chart file',
  'pages.plugins.form.uploadHint': 'Click or drag a .tgz file here',
  'pages.plugins.form.uploadSuccess': 'Uploaded: {filename}',
  'pages.plugins.create.success': 'Plugin created',
  'pages.plugins.update.success': 'Plugin updated',
  'pages.plugins.modal.create': 'Add Plugin',
  'pages.plugins.modal.edit': 'Edit Plugin',
  'pages.plugins.modal.view': 'View Plugin',
  'pages.plugins.modal.close': 'Close',
  'pages.plugins.modal.submit.create': 'Create',
  'pages.plugins.modal.submit.edit': 'Save',
  'pages.plugins.view': 'View',
  // per-cluster plugin page
  'pages.clusterPlugins.enable': 'Enable',
  'pages.clusterPlugins.disable': 'Disable',
  'pages.clusterPlugins.disable.confirm':
    'Disable "{name}"? This will uninstall the Helm release.',
  'pages.clusterPlugins.enableDrawer.title': 'Enable {name}',
  'pages.clusterPlugins.enableDrawer.viewTitle':
    'View {name} — currently applied',
  'pages.clusterPlugins.enableDrawer.values': 'values (YAML)',
  'pages.clusterPlugins.enableDrawer.version': 'Version',
  'pages.clusterPlugins.enableDrawer.versionPlaceholder':
    'Leave empty for default ({default})',
  'pages.clusterPlugins.enableDrawer.submit': 'Enable',
  'pages.clusterPlugins.enableDrawer.reset': 'Reset to defaults',
  'pages.clusterPlugins.enable.success': 'Enable request submitted',
  'pages.clusterPlugins.disable.success': 'Disable request submitted',
  'pages.clusterPlugins.phase.Disabled': 'Disabled',
  'pages.clusterPlugins.phase.Pending': 'Pending',
  'pages.clusterPlugins.phase.Installing': 'Installing',
  'pages.clusterPlugins.phase.Upgrading': 'Upgrading',
  'pages.clusterPlugins.phase.Running': 'Running',
  'pages.clusterPlugins.phase.Failed': 'Failed',
  'pages.clusterPlugins.phase.Uninstalling': 'Uninstalling',
  'pages.clusterPlugins.errorPopover.title': 'Error',
  'pages.clusterPlugins.errorPopover.copy': 'Copy',

  // api error codes
  'errors.INVALID_REQUEST': 'Invalid request',
  'errors.INTERNAL_ERROR': 'Internal server error',
  'errors.CLUSTER_NOT_FOUND': 'Cluster not found',
  'errors.CLUSTER_NAME_EXISTS': 'Cluster name already exists',
  'errors.LOGIN_INCORRECT': 'Incorrect username or password',
  'errors.NETWORK_ERROR': 'Network error, please try again',
  'errors.CLUSTER_NOT_CONNECTED':
    'Cluster not connected — Worker may be offline',
  'errors.WORKER_TIMEOUT': 'Cluster timed out, please try again',
  'errors.WORKER_ERROR': 'Worker returned an error',
  'errors.WORKER_CONFLICT':
    'Resource was modified by someone else. Close and reopen the editor to retry.',
  'errors.RESOURCE_NOT_AVAILABLE': 'Resource type not available on this cluster',
  'errors.RESOURCE_NOT_AVAILABLE.subtitle':
    'The corresponding CRD is not installed, or the required K8s feature gate (e.g. DRA / MutatingAdmissionPolicy) is not enabled. Enable it on the cluster first.',
  'errors.PLUGIN_NOT_FOUND': 'Plugin not found',
  'errors.PLUGIN_NAME_EXISTS': 'Plugin name already exists',
  'errors.PLUGIN_BUILTIN_LOCKED':
    'Built-in plugins cannot be modified or deleted',
  'errors.PLUGIN_CHART_MISSING':
    'Please configure a chart source (repo URL, OCI reference, or local file)',
  'errors.PLUGIN_UPLOAD_TOO_LARGE': 'File too large (max 16MB)',
  'errors.PLUGIN_IN_USE':
    'Plugin is currently enabled on at least one cluster. Disable it everywhere before deleting.',
  'errors.PLUGIN_UNINSTALLING':
    'Plugin is currently uninstalling. Wait for it to finish before re-enabling.',
  'errors.PLUGIN_NOT_ENABLED': 'Plugin is not enabled on this cluster',
  'errors.PLUGIN_NOT_RUNNING': 'Plugin is not in Running state',

  // login
  'pages.login.subtitle': 'Unified GPU + Model platform for Kubernetes',
  'pages.login.username.placeholder': 'Username',
  'pages.login.username.required': 'Please enter your username',
  'pages.login.password.placeholder': 'Password',
  'pages.login.password.required': 'Please enter your password',
  'pages.login.submit': 'Login',
  'pages.login.error.incorrect': 'Incorrect username or password',
  'pages.login.error.failed': 'Login failed, please try again',

  // clusters
  'pages.clusters.title': 'Clusters',
  'pages.clusters.subtitle': 'Manage your Kubernetes clusters',
  'pages.clusters.addCluster': 'Add Cluster',
  'pages.clusters.stats.total': 'Total Clusters',
  'pages.clusters.stats.online': 'Online',
  'pages.clusters.stats.offline': 'Offline',
  'pages.clusters.empty.title': 'No clusters yet',
  'pages.clusters.empty.hint':
    'Add your first cluster, deploy Worker, and start managing',
  'pages.clusters.empty.action': 'Add Cluster',
  'pages.clusters.card.noDescription': '(no description)',
  'pages.clusters.card.createdAt': 'Created {date}',
  'pages.clusters.card.updatedAt': 'Updated {date}',
  'pages.clusters.action.edit': 'Edit',
  'pages.clusters.action.delete': 'Delete',
  'pages.clusters.status.online': 'Online',
  'pages.clusters.status.offline': 'Offline',
  'pages.clusters.edit.title': 'Edit Cluster',
  'pages.clusters.edit.apply': 'Apply',
  'pages.clusters.edit.success': 'Saved',
  'pages.clusters.delete.title': 'Delete cluster "{name}"?',
  'pages.clusters.delete.content':
    'This will disconnect the Worker and remove all cluster data.',
  'pages.clusters.delete.confirmPrompt':
    'To confirm, type the cluster name {name} below:',
  'pages.clusters.delete.cancel': 'Cancel',
  'pages.clusters.delete.next': 'Continue',
  'pages.clusters.delete.finalTitle': 'Permanently delete "{name}"?',
  'pages.clusters.delete.finalContent': 'This action cannot be undone.',
  'pages.clusters.delete.finalOk': 'Delete permanently',
  'pages.clusters.delete.success': 'Cluster deleted',
  'pages.clusters.modal.add': 'Add Cluster',
  'pages.clusters.modal.name': 'Cluster Name',
  'pages.clusters.modal.namePlaceholder': 'e.g. prod-cluster-01',
  'pages.clusters.modal.nameRequired': 'Please enter cluster name',
  'pages.clusters.modal.description': 'Description',
  'pages.clusters.modal.descPlaceholder': 'Optional description',
  'pages.clusters.modal.create': 'Create',
  'pages.clusters.token.title': 'Cluster Created',
  'pages.clusters.token.warning':
    'Save this token now — it will not be shown again.',
  'pages.clusters.token.label': 'Cluster Token',
  'pages.clusters.token.done': 'Done',
  'pages.clusters.copied': 'Copied!',
  'pages.clusters.token.regenerate': 'Regenerate Token',
  'pages.clusters.token.regenerateConfirm':
    'The old token will be immediately invalidated and any deployed Workers will disconnect. Continue?',
  'pages.clusters.token.regenerateTitle': 'Regenerate Token',
  'pages.clusters.token.regenerateWarning':
    'A new token has been generated. The old token is immediately invalidated — save this now.',

  // nodes
  'pages.nodes.title': 'Nodes',
  'pages.nodes.searchPlaceholder': 'Search name / role / status / IP…',
  // Column titles: K8s Table API returns kubectl printer headers in English;
  // the frontend translates them through this set of keys.
  'pages.nodes.col.name': 'Name',
  'pages.nodes.col.status': 'Status',
  'pages.nodes.col.roles': 'Roles',
  'pages.nodes.col.age': 'Age',
  'pages.nodes.col.version': 'Version',
  'pages.nodes.col.internalIp': 'Internal IP',
  'pages.nodes.col.externalIp': 'External IP',
  'pages.nodes.col.osImage': 'OS Image',
  'pages.nodes.col.kernelVersion': 'Kernel Version',
  'pages.nodes.col.containerRuntime': 'Container Runtime',
  'pages.nodes.col.action': 'Actions',
  'pages.nodes.action.describe': 'Describe',
  'pages.nodes.action.overview': 'Overview',
  'pages.nodes.action.view': 'View',
  'pages.nodes.action.cordon': 'Cordon',
  'pages.nodes.action.uncordon': 'Uncordon',
  'pages.nodes.cordon.confirmTitle': 'Cordon node',
  'pages.nodes.cordon.confirmBody':
    'Marking {name} as unschedulable means no new pods will be scheduled here (running pods are unaffected). Continue?',
  'pages.nodes.cordon.ok': 'Cordon',
  'pages.nodes.cordon.cancel': 'Cancel',
  'pages.nodes.cordon.success': 'Node cordoned',
  'pages.nodes.uncordon.confirmTitle': 'Uncordon node',
  'pages.nodes.uncordon.confirmBody': 'Allow the scheduler to place pods on {name} again. Continue?',
  'pages.nodes.uncordon.ok': 'Uncordon',
  'pages.nodes.uncordon.success': 'Node uncordoned',
  'pages.nodes.detail.basic': 'Basic',
  'pages.nodes.detail.networking': 'Networking',
  'pages.nodes.detail.scheduling': 'Scheduling',
  'pages.nodes.detail.resources': 'Resources',
  'pages.nodes.detail.resource': 'Resource',
  'pages.nodes.detail.capacity': 'Capacity',
  'pages.nodes.detail.allocatable': 'Allocatable',
  'pages.nodes.detail.memory': 'Memory',
  'pages.nodes.detail.arch': 'Arch / OS',
  'pages.nodes.detail.labels': 'Labels',
  'pages.nodes.detail.annotations': 'Annotations',
  'pages.nodes.detail.podCIDR': 'Pod CIDR',
  'pages.nodes.detail.unschedulable': 'Unschedulable',
  'pages.nodes.detail.taints': 'Taints',

  // workloads
  'pages.workloads.allNamespaces': 'All namespaces',
  'pages.workloads.searchPlaceholder':
    'Search current page (name, namespace, status…)',
  'pages.workloads.col.actions': 'Actions',
  'pages.workloads.view': 'View',
  'pages.workloads.edit': 'Edit',
  'pages.workloads.describe': 'Describe',
  'pages.workloads.delete': 'Delete',
  'pages.workloads.delete.confirm': 'Delete {name}? This cannot be undone.',
  'pages.workloads.refresh.off': 'Off',
  'pages.workloads.refresh.retry': 'Retry',
  'pages.workloads.refresh.namespaces': 'Refresh namespaces',
  'pages.workloads.page': 'Page {n}',
  'pages.workloads.apply': 'Apply',
  'pages.workloads.apply.success': 'Applied',
  'pages.workloads.delete.success': 'Deleted',
  'pages.workloads.cancel': 'Cancel',
  'pages.workloads.logs': 'Logs',
  'pages.workloads.exec': 'Exec',
  'pages.workloads.top': 'Top',
  'pages.workloads.refresh': 'Refresh',
  'pages.workloads.top.title': 'Pod Resource Usage',
  'pages.workloads.top.col.container': 'Container',
  'pages.workloads.top.col.cpu': 'CPU',
  'pages.workloads.top.col.memory': 'Memory',
  'pages.workloads.top.meta': 'Sampled at {ts} · window {window}',
  'pages.workloads.top.unavailable.title': 'Metrics not available',
  'pages.workloads.top.unavailable.subtitle':
    'Make sure the Metrics Server plugin is enabled.',
  'pages.workloads.top.unavailable.action': 'Go to plugins',
  'pages.workloads.crd.viewInstances': 'View Instances',
  'pages.workloads.crd.invalidSpec':
    'CRD spec missing group/version/kind — cannot list instances',
  'pages.workloads.crd.backToList': 'Back to CRDs',
  'pages.workloads.copied': 'Copied',
  'pages.describe.title': 'Describe',
  'pages.describe.copy': 'Copy',
  'pages.describe.copyFailed': 'Copy failed',
  'pages.workloads.loadError': 'Failed to load resource',
  'pages.workloads.loading': 'Loading…',
  'pages.workloads.editor.title': 'Edit {type} / {name}',
  'pages.workloads.col.name': 'Name',
  'pages.workloads.col.namespace': 'Namespace',
  'pages.workloads.col.age': 'Age',
  'pages.workloads.col.status': 'Status',
  'pages.workloads.col.ready': 'Ready',
  'pages.workloads.col.restarts': 'Restarts',
  'pages.workloads.col.node': 'Node',
  'pages.workloads.col.type': 'Type',
  'pages.workloads.col.ports': 'Port(s)',
  'pages.workloads.col.hosts': 'Hosts',
  'pages.workloads.col.address': 'Address',
  'pages.workloads.col.data': 'Data',
  'pages.workloads.col.upToDate': 'Up-to-date',
  'pages.workloads.col.available': 'Available',
  'pages.workloads.col.containers': 'Containers',
  'pages.workloads.col.images': 'Images',
  'pages.workloads.col.selector': 'Selector',
  'pages.workloads.col.desired': 'Desired',
  'pages.workloads.col.current': 'Current',
  'pages.workloads.col.ip': 'IP',
  'pages.workloads.col.nodeSelector': 'Node Selector',
  'pages.workloads.col.nominatedNode': 'Nominated Node',
  'pages.workloads.col.readinessGates': 'Readiness Gates',
  'pages.workloads.col.class': 'Class',
  'pages.workloads.col.clusterIp': 'Cluster IP',
  'pages.workloads.col.externalIp': 'External IP',
  'pages.workloads.col.volume': 'Volume',
  'pages.workloads.col.capacity': 'Capacity',
  'pages.workloads.col.accessModes': 'Access Modes',
  'pages.workloads.col.storageClass': 'StorageClass',
  'pages.workloads.col.reclaimPolicy': 'Reclaim Policy',
  'pages.workloads.col.claim': 'Claim',
  'pages.workloads.col.reason': 'Reason',
  'pages.workloads.col.volumeMode': 'Volume Mode',
  'pages.workloads.col.volumeAttributesClass': 'Volume Attributes Class',


  // global namespace picker (top bar)
  'namespacePicker.label': 'Namespace',

  // apply YAML drawer
  'pages.applyYaml.title': 'Apply YAML',
  'pages.applyYaml.dropHint': 'Click or drag .yaml / .yml / .json here',
  'pages.applyYaml.apply': 'Apply',
  'pages.applyYaml.delete': 'Delete',
  'pages.applyYaml.delete.confirmTitle': 'Delete resources?',
  'pages.applyYaml.delete.confirmHint':
    'Every resource in the current YAML (matched by GVK + namespace + name) will be deleted. This cannot be undone.',
  'pages.applyYaml.delete.confirmOk': 'Delete',
  'pages.applyYaml.delete.successN': 'Deleted {n} resource(s)',
  'pages.applyYaml.successN': 'Applied {n} resource(s)',
  'pages.applyYaml.partial': 'Applied {ok} / {total} — others failed',
  'pages.applyYaml.expand': 'Expand',
  'pages.applyYaml.collapse': 'Collapse',
  'pages.applyYaml.empty': 'Please enter or upload YAML',
  'pages.applyYaml.tooLarge': 'File exceeds 1 MB',
  'pages.applyYaml.readError': 'Failed to read file',

  // pod logs drawer
  'pages.podLogs.title': 'Pod Logs',
  'pages.podLogs.container': 'Container',
  'pages.podLogs.tail': 'Tail',
  'pages.podLogs.follow': 'Follow',
  'pages.podLogs.previous': 'Previous',
  'pages.podLogs.reload': 'Reconnect',
  'pages.podLogs.clear': 'Clear',
  'pages.podLogs.lineCount': '{n} lines',
  'pages.podLogs.matchCount': '{m} / {n} matched',
  'pages.podLogs.search.placeholder': 'Search (grep)',
  'pages.podLogs.search.regex': 'Regex',
  'pages.podLogs.error.connection': 'WebSocket connection failed',

  // pod exec drawer
  'pages.podExec.title': 'Pod Exec',
  'pages.podExec.container': 'Container',
  'pages.podExec.reload': 'Reconnect',
  'pages.podExec.error.connection': 'WebSocket connection failed',

  // 404
  'pages.404.subTitle': 'Sorry, the page you visited does not exist.',
  'pages.404.buttonText': 'Back Home',
};
