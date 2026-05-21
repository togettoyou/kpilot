import {
  ClearOutlined,
  ReloadOutlined,
  SendOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { history, useIntl, useLocation } from '@umijs/max';
import {
  Alert,
  Avatar,
  Button,
  Card,
  Col,
  Empty,
  Input,
  InputNumber,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from 'antd';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { ModelFamily, ModelInstance } from '@/services/kpilot/model';
import {
  chatCompletions,
  FAMILY_META,
  listDeployments,
} from '@/services/kpilot/model';

const { Text, Paragraph } = Typography;

// ModelChat — full-page OpenAI-compatible chat playground. The
// drawer iteration (P16-B v1) lived inside a card click; this one
// lives in the platform sider and supports:
//   - URL-driven deployment selection (?cluster=&ns=&name=) so the
//     URL is shareable / bookmarkable
//   - Deployment picker grouped by model so users can hop between
//     instances of multiple deployed models in one session
//   - Inference knobs (system prompt, temperature, max_tokens) that
//     didn't fit in a drawer footer
//   - Same buffered (stream:false) round-trip — true SSE pass-through
//     is a P16-C concern (needs HTTPResponse.IsStream + worker framing)

type ChatRole = 'user' | 'assistant' | 'system';
interface ChatMsg {
  role: ChatRole;
  content: string;
  id: string;
}

interface ChatChoice {
  message?: { role: string; content?: string };
  text?: string;
  finish_reason?: string | null;
}
interface ChatResponse {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function extractAssistantText(resp: ChatResponse): string {
  const c = resp.choices?.[0];
  if (!c) return '';
  return c.message?.content || c.text || '';
}

// pickInstance from URL params + row list. Falls back to the first
// Running row when the URL doesn't pin one, so the picker isn't
// empty on first visit.
function resolveInitial(
  rows: ModelInstance[],
  search: URLSearchParams,
): ModelInstance | null {
  const cluster = search.get('cluster');
  const ns = search.get('ns');
  const name = search.get('name');
  if (cluster && ns && name) {
    return (
      rows.find(
        (r) =>
          r.cluster_id === cluster && r.namespace === ns && r.name === name,
      ) ?? null
    );
  }
  return (
    rows.find((r) => r.status === 'Running' && r.ready_replicas > 0) ?? null
  );
}

const ModelChatPage: React.FC = () => {
  const intl = useIntl();
  const location = useLocation();
  const { token } = theme.useToken();

  const [listLoading, setListLoading] = useState(false);
  const [rows, setRows] = useState<ModelInstance[]>([]);
  const [instance, setInstance] = useState<ModelInstance | null>(null);

  const [history_, setHistory] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [temperature, setTemperature] = useState<number>(0.7);
  const [maxTokens, setMaxTokens] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ChatResponse['usage'] | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Load all deployments once on mount; refresh button reloads.
  // We don't auto-refresh because changing instance mid-conversation
  // would orphan the history; user should click Refresh deliberately.
  const fetchRows = useCallback(async () => {
    setListLoading(true);
    try {
      const res = await listDeployments();
      setRows(res.instances ?? []);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  // After rows load, resolve the initial selection from URL params
  // (or fall back to first Running). Run only when rows change OR
  // search string changes — not on every render.
  useEffect(() => {
    if (rows.length === 0) return;
    const search = new URLSearchParams(location.search);
    const picked = resolveInitial(rows, search);
    setInstance((prev) => {
      // Don't clobber an already-selected instance unless the URL
      // explicitly pins a different one.
      if (prev && !search.get('cluster')) return prev;
      return picked;
    });
  }, [rows, location.search]);

  // Reset history when the target instance changes. We don't carry
  // conversation across instances — different model would interpret
  // the history differently.
  useEffect(() => {
    setHistory([]);
    setInput('');
    setError(null);
    setUsage(null);
  }, [instance?.cluster_id, instance?.namespace, instance?.name]);

  // Auto-scroll history to bottom when it grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history_, sending]);

  // Group deployments by model for the Select. Pick a per-row
  // status hint (✓ / ⏳ / ✗) so the picker reflects readiness
  // without a separate column.
  const options = useMemo(() => {
    const byModel = new Map<string, ModelInstance[]>();
    for (const r of rows) {
      const key = r.model_display_name;
      const arr = byModel.get(key);
      if (arr) arr.push(r);
      else byModel.set(key, [r]);
    }
    return Array.from(byModel.entries()).map(([label, items]) => ({
      label,
      options: items.map((r) => ({
        label: `${r.cluster_name} · ${r.namespace}/${r.name}`,
        // The select value encodes the (cluster, ns, name) tuple
        // since the API treats this triple as the key.
        value: `${r.cluster_id}|${r.namespace}|${r.name}`,
        disabled: r.status !== 'Running' || r.ready_replicas === 0,
        title:
          r.status !== 'Running'
            ? intl.formatMessage({
                id: 'pages.models.deployments.action.chatDisabled',
              })
            : undefined,
      })),
    }));
  }, [rows, intl]);

  const onSelectInstance = (val: string) => {
    const [cluster_id, namespace, name] = val.split('|');
    const found = rows.find(
      (r) =>
        r.cluster_id === cluster_id &&
        r.namespace === namespace &&
        r.name === name,
    );
    if (found) {
      // Push to URL so the selection is shareable; keep history()
      // (Umi) so the back button works. replace=false because
      // hopping between instances is a navigation event.
      history.push(
        `/models/chat?cluster=${encodeURIComponent(cluster_id)}&ns=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}`,
      );
      setInstance(found);
    }
  };

  const familyColor = useMemo(() => {
    if (
      !instance ||
      !instance.model_family ||
      instance.model_family === 'custom'
    )
      return token.colorPrimary;
    return (
      FAMILY_META[instance.model_family as Exclude<ModelFamily, 'custom'>]
        ?.color || token.colorPrimary
    );
  }, [instance, token.colorPrimary]);

  const send = useCallback(async () => {
    if (!instance) return;
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMsg = {
      role: 'user',
      content: text,
      id: `u-${Date.now()}`,
    };
    const messages: ChatMsg[] = [];
    if (systemPrompt.trim()) {
      messages.push({
        role: 'system',
        content: systemPrompt.trim(),
        id: 'sys',
      });
    }
    messages.push(...history_, userMsg);
    setHistory([...history_, userMsg]);
    setInput('');
    setSending(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        // model_field is what the inference Service was started
        // with (--model <HF id>); sending anything else gets a 404
        // from vLLM. Server resolves the right value per row.
        model: instance.model_field,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        temperature,
      };
      if (maxTokens && maxTokens > 0) body.max_tokens = maxTokens;
      const resp = await chatCompletions<ChatResponse>(
        {
          clusterId: instance.cluster_id,
          namespace: instance.namespace,
          name: instance.name,
        },
        body,
      );
      const reply = extractAssistantText(resp);
      if (!reply) {
        setError(
          intl.formatMessage({ id: 'pages.models.chat.error.emptyReply' }),
        );
      } else {
        setHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: reply,
            id: `a-${Date.now()}`,
          },
        ]);
      }
      setUsage(resp.usage ?? null);
    } catch (e: unknown) {
      const msg =
        e instanceof Error
          ? e.message
          : intl.formatMessage({ id: 'pages.models.chat.error.unknown' });
      setError(msg);
    } finally {
      setSending(false);
    }
  }, [
    instance,
    input,
    history_,
    systemPrompt,
    temperature,
    maxTokens,
    sending,
    intl,
  ]);

  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  // No deployments at all → guide user to deploy first instead of
  // showing an empty playground that does nothing.
  if (!listLoading && rows.length === 0) {
    return (
      <PageContainer
        breadcrumbRender={false}
        header={{
          title: intl.formatMessage({ id: 'pages.models.chat.title' }),
          breadcrumb: undefined,
        }}
      >
        <Result
          status="info"
          title={intl.formatMessage({
            id: 'pages.models.chat.noDeploys.title',
          })}
          subTitle={intl.formatMessage({
            id: 'pages.models.chat.noDeploys.desc',
          })}
          extra={
            <Button
              type="primary"
              onClick={() => history.push('/models/catalog')}
            >
              {intl.formatMessage({ id: 'pages.models.chat.noDeploys.cta' })}
            </Button>
          }
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer
      breadcrumbRender={false}
      header={{
        title: intl.formatMessage({ id: 'pages.models.chat.title' }),
        subTitle: intl.formatMessage({ id: 'pages.models.chat.subtitle' }),
        breadcrumb: undefined,
      }}
    >
      {/* Both panels pinned to the same calc'd viewport height +
         align="stretch" so the left knob Card matches the right
         conversation Card no matter which side has more content.
         Earlier we let the left Card grow with content while the
         right Card was the only one with an explicit height —
         result was visibly misaligned on tall viewports. */}
      <Row
        gutter={[16, 16]}
        align="stretch"
        style={{ height: 'calc(100vh - 200px)' }}
      >
        {/* Left rail — instance picker + inference knobs. */}
        <Col xs={24} lg={8} xl={7} style={{ display: 'flex' }}>
          <Card
            size="small"
            style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
            styles={{
              body: { flex: 1, overflowY: 'auto' },
            }}
            title={intl.formatMessage({ id: 'pages.models.chat.target' })}
            extra={
              <Button
                size="small"
                type="text"
                icon={<ReloadOutlined />}
                loading={listLoading}
                onClick={fetchRows}
              />
            }
          >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Select
                style={{ width: '100%' }}
                placeholder={intl.formatMessage({
                  id: 'pages.models.chat.target.placeholder',
                })}
                loading={listLoading}
                value={
                  instance
                    ? `${instance.cluster_id}|${instance.namespace}|${instance.name}`
                    : undefined
                }
                onChange={onSelectInstance}
                options={options}
                showSearch
                optionFilterProp="label"
              />
              {instance && (
                <Space wrap size={4}>
                  <Tag color={familyColor} style={{ marginRight: 0 }}>
                    {instance.model_display_name}
                  </Tag>
                  <Tag style={{ marginRight: 0 }}>{instance.cluster_name}</Tag>
                  <Tag style={{ marginRight: 0 }}>
                    {instance.namespace}/{instance.name}
                  </Tag>
                </Space>
              )}

              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {intl.formatMessage({ id: 'pages.models.chat.systemPrompt' })}
                </Text>
                <Input.TextArea
                  rows={4}
                  placeholder={intl.formatMessage({
                    id: 'pages.models.chat.systemPrompt.placeholder',
                  })}
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  disabled={sending}
                  style={{ marginTop: 4 }}
                />
              </div>

              <Row gutter={8}>
                <Col span={12}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {intl.formatMessage({
                      id: 'pages.models.chat.temperature',
                    })}
                  </Text>
                  <InputNumber
                    style={{ width: '100%' }}
                    min={0}
                    max={2}
                    step={0.1}
                    value={temperature}
                    onChange={(v) => setTemperature(v ?? 0.7)}
                    disabled={sending}
                  />
                </Col>
                <Col span={12}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {intl.formatMessage({ id: 'pages.models.chat.maxTokens' })}
                  </Text>
                  <InputNumber
                    style={{ width: '100%' }}
                    min={1}
                    max={32768}
                    step={64}
                    value={maxTokens ?? undefined}
                    placeholder={intl.formatMessage({
                      id: 'pages.models.chat.maxTokens.placeholder',
                    })}
                    onChange={(v) => setMaxTokens(v ?? null)}
                    disabled={sending}
                  />
                </Col>
              </Row>

              <Alert
                type="info"
                showIcon
                message={intl.formatMessage({
                  id: 'pages.models.chat.streamNote',
                })}
              />
            </Space>
          </Card>
        </Col>

        {/* Right pane — conversation. Inherits its height from the
           stretched Row (left + right always equal). */}
        <Col xs={24} lg={16} xl={17} style={{ display: 'flex' }}>
          <Card
            size="small"
            style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
            styles={{
              body: {
                padding: 0,
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
              },
            }}
            title={intl.formatMessage({ id: 'pages.models.chat.conversation' })}
            extra={
              <Button
                size="small"
                icon={<ClearOutlined />}
                onClick={() => {
                  setHistory([]);
                  setError(null);
                  setUsage(null);
                }}
                disabled={sending || history_.length === 0}
              >
                {intl.formatMessage({ id: 'pages.models.chat.clear' })}
              </Button>
            }
          >
            <div
              ref={scrollRef}
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '16px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                background: token.colorBgLayout,
                minHeight: 0,
              }}
            >
              {!instance ? (
                <Empty
                  description={intl.formatMessage({
                    id: 'pages.models.chat.pickFirst',
                  })}
                />
              ) : history_.length === 0 && !sending ? (
                <Alert
                  type="info"
                  showIcon
                  message={intl.formatMessage({
                    id: 'pages.models.chat.empty.title',
                  })}
                  description={intl.formatMessage({
                    id: 'pages.models.chat.empty.desc',
                  })}
                />
              ) : null}
              {history_.map((m) => (
                <ChatBubble
                  key={m.id}
                  msg={m}
                  familyColor={familyColor}
                  token={token}
                />
              ))}
              {sending && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <Avatar
                    size={28}
                    style={{ background: familyColor, flexShrink: 0 }}
                  >
                    {instance?.model_display_name.charAt(0).toUpperCase()}
                  </Avatar>
                  <Spin size="small" />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {intl.formatMessage({ id: 'pages.models.chat.thinking' })}
                  </Text>
                </div>
              )}
              {error && (
                <Alert
                  type="error"
                  showIcon
                  message={intl.formatMessage({
                    id: 'pages.models.chat.error.title',
                  })}
                  description={error}
                />
              )}
            </div>
            <div
              style={{
                padding: '8px 20px 16px',
                borderTop: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}
            >
              {usage && (
                <Text
                  type="secondary"
                  style={{
                    fontSize: 11,
                    display: 'block',
                    marginBottom: 6,
                  }}
                >
                  {intl.formatMessage(
                    { id: 'pages.models.chat.usage' },
                    {
                      in: usage.prompt_tokens ?? 0,
                      out: usage.completion_tokens ?? 0,
                      total: usage.total_tokens ?? 0,
                    },
                  )}
                </Text>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <Input.TextArea
                  autoSize={{ minRows: 2, maxRows: 8 }}
                  placeholder={intl.formatMessage({
                    id: 'pages.models.chat.input.placeholder',
                  })}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
                  disabled={sending || !instance}
                />
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  loading={sending}
                  disabled={!input.trim() || !instance}
                  onClick={send}
                  style={{ height: 'auto' }}
                >
                  {intl.formatMessage({ id: 'pages.models.chat.send' })}
                </Button>
              </div>
            </div>
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
};

function ChatBubble({
  msg,
  familyColor,
  token,
}: {
  msg: ChatMsg;
  familyColor: string;
  token: ReturnType<typeof theme.useToken>['token'];
}) {
  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isUser ? 'row-reverse' : 'row',
        gap: 8,
        alignItems: 'flex-start',
      }}
    >
      <Avatar
        size={28}
        icon={isUser ? <UserOutlined /> : undefined}
        style={{
          background: isUser
            ? token.colorPrimary
            : isSystem
              ? token.colorTextSecondary
              : familyColor,
          flexShrink: 0,
        }}
      >
        {!isUser && (isSystem ? 'S' : 'A')}
      </Avatar>
      <Paragraph
        style={{
          margin: 0,
          padding: '8px 12px',
          background: isUser ? token.colorPrimaryBg : token.colorBgContainer,
          borderRadius: token.borderRadiusLG,
          border: `1px solid ${token.colorBorderSecondary}`,
          maxWidth: '78%',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: 13,
          lineHeight: 1.55,
        }}
      >
        {msg.content}
      </Paragraph>
    </div>
  );
}

export default ModelChatPage;
