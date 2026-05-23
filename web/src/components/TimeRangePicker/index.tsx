import { useIntl } from '@umijs/max';
import { DatePicker, Space, Button } from 'antd';
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
  // selection. For sinceNow mode, the to half is bound to "now" so
  // it visually slides forward each render; the format function
  // (see below) renders it as the text "现在" rather than a frozen
  // timestamp.
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

  const nowLabel = intl.formatMessage({
    id: 'components.timeRangePicker.now',
    defaultMessage: '现在',
  });
  // antd RangePicker accepts a 2-tuple format — first applies to
  // from, second to to. For sinceNow mode we render "现在" in the
  // to slot regardless of the underlying Dayjs value (which slides
  // to now each render); for custom and preset we use the regular
  // date-time format.
  const dtFormat = 'YYYY-MM-DD HH:mm:ss';
  const formatProp =
    value.mode === 'sinceNow'
      ? [dtFormat, () => nowLabel]
      : dtFormat;

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
        format={formatProp as any}
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
            // Auto-detect sinceNow vs frozen custom by how close the
            // picked `to` is to the live "now". Popover presets like
            // "近 1 小时" set to=now() exactly → mode=sinceNow → the
            // to input renders as "现在" and the window slides on
            // every poll. A manual calendar pick of a historical end
            // (e.g., "yesterday 9-10am") has to in the past →
            // mode=custom → both ends frozen as the user intended.
            //
            // 60s window absorbs popover-preset clock skew (the
            // preset was computed when popover opened, range commits
            // a tick later) without misclassifying a deliberate
            // recent pick.
            const fromDate = range[0].toDate();
            const toDate = range[1].toDate();
            const now = Date.now();
            const slidesNow = Math.abs(toDate.getTime() - now) < 60_000;
            if (slidesNow) {
              onChange({ mode: 'sinceNow', from: fromDate });
            } else {
              onChange({ mode: 'custom', from: fromDate, to: toDate });
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
    </Space>
  );
};

export default TimeRangePicker;
