import { useIntl } from '@umijs/max';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { Alert, Button, Drawer, Select, Space, Tag } from 'antd';
import '@xterm/xterm/css/xterm.css';
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

const SHELL_OPTIONS = [
  { label: 'bash', value: '/bin/bash' },
  { label: 'sh', value: '/bin/sh' },
];

export function PodExecDrawer({
  open,
  onClose,
  clusterId,
  namespace,
  podName,
}: PodExecDrawerProps) {
  const intl = useIntl();

  const [containers, setContainers] = useState<ContainerOption[]>([]);
  const [container, setContainer] = useState<string>('');
  // Default to bash; the worker auto-falls back to /bin/sh if bash isn't
  // installed in the target container. The user can still pick sh explicitly.
  const [shell, setShell] = useState<string>('/bin/bash');
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionKey = useRef(0);

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
      command: shell,
      cols: dims.cols,
      rows: dims.rows,
    });
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, clusterId, namespace, podName, container, shell, reloadKey]);

  // Refit when drawer animation finishes (drawer width changes).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => fitRef.current?.fit(), 350);
    return () => clearTimeout(t);
  }, [open]);

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
      destroyOnHidden
      extra={
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
          <span style={{ fontSize: 13 }}>
            {intl.formatMessage({ id: 'pages.podExec.shell' })}
          </span>
          <Select
            size="small"
            value={shell}
            onChange={setShell}
            options={SHELL_OPTIONS}
            style={{ width: 100 }}
          />
          <Button size="small" onClick={() => setReloadKey((k) => k + 1)}>
            {intl.formatMessage({ id: 'pages.podExec.reload' })}
          </Button>
        </Space>
      }
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column' },
      }}
    >
      {error && <Alert message={error} type="error" banner />}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          background: '#1e1e2e',
          padding: 8,
        }}
      />
    </Drawer>
  );
}
