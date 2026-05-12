import { applyYAML, getWorkload, type CRRef } from './workload';

// Volcano resource constructors + lifecycle command helpers.
//
// Everything here builds plain JSON manifests and ships them through
// the existing /apply endpoint (server-side SSA). We intentionally
// don't touch /workloads/_cr or add new endpoints — apply already
// does CR creates / updates / replaces uniformly across any GVK.
//
// YAML is generated via JSON.stringify because every consumer is the
// /apply endpoint, which accepts JSON-as-YAML (multi-doc separator
// `---` is YAML-only but a single JSON document is valid YAML on its
// own). Avoiding js-yaml saves a dependency and a build-time hit.

// QueueAffinityInput models Volcano's Queue.spec.affinity: lists of
// node-group names for nodegroup-plugin scheduling. The CRD uses
// requiredDuringSchedulingIgnoredDuringExecution /
// preferredDuringSchedulingIgnoredDuringExecution; we expose them as
// shorter `required` / `preferred` and translate at build time.
export interface QueueAffinityInput {
  nodeGroupAffinity?: {
    required?: string[];
    preferred?: string[];
  };
  nodeGroupAntiAffinity?: {
    required?: string[];
    preferred?: string[];
  };
}

export interface QueueInput {
  name: string;
  weight?: number;
  // Free-form ResourceList — any resource name → quantity. Keys are
  // not validated client-side; the API server rejects unknown ones.
  capability?: Record<string, string>;
  // Deserved: resources the queue is guaranteed to receive when
  // available; over-the-line allocation can be reclaimed back.
  deserved?: Record<string, string>;
  // Guarantee.resource: resources reserved for this queue (won't be
  // shared even if idle). Wrapped under .resource per the CRD.
  guarantee?: Record<string, string>;
  reclaimable?: boolean;
  parent?: string;
  // Queue priority. Higher values are prioritized at scheduling time
  // AND considered later during reclamation (counter-intuitive: high-
  // priority queues lose resources last). Defaults to 0.
  priority?: number;
  // type is a free-form string (default "kube"); used by multi-
  // cluster setups to mark queue source. Rarely set in practice.
  type?: string;
  // Optional queue-level node-group affinity (consumed by the
  // nodegroup scheduler plugin). Complex shapes outside this typed
  // surface should be edited via the YAML view instead.
  affinity?: QueueAffinityInput;
}

export function buildQueueManifest(input: QueueInput): unknown {
  const spec: Record<string, unknown> = {
    weight: input.weight ?? 1,
  };
  if (input.capability && Object.keys(input.capability).length > 0) {
    spec.capability = input.capability;
  }
  if (input.deserved && Object.keys(input.deserved).length > 0) {
    spec.deserved = input.deserved;
  }
  if (input.guarantee && Object.keys(input.guarantee).length > 0) {
    spec.guarantee = { resource: input.guarantee };
  }
  if (typeof input.reclaimable === 'boolean') {
    spec.reclaimable = input.reclaimable;
  }
  if (input.parent) spec.parent = input.parent;
  if (typeof input.priority === 'number') spec.priority = input.priority;
  if (input.type) spec.type = input.type;
  const affinity = buildQueueAffinity(input.affinity);
  if (affinity) spec.affinity = affinity;
  return {
    apiVersion: 'scheduling.volcano.sh/v1beta1',
    kind: 'Queue',
    metadata: { name: input.name },
    spec,
  };
}

// buildQueueAffinity expands the short `required` / `preferred` form
// into the CRD's verbose XxxDuringSchedulingIgnoredDuringExecution
// keys. Empty lists are dropped so we don't emit `{}` slots that
// confuse `kubectl diff` and make stored manifests noisier.
function buildQueueAffinity(
  input?: QueueAffinityInput,
): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const expand = (
    a?: { required?: string[]; preferred?: string[] },
  ): Record<string, unknown> | undefined => {
    if (!a) return undefined;
    const req = (a.required ?? []).filter((s) => s && s.trim());
    const pref = (a.preferred ?? []).filter((s) => s && s.trim());
    if (req.length === 0 && pref.length === 0) return undefined;
    const out: Record<string, unknown> = {};
    if (req.length > 0) {
      out.requiredDuringSchedulingIgnoredDuringExecution = req;
    }
    if (pref.length > 0) {
      out.preferredDuringSchedulingIgnoredDuringExecution = pref;
    }
    return out;
  };
  const aff = expand(input.nodeGroupAffinity);
  const anti = expand(input.nodeGroupAntiAffinity);
  if (!aff && !anti) return undefined;
  const out: Record<string, unknown> = {};
  if (aff) out.nodeGroupAffinity = aff;
  if (anti) out.nodeGroupAntiAffinity = anti;
  return out;
}

export interface JobTaskInput {
  name: string;
  replicas: number;
  image: string;
  command?: string[];
  args?: string[];
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  // Container-level imagePullPolicy. Undefined = let kubelet derive
  // from the image tag (Always for :latest / no-tag, IfNotPresent
  // otherwise). Explicit values: Always / IfNotPresent / Never.
  imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
  // Pod-level restartPolicy. Volcano defaults Job-level restartPolicy
  // off the task block; OnFailure works for most batch use cases.
  restartPolicy?: 'OnFailure' | 'Never' | 'Always';
  // Per-task gang minimum: how many pods of THIS task must start
  // together (defaults server-side to replicas). Distinct from
  // job.spec.minAvailable which spans all tasks.
  minAvailable?: number;
  // Per-task retry budget (vs job-level maxRetry). Defaults 3.
  maxRetry?: number;
  // NUMA topology policy for this task's pods.
  // Volcano upstream: NumaPolicy enum — none / best-effort /
  // restricted / single-numa-node (kubelet-style).
  topologyPolicy?:
    | 'none'
    | 'best-effort'
    | 'restricted'
    | 'single-numa-node';
}

export interface JobInput {
  name: string;
  namespace: string;
  queue?: string;
  priorityClassName?: string;
  // Gang-scheduling: minimum number of pods that must be co-scheduled
  // before any can start. Defaults to total task replicas if omitted.
  minAvailable?: number;
  // Min number of pods that must succeed for the Job to be marked
  // Complete. Distinct from MinAvailable (start-time gang).
  minSuccess?: number;
  // Max retries before marking the Job Failed. Defaults to 3 server-
  // side; only emitted when the user picks something different.
  maxRetry?: number;
  // Auto-cleanup window after Job reaches Completed / Failed.
  ttlSecondsAfterFinished?: number;
  // Hint for the running duration (Go duration string like "1h30m").
  // Surfaces as spec.runningEstimate — used by sla plugin and
  // estimate-aware schedulers.
  runningEstimate?: string;
  // Volcano plugins to enable on the Job (env, svc, ssh, mpi, ...).
  // Keep simple — pass them as a string list, server builds the map.
  plugins?: string[];
  tasks: JobTaskInput[];
  // NetworkTopology (works with HyperNode CRD) — same shape as the
  // PodGroup field but applied at Job level. Volcano controller
  // propagates this to the generated PodGroup.
  networkTopologyMode?: 'hard' | 'soft';
  networkTopologyHighestTierAllowed?: number;
  networkTopologyHighestTierName?: string;
}

export function buildJobManifest(input: JobInput): unknown {
  const tasks = input.tasks.map((t) => {
    const container: Record<string, unknown> = {
      name: t.name,
      image: t.image,
    };
    if (t.command && t.command.length > 0) container.command = t.command;
    if (t.args && t.args.length > 0) container.args = t.args;
    if (t.resources) container.resources = t.resources;
    if (t.imagePullPolicy) container.imagePullPolicy = t.imagePullPolicy;
    const taskOut: Record<string, unknown> = {
      name: t.name,
      replicas: t.replicas,
      template: {
        spec: {
          schedulerName: 'volcano',
          restartPolicy: t.restartPolicy ?? 'OnFailure',
          containers: [container],
        },
      },
    };
    if (typeof t.minAvailable === 'number' && t.minAvailable >= 0) {
      taskOut.minAvailable = t.minAvailable;
    }
    if (typeof t.maxRetry === 'number' && t.maxRetry >= 0) {
      taskOut.maxRetry = t.maxRetry;
    }
    if (t.topologyPolicy) taskOut.topologyPolicy = t.topologyPolicy;
    return taskOut;
  });
  const totalReplicas = input.tasks.reduce((sum, t) => sum + t.replicas, 0);
  const spec: Record<string, unknown> = {
    minAvailable: input.minAvailable ?? totalReplicas,
    schedulerName: 'volcano',
    tasks,
  };
  if (input.queue) spec.queue = input.queue;
  if (input.priorityClassName) spec.priorityClassName = input.priorityClassName;
  if (typeof input.minSuccess === 'number' && input.minSuccess > 0) {
    spec.minSuccess = input.minSuccess;
  }
  if (typeof input.maxRetry === 'number' && input.maxRetry >= 0) {
    spec.maxRetry = input.maxRetry;
  }
  if (
    typeof input.ttlSecondsAfterFinished === 'number' &&
    input.ttlSecondsAfterFinished >= 0
  ) {
    spec.ttlSecondsAfterFinished = input.ttlSecondsAfterFinished;
  }
  if (input.runningEstimate) spec.runningEstimate = input.runningEstimate;
  if (input.plugins && input.plugins.length > 0) {
    // Volcano plugins value is a list of args per plugin; for v1 we
    // pass empty arrays — every supported plugin has sensible defaults.
    const pluginsMap: Record<string, string[]> = {};
    for (const p of input.plugins) pluginsMap[p] = [];
    spec.plugins = pluginsMap;
  }
  const nt: Record<string, unknown> = {};
  if (input.networkTopologyMode) nt.mode = input.networkTopologyMode;
  if (
    typeof input.networkTopologyHighestTierAllowed === 'number' &&
    input.networkTopologyHighestTierAllowed >= 0
  ) {
    nt.highestTierAllowed = input.networkTopologyHighestTierAllowed;
  }
  if (input.networkTopologyHighestTierName) {
    nt.highestTierName = input.networkTopologyHighestTierName;
  }
  if (Object.keys(nt).length > 0) spec.networkTopology = nt;
  return {
    apiVersion: 'batch.volcano.sh/v1alpha1',
    kind: 'Job',
    metadata: { name: input.name, namespace: input.namespace },
    spec,
  };
}

export interface CronJobInput {
  name: string;
  namespace: string;
  schedule: string; // standard cron expression, e.g. "0 */6 * * *"
  // IANA TZ name (e.g. "Asia/Shanghai"); falls back to the
  // controller-manager's local TZ if omitted.
  timeZone?: string;
  // Max wait before considering a missed trigger a failure.
  startingDeadlineSeconds?: number;
  // Forbid / Allow / Replace (matches batch/v1 CronJob semantics).
  concurrencyPolicy?: 'Allow' | 'Forbid' | 'Replace';
  successfulJobsHistoryLimit?: number;
  failedJobsHistoryLimit?: number;
  suspend?: boolean;
  // Reuses the Job spec (sans namespace/name; CronJob owns those).
  jobTemplate: Omit<JobInput, 'name' | 'namespace'>;
}

export function buildCronJobManifest(input: CronJobInput): unknown {
  // Volcano's CronJob uses the regular Volcano Job spec under
  // `.spec.jobTemplate.spec`. The Job's metadata.name is auto-generated
  // by the controller per-trigger so we leave it out here.
  const jobManifest = buildJobManifest({
    ...input.jobTemplate,
    name: input.name, // ignored by jobTemplate but kept for buildJobManifest's signature
    namespace: input.namespace,
  }) as { spec: Record<string, unknown> };
  const spec: Record<string, unknown> = {
    schedule: input.schedule,
    jobTemplate: { spec: jobManifest.spec },
  };
  // Volcano CronJob spec defaults concurrencyPolicy=Allow via kubebuilder,
  // so only emit when the user picks a non-default value. Keeps stored
  // manifests cleaner and avoids spurious diffs on round-trip.
  if (input.concurrencyPolicy) spec.concurrencyPolicy = input.concurrencyPolicy;
  if (input.timeZone) spec.timeZone = input.timeZone;
  if (
    typeof input.startingDeadlineSeconds === 'number' &&
    input.startingDeadlineSeconds >= 0
  ) {
    spec.startingDeadlineSeconds = input.startingDeadlineSeconds;
  }
  if (typeof input.successfulJobsHistoryLimit === 'number') {
    spec.successfulJobsHistoryLimit = input.successfulJobsHistoryLimit;
  }
  if (typeof input.failedJobsHistoryLimit === 'number') {
    spec.failedJobsHistoryLimit = input.failedJobsHistoryLimit;
  }
  if (typeof input.suspend === 'boolean') spec.suspend = input.suspend;
  return {
    apiVersion: 'batch.volcano.sh/v1alpha1',
    kind: 'CronJob',
    metadata: { name: input.name, namespace: input.namespace },
    spec,
  };
}

// Volcano lifecycle operations (Open/Close queue, Resume/Suspend job)
// drop a `bus.volcano.sh/v1alpha1 Command` CR pointed at the target.
// The Volcano controller picks it up, performs the action, and deletes
// the Command. Same UX as `vcctl` CLI.
export type VolcanoAction =
  | 'OpenQueue'
  | 'CloseQueue'
  | 'ResumeJob'
  | 'AbortJob'
  | 'RestartJob'
  | 'TerminateJob'
  | 'CompleteJob';

interface CommandTarget {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
  uid?: string;
}

function buildCommandManifest(
  action: VolcanoAction,
  target: CommandTarget,
  reason?: string,
): unknown {
  // Command is namespaced. For cluster-scoped targets (Queue) we put
  // the Command in the default namespace — Volcano's controller scans
  // all namespaces. The Command's name should be unique-ish; use the
  // target name + action + a short random suffix.
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    apiVersion: 'bus.volcano.sh/v1alpha1',
    kind: 'Command',
    metadata: {
      name: `${target.name}-${action.toLowerCase()}-${suffix}`,
      namespace: target.namespace ?? 'default',
    },
    action,
    target: {
      apiVersion: target.apiVersion,
      kind: target.kind,
      name: target.name,
      uid: target.uid,
    },
    reason: reason ?? action,
  };
}

// Convenience: build + ship in one call. Returns the apply-yaml result.
export function applyManifest(clusterId: string, manifest: unknown) {
  return applyYAML(clusterId, JSON.stringify(manifest));
}

// sendCommand resolves the target's UID (if the caller didn't pass
// one) and then SSA-applies the Command. Volcano's webhook validates
// `target` as an OwnerReference, which requires uid alongside
// apiVersion / kind / name — without it the apply fails with
// `target.uid: Required value`.
export async function sendCommand(
  clusterId: string,
  action: VolcanoAction,
  target: CommandTarget,
  reason?: string,
) {
  let uid = target.uid;
  if (!uid) {
    const cr: CRRef = {
      ...parseApiVersion(target.apiVersion),
      kind: target.kind,
      // For cluster-scoped Volcano kinds (Queue, HyperNode) the
      // caller passes no namespace; everything else is namespaced.
      scope: target.namespace ? 'Namespaced' : 'Cluster',
    };
    const obj = await getWorkload(
      clusterId,
      '_cr',
      target.name,
      target.namespace ?? '',
      cr,
    );
    uid = (obj as { metadata?: { uid?: string } } | undefined)?.metadata?.uid;
    if (!uid) {
      throw new Error(
        `Could not resolve UID for ${target.kind} ${
          target.namespace ? target.namespace + '/' : ''
        }${target.name}; the resource may have been deleted.`,
      );
    }
  }
  return applyManifest(
    clusterId,
    buildCommandManifest(action, { ...target, uid }, reason),
  );
}

// ─── PodGroup ──────────────────────────────────────────────────────────

export interface PodGroupInput {
  name: string;
  namespace: string;
  queue?: string;
  priorityClassName?: string;
  // Minimum number of pods to schedule together (gang). 0 = no gang.
  minMember?: number;
  // Per-task minimum: map of task name → minimum running count.
  // Independent of subGroupPolicy (recommended for new configs);
  // exposed alongside for compatibility with existing PodGroups.
  minTaskMember?: Record<string, number>;
  // Minimum resources for the whole group; map of K8s resource name
  // to Quantity string ("4", "8Gi", etc.).
  minResources?: Record<string, string>;
  // Optional NetworkTopology block (works with HyperNode CRD).
  networkTopologyMode?: 'hard' | 'soft';
  networkTopologyHighestTierAllowed?: number;
  networkTopologyHighestTierName?: string;
}

export function buildPodGroupManifest(input: PodGroupInput): unknown {
  const spec: Record<string, unknown> = {};
  if (typeof input.minMember === 'number' && input.minMember > 0) {
    spec.minMember = input.minMember;
  }
  if (input.queue) spec.queue = input.queue;
  if (input.priorityClassName) spec.priorityClassName = input.priorityClassName;
  if (input.minResources && Object.keys(input.minResources).length > 0) {
    spec.minResources = input.minResources;
  }
  if (input.minTaskMember && Object.keys(input.minTaskMember).length > 0) {
    spec.minTaskMember = input.minTaskMember;
  }
  const nt: Record<string, unknown> = {};
  if (input.networkTopologyMode) nt.mode = input.networkTopologyMode;
  if (
    typeof input.networkTopologyHighestTierAllowed === 'number' &&
    input.networkTopologyHighestTierAllowed >= 0
  ) {
    nt.highestTierAllowed = input.networkTopologyHighestTierAllowed;
  }
  if (input.networkTopologyHighestTierName) {
    nt.highestTierName = input.networkTopologyHighestTierName;
  }
  if (Object.keys(nt).length > 0) spec.networkTopology = nt;

  return {
    apiVersion: 'scheduling.volcano.sh/v1beta1',
    kind: 'PodGroup',
    metadata: { name: input.name, namespace: input.namespace },
    spec,
  };
}

// ─── HyperNode ─────────────────────────────────────────────────────────

export type HyperNodeMemberType = 'Node' | 'HyperNode';
export type HyperNodeSelectorType = 'exactMatch' | 'regexMatch' | 'labelMatch';

export interface HyperNodeMemberInput {
  type: HyperNodeMemberType;
  // Exactly one of these must be set — the CRD validates that with a
  // CEL rule at admission time. The form drawer enforces it via
  // selectorType radio so users can't pick two.
  selectorType: HyperNodeSelectorType;
  // Used when selectorType === 'exactMatch'.
  exactName?: string;
  // Used when selectorType === 'regexMatch'.
  regexPattern?: string;
  // Used when selectorType === 'labelMatch'. labelMatch only takes
  // effect for type === 'Node' per the upstream comment.
  matchLabels?: Record<string, string>;
}

export interface HyperNodeInput {
  name: string;
  // Performance tier (depth in the topology tree); >= 0.
  tier: number;
  // Optional human-readable tier name.
  tierName?: string;
  members: HyperNodeMemberInput[];
}

export function buildHyperNodeManifest(input: HyperNodeInput): unknown {
  const members = input.members.map((m) => {
    const selector: Record<string, unknown> = {};
    if (m.selectorType === 'exactMatch' && m.exactName) {
      selector.exactMatch = { name: m.exactName };
    } else if (m.selectorType === 'regexMatch' && m.regexPattern) {
      selector.regexMatch = { pattern: m.regexPattern };
    } else if (
      m.selectorType === 'labelMatch' &&
      m.matchLabels &&
      Object.keys(m.matchLabels).length > 0
    ) {
      selector.labelMatch = { matchLabels: m.matchLabels };
    }
    return { type: m.type, selector };
  });
  const spec: Record<string, unknown> = { tier: input.tier };
  if (input.tierName) spec.tierName = input.tierName;
  if (members.length > 0) spec.members = members;
  return {
    apiVersion: 'topology.volcano.sh/v1alpha1',
    kind: 'HyperNode',
    metadata: { name: input.name },
    spec,
  };
}

// ─── NodeShard ─────────────────────────────────────────────────────────

export interface NodeShardInput {
  name: string;
  // Cluster-scoped list of node names this shard should manage.
  // The controller diffs against the live node set and surfaces the
  // delta in status.nodesToAdd / nodesToRemove.
  nodesDesired: string[];
}

export function buildNodeShardManifest(input: NodeShardInput): unknown {
  return {
    apiVersion: 'shard.volcano.sh/v1alpha1',
    kind: 'NodeShard',
    metadata: { name: input.name },
    spec: {
      nodesDesired: input.nodesDesired,
    },
  };
}

// ─── ColocationConfiguration ───────────────────────────────────────────

export interface ColocationConfigurationInput {
  name: string;
  namespace: string;
  // Optional matchLabels — the typed form only models this simple
  // shape; matchExpressions can be added through the YAML view.
  matchLabels?: Record<string, string>;
  // MemoryQos cgroup ratios. Per the CRD, all three are 0–100.
  // Defaults: high=100, low=0, min=0.
  highRatio?: number;
  lowRatio?: number;
  minRatio?: number;
}

export function buildColocationConfigurationManifest(
  input: ColocationConfigurationInput,
): unknown {
  const spec: Record<string, unknown> = {};
  const memoryQos: Record<string, unknown> = {};
  if (typeof input.highRatio === 'number') memoryQos.highRatio = input.highRatio;
  if (typeof input.lowRatio === 'number') memoryQos.lowRatio = input.lowRatio;
  if (typeof input.minRatio === 'number') memoryQos.minRatio = input.minRatio;
  if (Object.keys(memoryQos).length > 0) spec.memoryQos = memoryQos;
  if (input.matchLabels && Object.keys(input.matchLabels).length > 0) {
    spec.selector = { matchLabels: input.matchLabels };
  }
  return {
    apiVersion: 'config.volcano.sh/v1alpha1',
    kind: 'ColocationConfiguration',
    metadata: { name: input.name, namespace: input.namespace },
    spec,
  };
}

function parseApiVersion(av: string): { group: string; version: string } {
  const slash = av.indexOf('/');
  if (slash < 0) return { group: '', version: av };
  return { group: av.slice(0, slash), version: av.slice(slash + 1) };
}
