import { AimOutlined } from '@ant-design/icons';
import { FlowGraph } from '@ant-design/graphs';
import { useIntl } from '@umijs/max';
import { Button, Tag, Tooltip, Typography } from 'antd';
import React, { useMemo, useState } from 'react';

import { PLUGINS_META, metaForAction, metaForPlugin } from './schedulerMeta';

const { Text } = Typography;

// SchedulerFlowDiagram renders a read-only left-to-right pipeline of
// the user's current scheduler config: Pending PodGroup → each
// configured action in order → Scheduled, with per-action chips
// listing the currently-configured plugins whose callbacks the
// action actually invokes. Lets users see at a glance which plugins
// "wake up" at which scheduling stage.
//
// Modeled on the @ant-design/graphs FlowGraph task-scheduling
// demo: source/target endpoint nodes with a left strip, colored
// action nodes with a header bar + plugin body, hover-activate-chain
// for highlighting the pipeline from any node.

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

// ACTION_COLORS picks a distinct accent per action so users can
// scan the pipeline by color. Picked from antd's palette so they
// remain readable in both light + dark themes.
const ACTION_COLORS: Record<string, string> = {
  enqueue: '#1890ff', // blue — entry into the loop
  allocate: '#52c41a', // green — primary placement
  preempt: '#faad14', // gold — same-queue destructive
  reclaim: '#fa541c', // orange — cross-queue destructive
  backfill: '#13c2c2', // cyan — opportunistic fill
  shuffle: '#722ed1', // purple — rebalance
};

interface NodeData {
  kind: 'source' | 'target' | 'action';
  label: string;
  desc?: string;
  color?: string;
  plugins?: { name: string }[];
}

export default function SchedulerFlowDiagram({
  draft,
}: {
  draft: SchedulerConfShape;
}) {
  const intl = useIntl();
  // Capture the G6 Graph instance once it's ready so the reset-view
  // button can call fitView() on it. Using onReady is more reliable
  // than ref forwarding here — the ref is sometimes null on early
  // clicks because @ant-design/graphs initializes the Graph
  // asynchronously after first render.
  const [graph, setGraph] = useState<{ fitView: () => unknown } | null>(null);

  const data = useMemo(() => {
    const actions = (draft.actions ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const pluginsInOrder: string[] = [];
    (draft.tiers ?? []).forEach((t) => {
      (t.plugins ?? []).forEach((p) => {
        if (p.name) pluginsInOrder.push(p.name);
      });
    });

    const nodes: { id: string; data: NodeData }[] = [];
    const edges: { source: string; target: string }[] = [];

    nodes.push({
      id: 'start',
      data: {
        kind: 'source',
        label: intl.formatMessage({ id: 'pages.compute.scheduler.flow.start' }),
      },
    });

    let prevId = 'start';
    actions.forEach((a) => {
      const actionCallbacks = ACTION_CALLBACKS[a] ?? [];
      const meta = metaForAction(a);
      // For each plugin in this scheduler config, intersect its
      // registered callbacks with what this action actually invokes;
      // if non-empty, list it under the action.
      const plugins = pluginsInOrder
        .map((name) => {
          const pmeta = PLUGINS_META[name];
          if (!pmeta?.callbacks) {
            // Unknown plugin — show under every action conservatively
            // (we can't know what it registers; user opted in by
            // adding it, so surfacing it is safer than hiding).
            return { name };
          }
          const overlap = pmeta.callbacks.filter((c) =>
            actionCallbacks.includes(c),
          );
          if (overlap.length === 0) return null;
          return { name };
        })
        .filter(Boolean) as NodeData['plugins'];

      nodes.push({
        id: a,
        data: {
          kind: 'action',
          label: a,
          desc: meta.desc,
          color: ACTION_COLORS[a] ?? '#1890ff',
          plugins,
        },
      });
      edges.push({ source: prevId, target: a });
      prevId = a;
    });

    nodes.push({
      id: 'end',
      data: {
        kind: 'target',
        label: intl.formatMessage({ id: 'pages.compute.scheduler.flow.end' }),
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

  // Per-node size: endpoints are slim left/right caps; action cards
  // grow vertically with plugin density. Computed per-node so dagre
  // can lay out the row at the right rank.
  const nodeSize = (n: { data?: NodeData }): [number, number] => {
    const d = n.data;
    if (!d || d.kind !== 'action') return [180, 50];
    const pluginCount = d.plugins?.length ?? 0;
    // ~28 px per plugin tag row, +60 for header + padding.
    return [240, Math.max(80, 60 + pluginCount * 28)];
  };

  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        minHeight: 480,
        width: '100%',
      }}
    >
      <Tooltip
        title={intl.formatMessage({
          id: 'pages.compute.scheduler.flow.fitView',
        })}
      >
        <Button
          size="small"
          icon={<AimOutlined />}
          onClick={() => graph?.fitView()}
          style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}
        />
      </Tooltip>
      <FlowGraph
        data={data as any}
        autoFit="center"
        animation={false}
        onReady={(g) => setGraph(g as any)}
        node={{
          style: {
            component: (d: any) => <PipelineNode data={d.data as NodeData} />,
            size: nodeSize as any,
          },
        }}
        edge={{
          // Override FlowGraph's default polyline + orth router with
          // a smooth left-to-right cubic curve. The orth router
          // produced erratic right-angle paths when action cards
          // have different heights (allocate has many plugins,
          // enqueue may have one); cubic-horizontal stays clean for
          // any vertical offset.
          type: 'cubic-horizontal',
          style: {
            lineWidth: 1.5,
            stroke: 'var(--ant-color-border)',
            endArrow: true,
          },
          state: {
            active: { stroke: 'var(--ant-color-primary)', lineWidth: 2 },
          },
        }}
        layout={{
          type: 'dagre',
          rankdir: 'LR',
          nodesep: 30,
          ranksep: 80,
        }}
        // Extend (don't replace) the COMMON_OPTIONS default behaviors
        // (zoom-canvas + drag-canvas) with hover-activate-chain, so
        // hovering any node lights up the edge chain leading to it.
        behaviors={(prev) => [...prev, 'hover-activate-chain']}
      />
    </div>
  );
}

function PipelineNode({ data }: { data: NodeData }) {
  if (data.kind !== 'action') {
    // Endpoint: small chip with a left-side label strip ("起点 / 终
    // 点") and the entity name on the right. Modeled on the antd-
    // graphs task-scheduling demo's EndNode.
    const isSource = data.kind === 'source';
    const tag = isSource ? '起点' : '终点';
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          border: '1px solid var(--ant-color-border)',
          borderRadius: 4,
          background: 'var(--ant-color-bg-container)',
          display: 'flex',
          fontSize: 12,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: 44,
            background: 'var(--ant-color-fill-secondary)',
            color: 'var(--ant-color-text-secondary)',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {tag}
        </div>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 6px',
          }}
        >
          {data.label}
        </div>
      </div>
    );
  }

  // Action: header bar with the action's accent color + name; body
  // lists the participating plugins as green tags, one per line,
  // each tag hoverable for the plugin's one-line description.
  const color = data.color ?? '#1890ff';
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        border: `1px solid ${color}`,
        borderRadius: 4,
        background: 'var(--ant-color-bg-container)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Tooltip title={data.desc}>
        <div
          style={{
            background: color,
            color: '#fff',
            padding: '4px 8px',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'help',
          }}
        >
          {data.label}
        </div>
      </Tooltip>
      <div
        style={{
          flex: 1,
          padding: '6px 8px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 2,
          overflow: 'hidden',
        }}
      >
        {!data.plugins || data.plugins.length === 0 ? (
          <span
            style={{
              fontSize: 11,
              color: 'var(--ant-color-text-tertiary)',
              fontStyle: 'italic',
            }}
          >
            (无相关插件)
          </span>
        ) : (
          data.plugins.map((p) => (
            <Tooltip
              key={p.name}
              title={metaForPlugin(p.name).desc}
              mouseEnterDelay={0.2}
            >
              <Tag
                color="green"
                style={{ marginInlineEnd: 0, fontSize: 11, cursor: 'help' }}
              >
                {p.name}
              </Tag>
            </Tooltip>
          ))
        )}
      </div>
    </div>
  );
}
