import { CopyOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import {
  Alert,
  App,
  Button,
  Drawer,
  Space,
  Spin,
  Tag,
  theme as antdTheme,
} from 'antd';
import React, { useEffect, useMemo, useState } from 'react';

import type { WorkloadResourceType } from '@/services/kpilot/workload';
import { describeWorkload } from '@/services/kpilot/workload';

// Colors come from antd tokens (theme-aware), not hardcoded.
interface Palette {
  key: string;
  good: string; // Events Type=Normal
  warn: string; // Events Type=Warning
}

// Two highlight rules only — keep it minimal and predictable:
//   1. Lines shaped like "key: value" → color the key.
//   2. Inside the Events section, color the Type column (Normal/Warning).
// Everything else is rendered verbatim.

function highlightLine(
  line: string,
  p: Palette,
  inEvents: boolean,
): React.ReactNode {
  // Inside Events, the data rows look like "  Normal  Reason  Age  From  Msg".
  // Match Type as the first whitespace-separated token after indent.
  if (inEvents) {
    const em = line.match(/^(\s+)(Normal|Warning)(\b.*)$/);
    if (em) {
      const [, indent, type, rest] = em;
      const color = type === 'Normal' ? p.good : p.warn;
      return (
        <>
          {indent}
          <span style={{ color }}>{type}</span>
          {rest}
        </>
      );
    }
  }

  // key: value — color the key. Allows multi-word keys like "Service Account".
  // Lookahead requires the colon be followed by whitespace or EOL so that
  // values like `node.kubernetes.io/unreachable:NoExecute` (taint expressions
  // in Tolerations) don't get misread as a key.
  const m = line.match(/^(\s*)([^:\s][^:]*?):(?=\s|$)(\s*)(.*)$/);
  if (m) {
    const [, indent, key, gap, rest] = m;
    return (
      <>
        {indent}
        <span style={{ color: p.key }}>{key}:</span>
        {gap}
        {rest}
      </>
    );
  }
  return line;
}

interface DescribeDrawerProps {
  open: boolean;
  onClose: () => void;
  clusterId: string;
  resourceType: WorkloadResourceType;
  name: string;
  namespace: string;
}

export function DescribeDrawer({
  open,
  onClose,
  clusterId,
  resourceType,
  name,
  namespace,
}: DescribeDrawerProps) {
  const intl = useIntl();
  const { message } = App.useApp();
  const { token } = antdTheme.useToken();

  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const palette: Palette = useMemo(
    () => ({
      key: token.colorPrimary,
      good: token.colorSuccess,
      warn: token.colorWarning,
    }),
    [token],
  );

  const highlighted = useMemo(() => {
    if (!text) return null;
    // Events: is always at the bottom of kubectl describe output, so once
    // we hit it everything after is the events table.
    let inEvents = false;
    return text.split('\n').map((line, i) => {
      if (/^Events:\s*$/.test(line)) inEvents = true;
      return (
        <React.Fragment key={i}>
          {highlightLine(line, palette, inEvents)}
          {'\n'}
        </React.Fragment>
      );
    });
  }, [text, palette]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setText('');
    describeWorkload(clusterId, resourceType, name, namespace)
      .then((res) => {
        if (!cancelled) setText(typeof res === 'string' ? res : '');
      })
      .catch((err: any) => {
        if (!cancelled) setError(String(err?.message ?? err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, clusterId, resourceType, name, namespace]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(intl.formatMessage({ id: 'pages.workloads.copied' }));
    } catch {
      message.error(intl.formatMessage({ id: 'pages.describe.copyFailed' }));
    }
  };

  return (
    <Drawer
      title={
        <Space>
          <span>{intl.formatMessage({ id: 'pages.describe.title' })}</span>
          {namespace && <Tag>{namespace}</Tag>}
          <Tag color="blue">{name}</Tag>
        </Space>
      }
      open={open}
      onClose={onClose}
      size="60vw"
      maskClosable={false}
      destroyOnHidden
      extra={
        <Button
          size="small"
          icon={<CopyOutlined />}
          disabled={!text}
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
      {error && <Alert message={error} type="error" banner />}
      {loading ? (
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
        <pre
          style={{
            flex: 1,
            margin: 0,
            padding: '12px 16px',
            background: token.colorBgLayout,
            color: token.colorText,
            fontFamily:
              'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
            fontSize: 12,
            lineHeight: 1.5,
            overflow: 'auto',
            whiteSpace: 'pre',
          }}
        >
          {highlighted}
        </pre>
      )}
    </Drawer>
  );
}
