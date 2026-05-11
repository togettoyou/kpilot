import { FlowDirectionGraph } from '@ant-design/graphs';
import { useIntl } from '@umijs/max';
import { Tag, Typography } from 'antd';
import React, { useMemo } from 'react';

import {
  ENABLE_FIELDS,
  PLUGINS_META,
  metaForAction,
} from './schedulerMeta';

const { Text } = Typography;

// SchedulerFlowDiagram renders a read-only left-to-right pipeline of
// the user's current scheduler config: Pending PodGroup → each
// configured action in order → Scheduled, with per-action chips
// listing the currently-configured plugins whose callbacks the
// action actually invokes. Lets users see at a glance which plugins
// "wake up" at which scheduling stage.
//
// Data is derived from draft.actions (comma-separated string) plus
// draft.tiers (each plugin's callbacks declared in schedulerMeta).
// No state, no edits — purely a visualization.

interface SchedulerConfShape {
  actions?: string;
  tiers?: { plugins?: { name?: string; [k: string]: unknown }[] }[];
}

// ACTION_CALLBACKS maps each Volcano action to the set of Enabled*
// yaml keys whose callbacks that action triggers in the scheduler
// loop. Source-derived from pkg/scheduler/actions/<a>/*.go behavior:
//
//   - enqueue: walks PodGroup queue, calls JobEnqueueable / QueueOrder
//   - allocate: full pick-node loop — Queue/Job/TaskOrder + Predicate +
//     NodeOrder + BestNode + Allocatable + Ready/Pipelined checks +
//     HyperNode hooks (when network-topology-aware enabled) +
//     SubJob hooks (when gang sub-groups in play)
//   - preempt: same-queue victim selection — Preemptable + Victim +
//     JobStarving / Overused triggers + Predicate / NodeOrder when
//     evaluating victim candidates
//   - reclaim: cross-queue resource reclaim — Reclaimable + Victim
//   - backfill: best-effort small-job fit — Predicate / NodeOrder only
//   - shuffle: rebalance — Victim (Volcano 1.7+; rare)
//
// Used to decide which user-configured plugins to surface under each
// action node in the diagram. If a plugin's callback set in
// schedulerMeta intersects with an action's set here, that plugin is
// listed under that action.
const ACTION_CALLBACKS: Record<string, string[]> = {
  enqueue: ['enableJobEnqueued', 'enableQueueOrder'],
  allocate: [
    'enableQueueOrder',
    'enableJobOrder',
    'enableTaskOrder',
    'enablePredicate',
    'enableNodeOrder',
    'enableBestNode',
    'enableJobReady',
    'enableJobPipelined',
    'enabledAllocatable',
    'enabledHyperNodeOrder',
    'enabledHyperNodeGradient',
    'enabledSubJobReady',
    'enabledSubJobPipelined',
    'enabledSubJobOrder',
    'enableReservedNodes',
    'enableHierarchy',
  ],
  preempt: [
    'enableJobStarving',
    'enablePreemptable',
    'enabledVictim',
    'enableTaskOrder',
    'enablePredicate',
    'enableNodeOrder',
    'enabledOverused',
    'enableTargetJob',
    'enablePreemptive',
    'enableQueueOrder',
  ],
  reclaim: [
    'enableJobStarving',
    'enableReclaimable',
    'enabledVictim',
    'enablePredicate',
    'enableNodeOrder',
    'enabledOverused',
    'enableTargetJob',
    'enablePreemptive',
    'enableQueueOrder',
  ],
  backfill: ['enablePredicate', 'enableNodeOrder', 'enableJobPipelined'],
  shuffle: ['enabledVictim'],
};

interface NodeData {
  kind: 'endpoint' | 'action';
  label: string;
  desc?: string;
  plugins?: { name: string; tier: number; reasons: string[] }[];
}

export default function SchedulerFlowDiagram({
  draft,
}: {
  draft: SchedulerConfShape;
}) {
  const intl = useIntl();

  const data = useMemo(() => {
    const actions = (draft.actions ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // Walk tiers in order and build a plugin → callback set lookup
    // (the enable keys the plugin actually registers, from
    // schedulerMeta). User-set Enabled*: false on a plugin doesn't
    // remove the plugin from its action attribution — we visualize
    // capability, not the runtime active subset, so a "disabled"
    // callback still shows up. That's intentional; users editing
    // those switches should still see what they'd be turning off.
    const pluginsByTier: { name: string; tier: number }[] = [];
    (draft.tiers ?? []).forEach((t, tIdx) => {
      (t.plugins ?? []).forEach((p) => {
        if (p.name) pluginsByTier.push({ name: p.name, tier: tIdx + 1 });
      });
    });

    const nodes: { id: string; data: NodeData }[] = [];
    const edges: { source: string; target: string }[] = [];

    nodes.push({
      id: 'start',
      data: {
        kind: 'endpoint',
        label: intl.formatMessage({ id: 'pages.compute.scheduler.flow.start' }),
        desc: intl.formatMessage({
          id: 'pages.compute.scheduler.flow.start.desc',
        }),
      },
    });

    let prevId = 'start';
    actions.forEach((a) => {
      const actionCallbacks = ACTION_CALLBACKS[a] ?? [];
      const meta = metaForAction(a);
      // For each plugin in this scheduler config, intersect its
      // registered callbacks with what this action actually invokes;
      // if non-empty, list it under the action with the reason
      // (which callbacks contribute).
      const plugins = pluginsByTier
        .map(({ name, tier }) => {
          const pmeta = PLUGINS_META[name];
          if (!pmeta?.callbacks) {
            // Unknown plugin — show under every action conservatively
            // (we can't know what it registers; user opted in by
            // adding it, surfacing it is more useful than hiding).
            return { name, tier, reasons: ['(custom plugin)'] };
          }
          const overlap = pmeta.callbacks.filter((c) =>
            actionCallbacks.includes(c),
          );
          if (overlap.length === 0) return null;
          // Render the human-friendly enable label rather than the
          // raw yaml key (e.g. "Preemptable" not "enablePreemptable").
          const reasons = overlap.map(
            (k) => ENABLE_FIELDS.find((e) => e.key === k)?.label ?? k,
          );
          return { name, tier, reasons };
        })
        .filter(Boolean) as NodeData['plugins'];

      nodes.push({
        id: a,
        data: { kind: 'action', label: a, desc: meta.desc, plugins },
      });
      edges.push({ source: prevId, target: a });
      prevId = a;
    });

    nodes.push({
      id: 'end',
      data: {
        kind: 'endpoint',
        label: intl.formatMessage({ id: 'pages.compute.scheduler.flow.end' }),
        desc: intl.formatMessage({
          id: 'pages.compute.scheduler.flow.end.desc',
        }),
      },
    });
    edges.push({ source: prevId, target: 'end' });

    return { nodes, edges };
  }, [draft.actions, draft.tiers, intl]);

  // Empty state: if user hasn't configured any actions yet (rare,
  // means they're starting from scratch), there's nothing to show.
  const actionsLen = data.nodes.length - 2; // minus start + end
  if (actionsLen === 0) {
    return (
      <Text type="secondary">
        {intl.formatMessage({ id: 'pages.compute.scheduler.flow.empty' })}
      </Text>
    );
  }

  // Per-node height grows with plugin count so chips don't clip.
  const nodeSize = (n: { data?: NodeData }): [number, number] => {
    const d = n.data;
    if (!d || d.kind === 'endpoint') return [180, 60];
    const pluginCount = d.plugins?.length ?? 0;
    // Each plugin row is ~22 px; header + desc adds ~70 px baseline.
    const h = Math.max(80, 80 + pluginCount * 24);
    return [260, h];
  };

  return (
    <div style={{ height: 480, width: '100%' }}>
      <FlowDirectionGraph
        data={data as any}
        autoFit="view"
        animation={false}
        node={{
          style: {
            component: (d: any) => <ActionNode data={d.data as NodeData} />,
            // antd-graphs accepts a function for size — picks per-node
            // height based on plugin density.
            size: nodeSize as any,
            ports: [{ placement: 'left' }, { placement: 'right' }],
          },
        }}
        // No zoom-canvas / drag-canvas: the pipeline is small (start
        // + ~6 actions + end), autoFit="view" already sizes it to
        // fit the card, and wheel-to-zoom would hijack the page's
        // natural scroll when the cursor crosses the canvas.
        behaviors={[]}
      />
    </div>
  );
}

// ActionNode is the React component painted inside each graph node.
// Endpoint nodes render compactly; action nodes show the action name,
// its one-line description, and the contributing plugins as chips.
function ActionNode({ data }: { data: NodeData }) {
  if (data.kind === 'endpoint') {
    return (
      <div
        style={{
          background: 'var(--ant-color-fill-secondary)',
          border: '1px dashed var(--ant-color-border)',
          borderRadius: 8,
          padding: '8px 10px',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>{data.label}</div>
        {data.desc && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--ant-color-text-tertiary)',
              marginTop: 2,
            }}
          >
            {data.desc}
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      style={{
        background: 'var(--ant-color-bg-container)',
        border: '1px solid var(--ant-color-primary-border)',
        borderRadius: 8,
        padding: '6px 10px',
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--ant-color-primary)',
        }}
      >
        {data.label}
      </div>
      {!data.plugins || data.plugins.length === 0 ? (
        <div
          style={{
            fontSize: 11,
            color: 'var(--ant-color-text-tertiary)',
            fontStyle: 'italic',
          }}
        >
          (无相关插件)
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {data.plugins.map((p) => (
            <div
              key={p.name}
              style={{
                fontSize: 11,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                overflow: 'hidden',
              }}
            >
              <Tag color="green" style={{ marginInlineEnd: 0, fontSize: 10 }}>
                {p.name}
              </Tag>
              <span
                style={{
                  color: 'var(--ant-color-text-tertiary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={p.reasons.join(' · ')}
              >
                {p.reasons.slice(0, 2).join(' · ')}
                {p.reasons.length > 2 && ' …'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
