import { useIntl } from '@umijs/max';
import { DatePicker, Space, Switch, Tooltip, Button } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import React from 'react';

const { RangePicker } = DatePicker;

// TimeRangeValue is the discriminated union surfaced to consumers.
//
//   - preset:   "last X" sliding window. Anchored to now() at every
//               resolveTimeRange call, so polling automatically
//               picks up newly-arrived data. URL stays a stable
//               ?range=<key> so server-side response cache hits.
//   - sinceNow: fixed start, end follows now(). Same sliding-on-poll
//               behavior as preset but lets the user pin an
//               arbitrary start point ("from when I started this
//               incident investigation until now"). URL is a
//               regular ?from=&to= where `to` re-encodes on each
//               request — server can't cache, but the win is
//               "I picked a specific start and it keeps updating".
//   - custom:   both ends fixed. Historical investigation / sharing
//               a snapshot URL. Doesn't slide.
export type TimeRangePreset = '1h' | '24h' | '7d' | '30d';

export type TimeRangeValue =
  | { mode: 'preset'; preset: TimeRangePreset }
  | { mode: 'sinceNow'; from: Date }
  | { mode: 'custom'; from: Date; to: Date };

const PRESET_MS: Record<TimeRangePreset, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// resolveTimeRange returns concrete from/to. For preset and sinceNow,
// the moving end is anchored to `now` at call time so pollers see a
// sliding window without having to mutate the TimeRangeValue itself.
export function resolveTimeRange(v: TimeRangeValue): {
  from: Date;
  to: Date;
} {
  if (v.mode === 'custom') return { from: v.from, to: v.to };
  if (v.mode === 'sinceNow') return { from: v.from, to: new Date() };
  const to = new Date();
  const from = new Date(to.getTime() - PRESET_MS[v.preset]);
  return { from, to };
}

// buildRangeQuery serialises the value into URL query params for the
// backend metrics handlers. Preset → ?range=…; everything else →
// ?from=&to= (RFC3339, both resolved at call time). Server's
// resolveTimeRange in time_range.go knows both forms.
export function buildRangeQuery(v: TimeRangeValue): string {
  if (v.mode === 'preset') return `range=${v.preset}`;
  const { from, to } = resolveTimeRange(v);
  return (
    `from=${encodeURIComponent(from.toISOString())}` +
    `&to=${encodeURIComponent(to.toISOString())}`
  );
}

interface Props {
  value: TimeRangeValue;
  onChange: (v: TimeRangeValue) => void;
  presets?: TimeRangePreset[];
  size?: 'small' | 'middle';
  // maxDays caps how far back the absolute picker allows. Mirrors the
  // server-side maxCustomTimeRange (31 days) so a UI selection
  // exceeding the cap doesn't even reach the request layer.
  maxDays?: number;
}

const DEFAULT_PRESETS: TimeRangePreset[] = ['1h', '24h', '7d', '30d'];

const TimeRangePicker: React.FC<Props> = ({
  value,
  onChange,
  presets = DEFAULT_PRESETS,
  size = 'small',
  maxDays = 31,
}) => {
  const intl = useIntl();

  // RangePicker input shows from/to only for the two "user-picked
  // anchor(s)" modes — preset stays empty so we don't fake a custom
  // selection. For sinceNow mode, both ends are rendered (the to
  // re-resolves to "now" each render, so visually it slides forward).
  //
  // The popover view-date is anchored to "now" via defaultPickerValue
  // (separate from `value`) so opening the calendar lands on today
  // regardless of mode — fixes the "I have to find the current month
  // myself" pain.
  const pickerValue: [Dayjs, Dayjs] | null =
    value.mode === 'custom'
      ? [dayjs(value.from), dayjs(value.to)]
      : value.mode === 'sinceNow'
        ? [dayjs(value.from), dayjs()]
        : null;
  const todayAnchor: [Dayjs, Dayjs] = React.useMemo(() => {
    const now = dayjs();
    return [now, now];
  }, []);

  // "End follows now" toggle — only meaningful when there's a user-
  // picked start (not in preset mode, which already slides by
  // construction). Switching it flips between sinceNow ↔ custom while
  // preserving from. Default for new picks is ON, matching Grafana's
  // default behavior (people usually want the chart to keep updating).
  const endFollowsNow =
    value.mode === 'sinceNow' || value.mode === 'preset';
  const handleToggleFollowsNow = (next: boolean) => {
    if (value.mode === 'sinceNow' && !next) {
      // Convert to absolute custom — freeze `to` at the current
      // moment so the displayed end doesn't jump.
      onChange({ mode: 'custom', from: value.from, to: new Date() });
    } else if (value.mode === 'custom' && next) {
      // Convert to sinceNow — drop the user's `to` (was just a
      // freeze-point anyway).
      onChange({ mode: 'sinceNow', from: value.from });
    }
    // preset mode: do nothing — preset itself slides; toggling has
    // no semantic meaning. Switch is disabled in that case.
  };

  // antd RangePicker.presets — shows a sidebar of one-click ranges
  // in the popover. Grafana-style quick choices; more granular than
  // the headline preset buttons (which stay focused on the polling-
  // friendly anchors 1h/24h/7d/30d).
  const popoverPresets: NonNullable<
    React.ComponentProps<typeof RangePicker>['presets']
  > = React.useMemo(() => {
    const now = dayjs();
    return [
      {
        label: intl.formatMessage({
          id: 'components.timeRangePicker.preset.last5m',
          defaultMessage: '近 5 分钟',
        }),
        value: [now.subtract(5, 'minute'), now],
      },
      {
        label: intl.formatMessage({
          id: 'components.timeRangePicker.preset.last15m',
          defaultMessage: '近 15 分钟',
        }),
        value: [now.subtract(15, 'minute'), now],
      },
      {
        label: intl.formatMessage({
          id: 'components.timeRangePicker.preset.last1h',
          defaultMessage: '近 1 小时',
        }),
        value: [now.subtract(1, 'hour'), now],
      },
      {
        label: intl.formatMessage({
          id: 'components.timeRangePicker.preset.last6h',
          defaultMessage: '近 6 小时',
        }),
        value: [now.subtract(6, 'hour'), now],
      },
      {
        label: intl.formatMessage({
          id: 'components.timeRangePicker.preset.last24h',
          defaultMessage: '近 24 小时',
        }),
        value: [now.subtract(24, 'hour'), now],
      },
      {
        label: intl.formatMessage({
          id: 'components.timeRangePicker.preset.today',
          defaultMessage: '今天',
        }),
        value: [now.startOf('day'), now],
      },
      {
        label: intl.formatMessage({
          id: 'components.timeRangePicker.preset.yesterday',
          defaultMessage: '昨天',
        }),
        value: [
          now.subtract(1, 'day').startOf('day'),
          now.subtract(1, 'day').endOf('day'),
        ],
      },
      {
        label: intl.formatMessage({
          id: 'components.timeRangePicker.preset.last7d',
          defaultMessage: '近 7 天',
        }),
        value: [now.subtract(7, 'day'), now],
      },
      {
        label: intl.formatMessage({
          id: 'components.timeRangePicker.preset.last30d',
          defaultMessage: '近 30 天',
        }),
        value: [now.subtract(30, 'day'), now],
      },
    ];
  }, [intl, value]); // re-eval when value changes so "now" is fresh on each open

  return (
    <Space size={6} wrap>
      {presets.map((p) => (
        <Button
          key={p}
          size={size}
          type={
            value.mode === 'preset' && value.preset === p
              ? 'primary'
              : 'default'
          }
          onClick={() => onChange({ mode: 'preset', preset: p })}
        >
          {p}
        </Button>
      ))}
      <RangePicker
        size={size}
        showTime
        // allowClear={false} hides the X button. Without this, clicking X
        // on a custom range fires onChange(null) — we ignore it, but the
        // controlled `value` prop re-renders the old range next frame,
        // making the picker feel broken. Users switch modes by clicking
        // a preset button instead.
        allowClear={false}
        value={pickerValue}
        defaultPickerValue={todayAnchor}
        presets={popoverPresets}
        // Disable future dates and anything older than maxDays — the
        // server rejects > 31 days anyway, but blocking it here gives
        // the user a clearer signal than a 400.
        disabledDate={(d) => {
          if (!d) return false;
          const now = dayjs();
          if (d.isAfter(now)) return true;
          return d.isBefore(now.subtract(maxDays, 'day'));
        }}
        onChange={(range) => {
          if (range && range[0] && range[1]) {
            // Honor the current "end follows now" toggle when the
            // user picks via the calendar/presets:
            //   - On (default): keep sliding — drop the picked to,
            //     rebuild as sinceNow with picked from.
            //   - Off: freeze both ends as absolute custom.
            // Popover presets like "近 1 小时" therefore stay
            // sliding by default, matching their wording.
            if (endFollowsNow) {
              onChange({
                mode: 'sinceNow',
                from: range[0].toDate(),
              });
            } else {
              onChange({
                mode: 'custom',
                from: range[0].toDate(),
                to: range[1].toDate(),
              });
            }
          }
        }}
        placeholder={[
          intl.formatMessage({
            id: 'components.timeRangePicker.from',
            defaultMessage: '起始时间',
          }),
          intl.formatMessage({
            id: 'components.timeRangePicker.to',
            defaultMessage: '结束时间',
          }),
        ]}
      />
      <Tooltip
        title={intl.formatMessage({
          id: 'components.timeRangePicker.endFollowsNow.tooltip',
          defaultMessage:
            '开启时，结束时间始终为"现在"，窗口随轮询持续向前滑动；关闭时，两端都是绝对时间，画面冻结。预设模式（1h/24h…）本身就是滑动，开关无效。',
        })}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Switch
            size="small"
            checked={endFollowsNow}
            disabled={value.mode === 'preset'}
            onChange={handleToggleFollowsNow}
          />
          <span style={{ fontSize: 13, userSelect: 'none' }}>
            {intl.formatMessage({
              id: 'components.timeRangePicker.endFollowsNow',
              defaultMessage: '结束=现在',
            })}
          </span>
        </span>
      </Tooltip>
    </Space>
  );
};

export default TimeRangePicker;
