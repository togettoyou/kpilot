import { InboxOutlined, UploadOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import type { UploadProps } from 'antd';
import { App, theme as antdTheme, Button, Drawer, Space, Upload } from 'antd';
import React, { useEffect, useState } from 'react';

import { applyYAML } from '@/services/kpilot/workload';
import { YamlEditor } from './YamlEditor';

interface ApplyYamlDrawerProps {
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
  clusterId: string;
}

const PLACEHOLDER = `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
  namespace: default
data:
  hello: world
`;

const MAX_FILE_BYTES = 1 << 20; // 1 MB — same cap as the server

export function ApplyYamlDrawer({
  open,
  onClose,
  onApplied,
  clusterId,
}: ApplyYamlDrawerProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const { token } = antdTheme.useToken();

  const [yamlText, setYamlText] = useState('');
  const [applying, setApplying] = useState(false);

  // Seed with a small template each time the drawer opens — gives a starting
  // point if the user is creating something from scratch and didn't bring a
  // file. They can clear/replace freely.
  useEffect(() => {
    if (open) setYamlText(PLACEHOLDER);
  }, [open]);

  const handleSubmit = async () => {
    const trimmed = yamlText.trim();
    if (!trimmed) {
      message.warning(intl.formatMessage({ id: 'pages.applyYaml.empty' }));
      return;
    }
    setApplying(true);
    try {
      await applyYAML(clusterId, trimmed);
      message.success(intl.formatMessage({ id: 'pages.applyYaml.success' }));
      setYamlText('');
      onApplied();
      onClose();
    } catch {
      // Global error handler in requestErrorConfig already shows the toast.
    } finally {
      setApplying(false);
    }
  };

  const uploadProps: UploadProps = {
    accept: '.yaml,.yml,.json',
    beforeUpload: (file) => {
      if (file.size > MAX_FILE_BYTES) {
        message.error(intl.formatMessage({ id: 'pages.applyYaml.tooLarge' }));
        return Upload.LIST_IGNORE;
      }
      const reader = new FileReader();
      reader.onload = (e) => setYamlText(String(e.target?.result ?? ''));
      reader.onerror = () =>
        message.error(intl.formatMessage({ id: 'pages.applyYaml.readError' }));
      reader.readAsText(file);
      return Upload.LIST_IGNORE; // we handle the read manually; don't upload
    },
    showUploadList: false,
    multiple: false,
  };

  return (
    <Drawer
      title={intl.formatMessage({ id: 'pages.applyYaml.title' })}
      open={open}
      onClose={onClose}
      size={680}
      destroyOnHidden
      extra={
        <Upload {...uploadProps}>
          <Button icon={<UploadOutlined />} size="small">
            {intl.formatMessage({ id: 'pages.applyYaml.upload' })}
          </Button>
        </Upload>
      }
      footer={
        <Space style={{ float: 'right' }}>
          <Button onClick={onClose}>
            {intl.formatMessage({ id: 'pages.workloads.cancel' })}
          </Button>
          <Button type="primary" loading={applying} onClick={handleSubmit}>
            {intl.formatMessage({ id: 'pages.applyYaml.apply' })}
          </Button>
        </Space>
      }
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column' },
      }}
    >
      <Upload.Dragger
        {...uploadProps}
        style={{
          margin: 16,
          marginBottom: 8,
          padding: '8px 0',
          border: `1px dashed ${token.colorBorderSecondary}`,
        }}
      >
        <p className="ant-upload-drag-icon" style={{ marginBottom: 4 }}>
          <InboxOutlined style={{ fontSize: 24 }} />
        </p>
        <p
          className="ant-upload-text"
          style={{ fontSize: 13, marginBottom: 0 }}
        >
          {intl.formatMessage({ id: 'pages.applyYaml.dropHint' })}
        </p>
      </Upload.Dragger>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 16px 16px' }}>
        <YamlEditor value={yamlText} onChange={(v) => setYamlText(v)} />
      </div>
    </Drawer>
  );
}
