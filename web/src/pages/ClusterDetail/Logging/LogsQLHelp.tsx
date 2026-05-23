import { QuestionCircleOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import { Button, Popover, Space, Typography } from 'antd';
import React from 'react';

// LogsQL examples extracted from the upstream tutorial
// (https://docs.victoriametrics.com/victorialogs/logsql/). Grouped
// by category — exactly the snippets a SRE writing a week-1 query
// reaches for. Operators paste an example into the search box and
// tweak it; we don't try to teach the whole language.
const EXAMPLES: { groupKey: string; items: { ql: string; descKey: string }[] }[] =
  [
    {
      groupKey: 'pages.logging.help.group.text',
      items: [
        { ql: 'error', descKey: 'pages.logging.help.ex.text.word' },
        { ql: '"connection timeout"', descKey: 'pages.logging.help.ex.text.phrase' },
        { ql: 'err*', descKey: 'pages.logging.help.ex.text.prefix' },
        { ql: '*timeout*', descKey: 'pages.logging.help.ex.text.substring' },
      ],
    },
    {
      groupKey: 'pages.logging.help.group.stream',
      items: [
        {
          ql: '{kubernetes.pod_namespace="default"}',
          descKey: 'pages.logging.help.ex.stream.ns',
        },
        {
          ql: '{kubernetes.pod_namespace="default", kubernetes.pod_name="nginx-abc"}',
          descKey: 'pages.logging.help.ex.stream.nsPod',
        },
        {
          ql: '{kubernetes.pod_name=~"nginx-.+"}',
          descKey: 'pages.logging.help.ex.stream.regex',
        },
      ],
    },
    {
      groupKey: 'pages.logging.help.group.field',
      items: [
        { ql: 'level:error', descKey: 'pages.logging.help.ex.field.eq' },
        { ql: 'level:!debug', descKey: 'pages.logging.help.ex.field.neq' },
        {
          ql: 'status:in(500,502,503)',
          descKey: 'pages.logging.help.ex.field.in',
        },
        { ql: 'status:>=500', descKey: 'pages.logging.help.ex.field.cmp' },
        { ql: 'trace_id:*', descKey: 'pages.logging.help.ex.field.exists' },
      ],
    },
    {
      groupKey: 'pages.logging.help.group.logic',
      items: [
        {
          ql: 'level:error AND status:>=500',
          descKey: 'pages.logging.help.ex.logic.and',
        },
        {
          ql: '(timeout OR refused) AND NOT "healthcheck"',
          descKey: 'pages.logging.help.ex.logic.orNot',
        },
      ],
    },
    {
      groupKey: 'pages.logging.help.group.pipes',
      items: [
        {
          ql: 'error | stats count() as n',
          descKey: 'pages.logging.help.ex.pipes.stats',
        },
        {
          ql: 'error | sort by (_time) desc | limit 100',
          descKey: 'pages.logging.help.ex.pipes.sort',
        },
        {
          ql: 'error | fields _time, level, _msg',
          descKey: 'pages.logging.help.ex.pipes.fields',
        },
      ],
    },
  ];

interface Props {
  // Caller decides what to do with the snippet — typically replace
  // (or append into) the query input.
  onInsert: (snippet: string) => void;
}

// LogsQLHelp — small ? icon button that opens a Popover with copy-
// pasteable LogsQL snippets. Each row is clickable: click → onInsert
// fires with the snippet text, the popover closes. There's also a
// link out to the upstream docs for the long tail of operators.
const LogsQLHelp: React.FC<Props> = ({ onInsert }) => {
  const intl = useIntl();
  const [open, setOpen] = React.useState(false);
  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottomRight"
      // Cap the width and let the body scroll; some categories have
      // long phrase examples that would otherwise stretch the popover
      // halfway across the viewport.
      overlayStyle={{ maxWidth: 560 }}
      title={
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Text strong>
            {intl.formatMessage({ id: 'pages.logging.help.title' })}
          </Typography.Text>
          <Typography.Link
            href="https://docs.victoriametrics.com/victorialogs/logsql/"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12 }}
          >
            {intl.formatMessage({ id: 'pages.logging.help.docsLink' })}
          </Typography.Link>
        </Space>
      }
      content={
        <div
          style={{
            maxHeight: 420,
            overflowY: 'auto',
            paddingRight: 8,
            minWidth: 360,
          }}
        >
          {EXAMPLES.map((group) => (
            <div key={group.groupKey} style={{ marginBottom: 12 }}>
              <Typography.Text
                strong
                style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}
              >
                {intl.formatMessage({ id: group.groupKey })}
              </Typography.Text>
              {group.items.map((it) => (
                <ExampleRow
                  key={it.ql}
                  ql={it.ql}
                  desc={intl.formatMessage({ id: it.descKey })}
                  onInsert={(s) => {
                    onInsert(s);
                    setOpen(false);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      }
    >
      <Button
        size="small"
        type="text"
        icon={<QuestionCircleOutlined />}
        title={intl.formatMessage({ id: 'pages.logging.help.tooltip' })}
      />
    </Popover>
  );
};

const ExampleRow: React.FC<{
  ql: string;
  desc: string;
  onInsert: (s: string) => void;
}> = ({ ql, desc, onInsert }) => (
  <div
    role="button"
    tabIndex={0}
    onClick={() => onInsert(ql)}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onInsert(ql);
      }
    }}
    style={{
      cursor: 'pointer',
      padding: '6px 8px',
      borderRadius: 4,
      marginTop: 4,
    }}
    className="kpilot-logs-help-row"
  >
    <div
      style={{
        fontFamily:
          'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: 12,
        background: 'var(--ant-color-fill-quaternary)',
        padding: '2px 6px',
        borderRadius: 3,
        wordBreak: 'break-all',
      }}
    >
      {ql}
    </div>
    <div
      style={{
        fontSize: 11,
        color: 'var(--ant-color-text-secondary)',
        marginTop: 2,
      }}
    >
      {desc}
    </div>
  </div>
);

export default LogsQLHelp;
