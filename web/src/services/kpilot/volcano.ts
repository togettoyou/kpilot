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

export interface QueueInput {
  name: string;
  weight?: number;
  capability?: Record<string, string>; // e.g. { cpu: "10", memory: "100Gi", "volcano.sh/vgpu-number": "8" }
  reclaimable?: boolean;
  parent?: string;
  priority?: number;
}

export function buildQueueManifest(input: QueueInput): unknown {
  const spec: Record<string, unknown> = {
    weight: input.weight ?? 1,
  };
  if (input.capability && Object.keys(input.capability).length > 0) {
    spec.capability = input.capability;
  }
  if (typeof input.reclaimable === 'boolean') {
    spec.reclaimable = input.reclaimable;
  }
  if (input.parent) spec.parent = input.parent;
  if (typeof input.priority === 'number') spec.priority = input.priority;
  return {
    apiVersion: 'scheduling.volcano.sh/v1beta1',
    kind: 'Queue',
    metadata: { name: input.name },
    spec,
  };
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
  // Pod-level restartPolicy. Volcano defaults Job-level restartPolicy
  // off the task block; OnFailure works for most batch use cases.
  restartPolicy?: 'OnFailure' | 'Never' | 'Always';
}

export interface JobInput {
  name: string;
  namespace: string;
  queue?: string;
  priorityClassName?: string;
  // Gang-scheduling: minimum number of pods that must be co-scheduled
  // before any can start. Defaults to total task replicas if omitted.
  minAvailable?: number;
  // Volcano plugins to enable on the Job (env, svc, ssh, mpi, ...).
  // Keep simple — pass them as a string list, server builds the map.
  plugins?: string[];
  tasks: JobTaskInput[];
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
    return {
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
  });
  const totalReplicas = input.tasks.reduce((sum, t) => sum + t.replicas, 0);
  const spec: Record<string, unknown> = {
    minAvailable: input.minAvailable ?? totalReplicas,
    schedulerName: 'volcano',
    tasks,
  };
  if (input.queue) spec.queue = input.queue;
  if (input.priorityClassName) spec.priorityClassName = input.priorityClassName;
  if (input.plugins && input.plugins.length > 0) {
    // Volcano plugins value is a list of args per plugin; for v1 we
    // pass empty arrays — every supported plugin has sensible defaults.
    const pluginsMap: Record<string, string[]> = {};
    for (const p of input.plugins) pluginsMap[p] = [];
    spec.plugins = pluginsMap;
  }
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
    concurrencyPolicy: input.concurrencyPolicy ?? 'Allow',
    jobTemplate: { spec: jobManifest.spec },
  };
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

export function buildCommandManifest(
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

function parseApiVersion(av: string): { group: string; version: string } {
  const slash = av.indexOf('/');
  if (slash < 0) return { group: '', version: av };
  return { group: av.slice(0, slash), version: av.slice(slash + 1) };
}
