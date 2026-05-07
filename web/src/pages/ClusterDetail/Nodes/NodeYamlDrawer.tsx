import { CopyOutlined } from '@ant-design/icons';
import { useIntl, useRequest } from '@umijs/max';
import { App, Button, Drawer, Space, Spin, Tag, Typography } from 'antd';
import * as jsyaml from 'js-yaml';
import React, { useEffect, useMemo } from 'react';

import { getNode } from '@/services/kpilot/node';

import { YamlEditor } from '../Workloads/YamlEditor';

interface Props {
  clusterId: string;
  name: string | null;
  open: boolean;
  onClose: () => void;
}

// NodeYamlDrawer renders the full Node JSON as read-only YAML, the
// equivalent of `kubectl get node <name> -o yaml`. We deliberately
// don't allow editing — Node spec changes via API are rare and
// dangerous (cordon/uncordon has dedicated kubectl commands), so the
// drawer's read-only by design. If we ever want cordon/uncordon UX,
// add a separate dedicated button rather than freeing this editor.
const NodeYamlDrawer: React.FC<Props> = ({ clusterId, name, open, onClose }) => {
  const intl = useIntl();
  const { message } = App.useApp();
  // See NodeDetailDrawer for why we use manual run + useEffect instead
  // of `ready + refreshDeps`. Same close-time `name=null` request bug.
  const { data, loading, run, mutate } = useRequest(getNode, {
    manual: true,
    formatResult: (res) => res,
  });

  useEffect(() => {
    if (open && name) {
      run(clusterId, name);
    } else {
      mutate(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, name, clusterId]);

  const yamlText = useMemo(() => {
    if (!data) return '';
    return jsyaml.dump(data, { lineWidth: -1 });
  }, [data]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(yamlText);
      message.success(intl.formatMessage({ id: 'pages.workloads.copied' }));
    } catch {
      message.error(intl.formatMessage({ id: 'pages.describe.copyFailed' }));
    }
  };

  if (!name) return null;

  return (
    <Drawer
      title={
        <Space>
          <Typography.Text strong>{name}</Typography.Text>
          <Tag>YAML</Tag>
        </Space>
      }
      open={open}
      onClose={onClose}
      size="large"
      maskClosable={false}
      destroyOnHidden
      extra={
        <Button
          size="small"
          icon={<CopyOutlined />}
          disabled={!yamlText}
          onClick={handleCopy}
        >
          {intl.formatMessage({ id: 'pages.describe.copy' })}
        </Button>
      }
      styles={{
        body: {
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        },
      }}
    >
      {loading || !data ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spin />
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto' }}>
          <YamlEditor value={yamlText} readOnly />
        </div>
      )}
    </Drawer>
  );
};

export default NodeYamlDrawer;
