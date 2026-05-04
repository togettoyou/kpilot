import { ReloadOutlined } from '@ant-design/icons';
import { useIntl, useLocation, useModel } from '@umijs/max';
import type { RefSelectProps } from 'antd';
import { Button, Divider, Select, Space } from 'antd';
import React, { useEffect, useRef } from 'react';

import {
  CLUSTER_SCOPED_TYPES,
  type WorkloadResourceType,
} from '@/services/kpilot/workload';

// NamespacePicker is mounted once via ProLayout's actionsRender. It hides
// itself for routes that don't care about a namespace (cluster list, Nodes,
// PVs which are cluster-scoped) and shows a context-aware Select otherwise.
//
// State lives in the `namespace` model so navigating between workload sub-
// pages (deployments → services → …) keeps the chosen namespace, and each
// cluster has its own independent selection + list cache.
export function NamespacePicker() {
  const intl = useIntl();
  const { pathname } = useLocation();

  const match = pathname.match(/^\/clusters\/([^/]+)\/workloads\/([^/]+)/);
  const clusterId = match?.[1];
  const resourceType = match?.[2];

  const ns = useModel('namespace');
  const rootRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<RefSelectProps>(null);

  // Refetch the cluster's namespace list whenever the cluster scope changes
  // (initial entry into a cluster, or switching clusters via the URL).
  // ns.refresh is a stable useCallback so referencing it in deps doesn't
  // cause an effect loop.
  useEffect(() => {
    if (clusterId) ns.refresh(clusterId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  // Strip ProLayout's `*-header-actions-item / -hover` wrapper class on the
  // parent div. CSS overrides via :has() / class chain didn't take in
  // practice (cssinjs hashed rules + specificity), so we just rip the
  // class out of the DOM directly. The wrapper div itself stays — only
  // the styling hooks go.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const wrapper = root.parentElement;
    if (!wrapper) return;
    const offenders = Array.from(wrapper.classList).filter(
      (c) => c.includes('actions-item') || c.includes('actions-hover'),
    );
    offenders.forEach((c) => wrapper.classList.remove(c));
  });

  // Nothing to pick on non-workload pages or on a cluster-scoped resource.
  if (
    !clusterId ||
    !resourceType ||
    CLUSTER_SCOPED_TYPES.has(resourceType as WorkloadResourceType)
  ) {
    return null;
  }

  const state = ns.get(clusterId);

  return (
    <Space ref={rootRef} style={{ marginInlineEnd: 12 }}>
      <span style={{ fontSize: 13 }}>
        {intl.formatMessage({ id: 'namespacePicker.label' })}
      </span>
      <Select
        ref={selectRef}
        size="small"
        loading={state.loading}
        allowClear
        // Client-side substring search — namespace lists are short enough
        // (rarely >100) that filtering in the browser is fine.
        showSearch
        optionFilterProp="label"
        filterOption={(input, opt) =>
          (opt?.label as string)
            ?.toLowerCase()
            .includes(input.trim().toLowerCase())
        }
        placeholder={intl.formatMessage({
          id: 'pages.workloads.allNamespaces',
        })}
        style={{ width: 180 }}
        value={state.selected || undefined}
        onChange={(v) => {
          ns.setSelected(clusterId, v ?? '');
          // Blur the search input after selection so the caret stops
          // blinking over the picked value. Same as the user clicking
          // outside the picker.
          selectRef.current?.blur();
        }}
        options={state.list.map((n) => ({ label: n, value: n }))}
        popupRender={(menu) => (
          <>
            {menu}
            <Divider style={{ margin: '4px 0' }} />
            <Button
              type="text"
              size="small"
              block
              icon={<ReloadOutlined />}
              loading={state.loading}
              onClick={(e) => {
                e.stopPropagation();
                ns.refresh(clusterId);
              }}
            >
              {intl.formatMessage({
                id: 'pages.workloads.refresh.namespaces',
              })}
            </Button>
          </>
        )}
      />
    </Space>
  );
}
