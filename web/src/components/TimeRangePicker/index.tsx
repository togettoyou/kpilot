import { ReloadOutlined } from '@ant-design/icons';
import { useIntl } from '@umijs/max';
import { Button, DatePicker, Space, Tooltip } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import React from 'react';

const { RangePicker } = DatePicker;

// TimeRangeValue is the discriminated union surfaced to consumers.
// Preset mode keeps the URL stable across renders (server caches by
// the preset key, so polling stays cheap); custom mode carries absolute
// from/to anchors the user picked.
export type TimeRangePreset = '1h' | '24h' | '7d' | '30d';

export type TimeRangeValue =
  | { mode: 'preset'; preset: TimeRangePreset }
  | { mode: 'custom'; from: Date; to: Date };

const PRESET_MS: Record<TimeRangePreset, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// resolveTimeRange returns concrete from/to. For preset, anchored to
// `now` at call time so pollers always see a sliding window.
export function resolveTimeRange(v: TimeRangeValue): {
  from: Date;
  to: Date;
} {
  if (v.mode === 'custom') return { from: v.from, to: v.to };
  const to = new Date();
  const from = new Date(to.getTime() - PRESET_MS[v.preset]);
  return { from, to };
}

// buildRangeQuery serialises the value into URL query params for the
// backend metrics handlers. Preset → ?range=…; custom → ?from=&to=
// (RFC3339). Server's resolveTimeRange in time_range.go knows both
// forms.
export function buildRangeQuery(v: TimeRangeValue): string {
  if (v.mode === 'preset') return `range=${v.preset}`;
  return (
    `from=${encodeURIComponent(v.from.toISOString())}` +
    `&to=${encodeURIComponent(v.to.toISOString())}`
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

  // Always show the live effective range — even in preset mode the
  // picker reflects "now - 1h → now" so clicking the picker opens
  // on today's date instead of an empty calendar anchored to epoch.
  // The user can then tweak from a known anchor (the most common
  // gesture: "this same window but ending 10 min earlier").
  const resolved = React.useMemo(() => resolveTimeRange(value), [value]);
  const pickerValue: [Dayjs, Dayjs] = [
    dayjs(resolved.from),
    dayjs(resolved.to),
  ];

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

  // "Snap end to now" — only meaningful in custom mode. Re-anchors
  // the right edge to now() while keeping the window width, so the
  // user can slide the view forward without re-picking dates.
  const handleSnapToNow = () => {
    if (value.mode !== 'custom') return;
    const span = value.to.getTime() - value.from.getTime();
    const to = new Date();
    const from = new Date(to.getTime() - span);
    onChange({ mode: 'custom', from, to });
  };

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
            onChange({
              mode: 'custom',
              from: range[0].toDate(),
              to: range[1].toDate(),
            });
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
      {value.mode === 'custom' && (
        <Tooltip
          title={intl.formatMessage({
            id: 'components.timeRangePicker.snapToNow.tooltip',
            defaultMessage: '把窗口右端贴到当前时间（保持窗口长度）',
          })}
        >
          <Button
            size={size}
            icon={<ReloadOutlined />}
            onClick={handleSnapToNow}
          >
            {intl.formatMessage({
              id: 'components.timeRangePicker.snapToNow',
              defaultMessage: '贴到现在',
            })}
          </Button>
        </Tooltip>
      )}
    </Space>
  );
};

export default TimeRangePicker;
