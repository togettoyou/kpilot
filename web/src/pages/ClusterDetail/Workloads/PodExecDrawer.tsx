import { SnippetsOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
// xterm v5 (legacy `xterm` package, not @xterm/xterm v6). v6 ships with
// a class-inheritance pattern that webpack's tree-shaker incorrectly
// marks as "unused pure expression" and replaces with `extends null`,
// crashing the terminal with "Super constructor null of anonymous
// class". v5 doesn't trigger that analyzer path and is the version
// that has years of bundler-compat in production.
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import {
  Alert,
  Button,
  Drawer,
  message,
  Select,
  Space,
  Tag,
  theme as antdTheme,
  Tooltip,
} from 'antd';
import 'xterm/css/xterm.css';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { buildPodExecURL } from '@/services/kpilot/pod';
import { getWorkload } from '@/services/kpilot/workload';

interface PodExecDrawerProps {
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

export function PodExecDrawer({
  open,
  onClose,
  clusterId,
  namespace,
  podName,
}: PodExecDrawerProps) {
  const intl = useIntl();
  const { token } = antdTheme.useToken();

  const [containers, setContainers] = useState<ContainerOption[]>([]);
  const [container, setContainer] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionKey = useRef(0);
  // WS handle exposed for the Paste button. Set inside the open-WS
  // effect, cleared on cleanup. Encoder is reused across paste calls
  // for the same reason it's reused inside onData — TextEncoder is
  // stateless and allocating per call is wasteful.
  const wsRef = useRef<WebSocket | null>(null);
  const pasteEncoderRef = useRef(new TextEncoder());

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

  // Open WS + xterm when params are ready.
  useEffect(() => {
    if (!open || !container || !containerRef.current) return;

    sessionKey.current += 1;
    const myKey = sessionKey.current;
    setError(null);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
      theme: { background: '#1e1e2e', foreground: '#cdd6f4' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    setTimeout(() => fit.fit(), 0);

    termRef.current = term;
    fitRef.current = fit;

    const dims = { cols: term.cols || 80, rows: term.rows || 24 };

    const url = buildPodExecURL(clusterId, namespace, podName, {
      container,
      cols: dims.cols,
      rows: dims.rows,
    });
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onmessage = (e) => {
      if (myKey !== sessionKey.current) return;
      const buf = new Uint8Array(e.data as ArrayBuffer);
      if (buf.length === 0) return;
      const tag = buf[0];
      const body = buf.subarray(1);
      switch (tag) {
        case 1: // stdout
        case 2: // stderr
          term.write(body);
          break;
        case 3: {
          // session end (rest is utf-8 error string)
          const errMsg = new TextDecoder().decode(body);
          term.write(
            `\r\n\x1b[33m[session ended${errMsg ? ': ' + errMsg : ''}]\x1b[0m\r\n`,
          );
          break;
        }
      }
    };
    ws.onerror = () => {
      if (myKey !== sessionKey.current) return;
      setError(intl.formatMessage({ id: 'pages.podExec.error.connection' }));
    };
    ws.onclose = (ev) => {
      if (myKey !== sessionKey.current) return;
      // Distinguish abnormal closes (transport drop / server crash)
      // from clean session ends (user typed exit, container died).
      // 1000 = normal, 1005 = no status; both are happy paths. The
      // session-ended message printed via the tag=3 protocol frame
      // (see onmessage) already covers the clean case.
      if (!ev.wasClean && ev.code !== 1000 && ev.code !== 1005) {
        setError(
          intl.formatMessage(
            { id: 'pages.podExec.error.closed' },
            { code: ev.code, reason: ev.reason || '—' },
          ),
        );
      }
    };

    // Hoist the encoder out of the keystroke / resize callbacks — allocating
    // a new TextEncoder on every keypress is wasteful (and the spec says
    // instances are stateless / safe to reuse).
    const encoder = new TextEncoder();

    // Pipe terminal input → ws stdin frames (tag 0). Single allocation: encode
    // first to know the byte length, then build the framed payload once.
    const dataDisposable = term.onData((data) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const enc = encoder.encode(data);
      const payload = new Uint8Array(enc.length + 1);
      payload[0] = 0;
      payload.set(enc, 1);
      ws.send(payload);
    });

    // Pipe terminal resize → ws resize frames (tag 1, JSON body).
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const body = encoder.encode(JSON.stringify({ cols, rows }));
      const payload = new Uint8Array(body.length + 1);
      payload[0] = 1;
      payload.set(body, 1);
      ws.send(payload);
    });

    // Refit on window resize.
    const onWindowResize = () => fit.fit();
    window.addEventListener('resize', onWindowResize);

    term.focus();

    return () => {
      window.removeEventListener('resize', onWindowResize);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      try {
        ws.close();
      } catch {
        // ignore
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clusterId, namespace, podName, container, reloadKey]);

  // Refit when drawer animation finishes (drawer width changes).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => fitRef.current?.fit(), 350);
    return () => clearTimeout(t);
  }, [open]);

  // Paste from clipboard → send as stdin to the running process.
  // Mirrors what xterm's bracketed-paste / Ctrl+Shift+V handler does
  // for users who can't use keyboard shortcuts (read-only kiosks,
  // mobile/tablet sessions, accessibility tools). The bytes go
  // straight into the same stdin frame format onData uses.
  //
  // We DON'T strip newlines — a paste with a trailing newline
  // submits the line, matching what a real terminal does. If the
  // user needs paste-without-submit, they can paste then backspace
  // the newline.
  const handlePaste = async () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      message.warning(
        intl.formatMessage({ id: 'pages.podExec.paste.notReady' }),
      );
      return;
    }
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      message.error(intl.formatMessage({ id: 'pages.podExec.paste.failed' }));
      return;
    }
    if (!text) {
      message.info(intl.formatMessage({ id: 'pages.podExec.paste.empty' }));
      return;
    }
    const enc = pasteEncoderRef.current.encode(text);
    const payload = new Uint8Array(enc.length + 1);
    payload[0] = 0;
    payload.set(enc, 1);
    ws.send(payload);
    // Refocus the terminal so the user can keep typing after the
    // paste — the button click moved focus to the button.
    termRef.current?.focus();
  };

  const containerOptions = useMemo(
    () =>
      containers.map((c) => ({
        label: c.isInit ? `${c.name} (init)` : c.name,
        value: c.name,
      })),
    [containers],
  );

  return (
    <Drawer
      title={
        <Space>
          <span>{intl.formatMessage({ id: 'pages.podExec.title' })}</span>
          <Tag>{namespace}</Tag>
          <Tag color="blue">{podName}</Tag>
        </Space>
      }
      open={open}
      onClose={onClose}
      size="70vw"
      maskClosable={false}
      destroyOnHidden
      styles={{
        // overflow:hidden so the body can't scroll — children own their own
        // scrolling (xterm has its own scrollback). Without this, sub-pixel
        // height rounding in flex layout produces an extra body scrollbar
        // alongside the terminal's.
        body: {
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        },
      }}
    >
      {/* Container selector + reload moved to a body control bar so the
          header title doesn't wrap on long pod names (the title already
          carries namespace + pod-name tags). */}
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
            {intl.formatMessage({ id: 'pages.podExec.container' })}
          </span>
          <Select
            size="small"
            value={container}
            onChange={setContainer}
            options={containerOptions}
            style={{ minWidth: 160 }}
          />
        </Space>
        <Tooltip
          title={intl.formatMessage({ id: 'pages.podExec.paste.tooltip' })}
        >
          <Button
            size="small"
            icon={<SnippetsOutlined />}
            onClick={handlePaste}
          >
            {intl.formatMessage({ id: 'pages.podExec.paste' })}
          </Button>
        </Tooltip>
        <Button size="small" onClick={() => setReloadKey((k) => k + 1)}>
          {intl.formatMessage({ id: 'pages.podExec.reload' })}
        </Button>
      </div>
      {error && (
        <Alert
          message={error}
          type="error"
          banner
          action={
            <Button
              size="small"
              type="link"
              onClick={() => {
                setError(null);
                setReloadKey((k) => k + 1);
              }}
            >
              {intl.formatMessage({ id: 'pages.podExec.reconnect' })}
            </Button>
          }
        />
      )}
      {/* Wrap the xterm mount in a flex parent: padding lives on the wrapper
          so the terminal element sees a clean box. FitAddon rounds rows by
          line-height, and padding on the mount element itself caused the
          last row to clip when content scrolled. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          background: '#1e1e2e',
          padding: 8,
          display: 'flex',
        }}
      >
        <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
      </div>
    </Drawer>
  );
}

// Default export so React.lazy can code-split this drawer. xterm +
// FitAddon + the bundled xterm.css are ~150 KB gzip; we only need them
// when a user actually opens a Pod terminal.
export default PodExecDrawer;
