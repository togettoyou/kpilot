import { ClearOutlined, SendOutlined, UserOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import {
  Alert,
  Avatar,
  Button,
  Drawer,
  Input,
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

import type { Model, ModelInstance } from '@/services/kpilot/model';
import { chatCompletions, FAMILY_META } from '@/services/kpilot/model';

const { Text, Paragraph } = Typography;

// ChatDrawer — minimal OpenAI-compatible chat REPL targeting one
// inference Service. Always stream:false for P16-B (the backend
// HTTP proxy buffers end-to-end; live token streaming wakes up in
// P16-C with an SSE pass-through path). On a typical short chat
// turn the buffered turnaround is a few seconds, which is fine
// for "调试" (debug) workflow.
//
// Conversation state lives only in component state — refresh the
// drawer to start a new thread. There's no server-side history;
// we send the full message array each turn so model context spans
// the whole drawer session.

interface Props {
  open: boolean;
  model: Model | null;
  instance: ModelInstance | null;
  onClose: () => void;
}

type ChatRole = 'user' | 'assistant' | 'system';
interface ChatMsg {
  role: ChatRole;
  content: string;
  // local-only ID for stable list keys; not sent upstream
  id: string;
}

// vLLM / SGLang / TGI all accept `model` in the request body. The
// inference Service answers regardless of what value we pass (it
// only hosts one model), but Some runtimes echo it back in the
// response so picking a recognizable name keeps logs readable.
function modelFieldFor(model: Model): string {
  return model.hugging_face_id || model.name;
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

// extractAssistantText pulls the reply out of an OpenAI-compat
// response shape. choices[0].message.content covers vLLM /
// SGLang / TGI's chat endpoint; choices[0].text covers the
// legacy /v1/completions shape if a runtime returns it for
// /chat/completions (we still send to /chat/completions).
function extractAssistantText(resp: ChatResponse): string {
  const c = resp.choices?.[0];
  if (!c) return '';
  return c.message?.content || c.text || '';
}

const ChatDrawer: React.FC<Props> = ({ open, model, instance, onClose }) => {
  const intl = useIntl();
  const { token } = theme.useToken();

  const [history, setHistory] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ChatResponse['usage'] | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Reset when drawer (re)opens with a fresh instance so a stale
  // thread from the previous deployment doesn't appear.
  useEffect(() => {
    if (open) {
      setHistory([]);
      setInput('');
      setError(null);
      setUsage(null);
    }
  }, [open, instance?.cluster_id, instance?.namespace, instance?.name]);

  // Auto-scroll to the bottom whenever history grows. Match the
  // chat-UX convention so the latest assistant turn is always
  // visible without manual scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history, sending]);

  const familyColor = useMemo(() => {
    if (!model || model.family === 'custom') return token.colorPrimary;
    return (
      FAMILY_META[model.family as Exclude<typeof model.family, 'custom'>]
        ?.color || token.colorPrimary
    );
  }, [model, token.colorPrimary]);

  const send = useCallback(async () => {
    if (!model || !instance) return;
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMsg = {
      role: 'user',
      content: text,
      id: `u-${Date.now()}`,
    };
    const nextHistory = [...history, userMsg];
    setHistory(nextHistory);
    setInput('');
    setSending(true);
    setError(null);

    try {
      const body = {
        model: modelFieldFor(model),
        messages: nextHistory.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: false,
      };
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
        setHistory([
          ...nextHistory,
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
  }, [model, instance, input, history, sending, intl]);

  const onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    // Enter sends; Shift+Enter inserts newline. Standard chat UX.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const targetLabel = instance
    ? `${instance.cluster_name} · ${instance.namespace}/${instance.name}`
    : '';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        <Space size={8}>
          <span>{intl.formatMessage({ id: 'pages.models.chat.title' })}</span>
          {model && (
            <Text type="secondary" style={{ fontSize: 13 }}>
              {model.display_name}
            </Text>
          )}
          <Tag color="default" style={{ marginRight: 0 }}>
            {targetLabel}
          </Tag>
        </Space>
      }
      size="large"
      maskClosable={false}
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column' },
      }}
      extra={
        <Button
          icon={<ClearOutlined />}
          onClick={() => {
            setHistory([]);
            setError(null);
            setUsage(null);
          }}
          disabled={sending || history.length === 0}
        >
          {intl.formatMessage({ id: 'pages.models.chat.clear' })}
        </Button>
      }
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        {/* Message scroll area */}
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
          }}
        >
          {history.length === 0 && !sending && (
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
          )}
          {history.map((m) => (
            <ChatBubble
              key={m.id}
              msg={m}
              familyColor={familyColor}
              token={token}
            />
          ))}
          {sending && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Avatar
                size={28}
                style={{ background: familyColor, flexShrink: 0 }}
              >
                {model?.display_name.charAt(0).toUpperCase()}
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

        {/* Footer — usage + input */}
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
              style={{ fontSize: 11, display: 'block', marginBottom: 6 }}
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
          <Text
            type="secondary"
            style={{ fontSize: 11, display: 'block', marginTop: 4 }}
          >
            {intl.formatMessage({ id: 'pages.models.chat.streamNote' })}
          </Text>
        </div>
      </div>
    </Drawer>
  );
};

// ChatBubble is a single message line. User messages right-align on
// the primary color, assistant left-align with a family-tinted
// avatar. content rendered in a Paragraph with preserved whitespace
// so Markdown code fences (the most common reply shape) keep their
// line breaks even without a Markdown renderer.
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
          background: isUser ? token.colorPrimary : familyColor,
          flexShrink: 0,
        }}
      >
        {!isUser && (msg.role === 'assistant' ? 'A' : 'S')}
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

export default ChatDrawer;
