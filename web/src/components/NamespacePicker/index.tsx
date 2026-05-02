import { ReloadOutlined } from '@ant-design/icons';
import { useIntl, useLocation, useModel } from '@umijs/max';
import { Button, Divider, Select, Space } from 'antd';
import React, { useEffect } from 'react';

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

  // Refetch the cluster's namespace list whenever the cluster scope changes
  // (initial entry into a cluster, or switching clusters via the URL).
  // ns.refresh is a stable useCallback so referencing it in deps doesn't
  // cause an effect loop.
  useEffect(() => {
    if (clusterId) ns.refresh(clusterId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  // Nothing to pick on non-workload pages, or for the cluster-scoped PV.
  if (!clusterId || !resourceType || resourceType === 'persistentvolumes') {
    return null;
  }

  const state = ns.get(clusterId);

  return (
    <Space>
      <span style={{ fontSize: 13 }}>
        {intl.formatMessage({ id: 'namespacePicker.label' })}
      </span>
      <Select
        size="small"
        loading={state.loading}
        allowClear
        placeholder={intl.formatMessage({
          id: 'pages.workloads.allNamespaces',
        })}
        style={{ width: 180 }}
        value={state.selected || undefined}
        onChange={(v) => ns.setSelected(clusterId, v ?? '')}
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
