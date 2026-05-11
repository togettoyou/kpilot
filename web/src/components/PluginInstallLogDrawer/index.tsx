import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
} from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import { Drawer, Space, Tag, theme as antdTheme, Typography } from 'antd';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { buildPluginInstallLogURL } from '@/services/kpilot/plugin';

// One log frame on the wire — matches the Go side's PluginLogEntry
// in pkg/server/gateway/plugin_log.go. `kind="chunk"` for progress
// lines, `kind="end"` for the terminal success / failure marker,
// `kind="reset"` emitted by the gateway when a new operation starts
// on a plugin that already had an end (user re-enabled / disabled).
interface LogEntry {
  kind: 'chunk' | 'end' | 'reset';
  level?: 'info' | 'warn' | 'error';
  ts?: number;
  message?: string;
  success?: boolean;
  summary?: string;
}

interface PluginInstallLogDrawerProps {
  open: boolean;
  clusterId: string;
  // The CRD metadata.name — matches the URL path the worker pushes
  // logs under and the gateway buffer key.
  pluginName: string;
  // Human label for the drawer title.
  displayName: string;
  onClose: () => void;
}

// PluginInstallLogDrawer renders the live install / upgrade / uninstall
// log streamed from the worker through the gateway's per-(cluster,
// plugin) ring buffer. Lifecycle:
//
//   open → WS connects → replay buffered entries → stream live frames
//   "end" frame arrives → terminal banner (success/failed) + spinner stops
//   close → WS closed, state reset on next open via destroyOnHidden
//
// No history persistence — if the user closes mid-install and reopens
// after the worker's End frame fell out of the TTL window (10 min),
// they'll get whatever's still in the ring buffer plus future frames.
// In practice installs finish well within TTL so this is fine.
export function PluginInstallLogDrawer({
  open,
  clusterId,
  pluginName,
  displayName,
  onClose,
}: PluginInstallLogDrawerProps) {
  const intl = useIntl();
  const { token } = antdTheme.useToken();

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [endStatus, setEndStatus] = useState<{ success: boolean; summary: string } | null>(null);
  // isStale = WS opened, nothing came back within the silence
  // window. Means either the ring buffer's 10-min TTL expired or
  // no operation is running on this plugin right now. We swap the
  // placeholder message and close the WS so the connection isn't
  // sitting idle on a Failed-but-stale plugin.
  const [isStale, setIsStale] = useState(false);
  const preRef = useRef<HTMLPreElement | null>(null);

  // Open the WS when the drawer opens; close on unmount, re-open,
  // receipt of an `end` frame, or expiry of the silence timer.
  // destroyOnHidden on the Drawer below means this effect's deps
  // flip cleanly between open/close, so we don't need extra state.
  useEffect(() => {
    if (!open || !clusterId || !pluginName) return;
    setEntries([]);
    setEndStatus(null);
    setIsStale(false);
    const ws = new WebSocket(buildPluginInstallLogURL(clusterId, pluginName));

    // Silence timer: server writes the snapshot immediately on WS
    // upgrade. Healthy paths (mid-install, recently-ended) get the
    // first frame within tens of ms. If we go 2 s with nothing, the
    // session has no buffer AND no operation in flight — flip to the
    // stale placeholder and close. 2 s is well above realistic
    // WS handshake + snapshot replay latency on slow networks.
    let staleTimer: number | null = window.setTimeout(() => {
      staleTimer = null;
      setIsStale(true);
      try {
        ws.close();
      } catch {
        // ignore
      }
    }, 2000);
    const clearStale = () => {
      if (staleTimer !== null) {
        window.clearTimeout(staleTimer);
        staleTimer = null;
      }
    };

    ws.onmessage = (e) => {
      clearStale();
      try {
        const entry: LogEntry = JSON.parse(e.data);
        if (entry.kind === 'reset') {
          // Server tells us a fresh operation is starting on this
          // plugin — wipe stale state so the new install / uninstall
          // doesn't render below the previous session's "✓ installed".
          setEntries([]);
          setEndStatus(null);
          return;
        }
        setEntries((prev) => [...prev, entry]);
        if (entry.kind === 'end') {
          setEndStatus({
            success: !!entry.success,
            summary: entry.summary ?? '',
          });
          // No more chunks are coming for this session — close the
          // socket so we don't hold an idle connection. If the user
          // triggers another operation later, the drawer closes and
          // reopens via destroyOnHidden, which makes a fresh WS.
          try {
            ws.close();
          } catch {
            // ignore — already closed
          }
        }
      } catch {
        // Malformed frame — skip silently. Backend always emits valid
        // JSON, so this branch is defensive.
      }
    };
    return () => {
      clearStale();
      try {
        ws.close();
      } catch {
        // ignore — already closed
      }
    };
  }, [open, clusterId, pluginName]);

  // Auto-scroll to the bottom whenever the buffer grows. useLayoutEffect
  // (not useEffect) so the scroll lands in the same frame as the new
  // text — useEffect would flash the last line off-screen first.
  useLayoutEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const banner = useMemo(() => {
    if (isStale) {
      // WS opened, got nothing in the silence window — buffer expired
      // or no operation is running right now. "In progress" would be
      // a lie since there's nothing in progress; use a neutral Tag.
      return (
        <Tag>
          {intl.formatMessage({ id: 'pages.pluginInstallLog.unavailable' })}
        </Tag>
      );
    }
    if (!endStatus) {
      return (
        <Tag icon={<LoadingOutlined spin />} color="processing">
          {intl.formatMessage({ id: 'pages.pluginInstallLog.running' })}
        </Tag>
      );
    }
    return endStatus.success ? (
      <Tag icon={<CheckCircleFilled />} color="success">
        {intl.formatMessage({ id: 'pages.pluginInstallLog.success' })}
      </Tag>
    ) : (
      <Tag icon={<CloseCircleFilled />} color="error">
        {intl.formatMessage({ id: 'pages.pluginInstallLog.failed' })}
      </Tag>
    );
  }, [endStatus, isStale, intl]);

  return (
    <Drawer
      title={
        <Space>
          <span>
            {intl.formatMessage(
              { id: 'pages.pluginInstallLog.title' },
              { name: displayName },
            )}
          </span>
          {banner}
        </Space>
      }
      open={open}
      onClose={onClose}
      size="60vw"
      maskClosable={false}
      destroyOnHidden
      styles={{
        body: {
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        },
      }}
    >
      <pre
        ref={preRef}
        style={{
          flex: 1,
          margin: 0,
          padding: '12px 16px',
          background: token.colorBgLayout,
          color: token.colorText,
          fontFamily:
            'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
          fontSize: 12,
          lineHeight: 1.55,
          overflow: 'auto',
          // Stop wheel scrolling at the bottom from chaining to the
          // outer page (same trick as the Failed-phase popover).
          overscrollBehavior: 'contain',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {entries.length === 0 && (
          <Typography.Text type="secondary">
            {intl.formatMessage({
              id: isStale
                ? 'pages.pluginInstallLog.stale'
                : 'pages.pluginInstallLog.empty',
            })}
          </Typography.Text>
        )}
        {entries.map((entry, i) => {
          if (entry.kind === 'end') {
            return (
              <div
                key={i}
                style={{
                  marginTop: 8,
                  color: entry.success ? token.colorSuccess : token.colorError,
                  fontWeight: 600,
                }}
              >
                {entry.success ? '✓ ' : '✗ '}
                {entry.summary || ''}
              </div>
            );
          }
          const ts = entry.ts ? formatHMS(entry.ts) : '';
          const levelColor =
            entry.level === 'error'
              ? token.colorError
              : entry.level === 'warn'
                ? token.colorWarning
                : token.colorPrimary;
          return (
            <div key={i}>
              <span style={{ color: token.colorTextTertiary }}>[{ts}] </span>
              <span
                style={{
                  color: levelColor,
                  fontWeight: entry.level === 'error' ? 600 : undefined,
                }}
              >
                {(entry.level || 'info').toUpperCase()}
              </span>
              {'  '}
              <span>{entry.message}</span>
            </div>
          );
        })}
      </pre>
    </Drawer>
  );
}

// formatHMS renders a unix-ms timestamp as HH:MM:SS in the user's
// locale. Avoids the Date.toLocaleTimeString locale-dependent format
// which can include AM/PM and other variants we don't want here.
function formatHMS(unixMs: number): string {
  const d = new Date(unixMs);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
