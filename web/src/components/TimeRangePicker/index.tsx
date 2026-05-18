import { useIntl } from '@umijs/max';
import { Button, DatePicker, Space } from 'antd';
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

  // Custom-mode RangePicker shows the actual from/to; preset mode shows
  // empty (the picker is a separate "set custom" gesture).
  const pickerValue: [Dayjs, Dayjs] | null =
    value.mode === 'custom' ? [dayjs(value.from), dayjs(value.to)] : null;

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
    </Space>
  );
};

export default TimeRangePicker;
