import { ClearOutlined, ReloadOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import {
  Alert,
  theme as antdTheme,
  Button,
  Drawer,
  Select,
  Space,
  Switch,
  Tag,
} from 'antd';
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { buildPodLogsURL } from '@/services/kpilot/pod';
import { getWorkload } from '@/services/kpilot/workload';

const MAX_LINES = 5000; // hard cap to keep DOM size bounded
const TAIL_OPTIONS = [100, 500, 1000, 5000];

interface PodLogsDrawerProps {
  open: boolean;
  onClose: () => void;
  clusterId: string;
  namespace: string;
  podName: string;
}

interface ContainerOption {
  name: string;
  isInit?: boolean;
}

export function PodLogsDrawer({
  open,
  onClose,
  clusterId,
  namespace,
  podName,
}: PodLogsDrawerProps) {
  const intl = useIntl();
  const { token } = antdTheme.useToken();

  const [containers, setContainers] = useState<ContainerOption[]>([]);
  const [container, setContainer] = useState<string>('');
  const [tail, setTail] = useState<number>(100);
  const [follow, setFollow] = useState(true);
  const [previous, setPrevious] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [, forceTick] = useState(0); // trigger re-render when buffer changes

  const linesRef = useRef<string[]>([]);
  const preRef = useRef<HTMLPreElement | null>(null);
  const sessionKey = useRef(0);
  const flushScheduledRef = useRef(false);

  // Fetch pod spec to enumerate containers when drawer opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getWorkload(clusterId, 'pods', podName, namespace)
      .then((pod: any) => {
        if (cancelled) return;
        const init = (pod?.spec?.initContainers ?? []).map((c: any) => ({
          name: c.name,
          isInit: true,
        }));
        const main = (pod?.spec?.containers ?? []).map((c: any) => ({
          name: c.name,
        }));
        const list = [...init, ...main];
        setContainers(list);
        if (list.length > 0 && !container) {
          // Default to the first non-init container, or the first init container if none.
          const firstMain = main[0]?.name;
          setContainer(firstMain ?? list[0].name);
        }
      })
      .catch((err: any) => {
        if (!cancelled) setError(String(err?.message ?? err));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clusterId, namespace, podName]);

  // Open WS when params are ready / change.
  useEffect(() => {
    if (!open || !container) return;

    sessionKey.current += 1;
    const myKey = sessionKey.current;
    linesRef.current = [];
    setError(null);
    forceTick((t) => t + 1);

    const url = buildPodLogsURL(clusterId, namespace, podName, {
      container,
      follow,
      tail,
      previous,
    });
    const ws = new WebSocket(url);

    let pending = ''; // accumulate partial lines across binary frames

    // Throttle React re-renders to one per animation frame. With chatty pods
    // logs can arrive at >1k lines/sec; without batching, every chunk would
    // trigger a re-render + full <pre> reflow and freeze the UI.
    const scheduleFlush = () => {
      if (flushScheduledRef.current) return;
      flushScheduledRef.current = true;
      requestAnimationFrame(() => {
        flushScheduledRef.current = false;
        forceTick((t) => t + 1);
      });
    };

    ws.onmessage = (e) => {
      if (myKey !== sessionKey.current) return;
      const data = typeof e.data === 'string' ? e.data : '';
      pending += data;
      const idx = pending.lastIndexOf('\n');
      if (idx >= 0) {
        const complete = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        const newLines = complete.split('\n');
        linesRef.current = linesRef.current.concat(newLines);
        if (linesRef.current.length > MAX_LINES) {
          linesRef.current = linesRef.current.slice(
            linesRef.current.length - MAX_LINES,
          );
        }
        scheduleFlush();
      }
    };
    ws.onerror = () => {
      if (myKey !== sessionKey.current) return;
      setError(intl.formatMessage({ id: 'pages.podLogs.error.connection' }));
    };
    ws.onclose = () => {
      if (myKey !== sessionKey.current) return;
      // Flush any trailing partial line.
      if (pending) {
        linesRef.current = linesRef.current.concat([pending]);
        pending = '';
        scheduleFlush();
      }
    };

    return () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    clusterId,
    namespace,
    podName,
    container,
    tail,
    follow,
    previous,
    reloadKey,
  ]);

  // Auto-scroll to bottom on new content.
  useLayoutEffect(() => {
    if (!autoScroll) return;
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  // When user manually scrolls up, disable auto-scroll; re-enable when they
  // scroll all the way back to the bottom.
  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    setAutoScroll(atBottom);
  };

  const handleClear = () => {
    linesRef.current = [];
    forceTick((t) => t + 1);
  };

  const handleReload = () => {
    setReloadKey((k) => k + 1);
  };

  const containerOptions = useMemo(
    () =>
      containers.map((c) => ({
        label: c.isInit ? `${c.name} (init)` : c.name,
        value: c.name,
      })),
    [containers],
  );

  const lineCount = linesRef.current.length;

  return (
    <Drawer
      title={
        <Space>
          <span>{intl.formatMessage({ id: 'pages.podLogs.title' })}</span>
          <Tag>{namespace}</Tag>
          <Tag color="blue">{podName}</Tag>
        </Space>
      }
      open={open}
      onClose={onClose}
      size="70vw"
      destroyOnHidden
      extra={
        <Space>
          <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>
            {intl.formatMessage(
              { id: 'pages.podLogs.lineCount' },
              { n: lineCount },
            )}
          </span>
          <Button size="small" icon={<ReloadOutlined />} onClick={handleReload}>
            {intl.formatMessage({ id: 'pages.podLogs.reload' })}
          </Button>
          <Button size="small" icon={<ClearOutlined />} onClick={handleClear}>
            {intl.formatMessage({ id: 'pages.podLogs.clear' })}
          </Button>
        </Space>
      }
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column' },
      }}
    >
      <div
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <Space>
          <span style={{ fontSize: 13 }}>
            {intl.formatMessage({ id: 'pages.podLogs.container' })}
          </span>
          <Select
            size="small"
            value={container}
            onChange={setContainer}
            options={containerOptions}
            style={{ minWidth: 160 }}
          />
        </Space>
        <Space>
          <span style={{ fontSize: 13 }}>
            {intl.formatMessage({ id: 'pages.podLogs.tail' })}
          </span>
          <Select
            size="small"
            value={tail}
            onChange={setTail}
            options={TAIL_OPTIONS.map((n) => ({ label: String(n), value: n }))}
            style={{ width: 90 }}
          />
        </Space>
        <Space>
          <Switch size="small" checked={follow} onChange={setFollow} />
          <span style={{ fontSize: 13 }}>
            {intl.formatMessage({ id: 'pages.podLogs.follow' })}
          </span>
        </Space>
        <Space>
          <Switch size="small" checked={previous} onChange={setPrevious} />
          <span style={{ fontSize: 13 }}>
            {intl.formatMessage({ id: 'pages.podLogs.previous' })}
          </span>
        </Space>
      </div>
      {error && (
        <Alert message={error} type="error" banner style={{ flexShrink: 0 }} />
      )}
      <pre
        ref={preRef}
        onScroll={onScroll}
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
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {linesRef.current.join('\n')}
      </pre>
    </Drawer>
  );
}
