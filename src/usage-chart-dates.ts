import type { UsageGranularity } from './usage-types';

const hour = 3_600_000;
const hourClock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hourOffset = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
const hourDetail = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
const weekStart = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const shortMonth = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const longMonth = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export const usageBucketAxis = { hour: 'Hour', day: 'Date', week: 'Week starting Monday', month: 'Month' };
export const usageBucketFrequency = { hour: 'Hourly', day: 'Daily', week: 'Weekly', month: 'Monthly' };

export function usageHourOfDayLabels(locale?: string, hourCycle?: 'h12' | 'h23') {
  const options = { hourCycle, timeZone: 'UTC' } as const;
  const axis = new Intl.DateTimeFormat(locale, { ...options, hour: 'numeric' });
  const detail = new Intl.DateTimeFormat(locale, { ...options, hour: 'numeric', minute: '2-digit' });
  // Hours are already local wall-clock values. UTC is only their display carrier.
  return Array.from({ length: 24 }, (_, hour) => {
    const instant = Date.UTC(2000, 0, 1, hour);
    return { dateTime: `${String(hour).padStart(2, '0')}:00`, label: axis.format(instant), heading: detail.format(instant) };
  });
}

function calendarDate(timestamp: number) {
  const local = new Date(timestamp);
  // Encode the browser's civil date in UTC for calendar arithmetic across DST.
  const civil = new Date(0);
  civil.setUTCFullYear(local.getFullYear(), local.getMonth(), local.getDate());
  return civil;
}

export function usageChartBuckets(from: number, to: number, granularity: UsageGranularity, now = Date.now()) {
  const observedThrough = Math.min(to - 1, now);
  const buckets: Array<{ id: string; heading: string; label: string }> = [];
  const labelGap = granularity === 'week' ? 90 : granularity === 'month' ? 72 : 52;
  if (from > observedThrough) return { buckets, labelGap };
  if (granularity === 'hour') {
    // The API anchors elapsed-hour buckets to the query start, not to UTC midnight.
    const instants: Date[] = [];
    for (let time = from; time <= observedThrough; time += hour) instants.push(new Date(time));
    const labels = instants.map(date => hourClock.format(date));
    const seen = new Set<string>(), repeated = new Set<string>();
    for (const label of labels) {
      if (seen.has(label)) repeated.add(label);
      else seen.add(label);
    }
    return {
      buckets: instants.map((date, i) => ({
        id: date.toISOString(),
        heading: hourDetail.format(date),
        label: repeated.has(labels[i]) ? hourOffset.format(date) : labels[i],
      })),
      labelGap: repeated.size ? 96 : labelGap,
    };
  }

  const cursor = calendarDate(from);
  const end = calendarDate(observedThrough);
  if (granularity === 'week') cursor.setUTCDate(cursor.getUTCDate() - (cursor.getUTCDay() + 6) % 7);
  else if (granularity === 'month') cursor.setUTCDate(1);
  while (cursor <= end) {
    const id = cursor.toISOString().split('T')[0];
    if (granularity === 'month') {
      buckets.push({ id, label: shortMonth.format(cursor), heading: longMonth.format(cursor) });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    } else if (granularity === 'week') {
      const label = weekStart.format(cursor);
      buckets.push({ id, label, heading: `Week of ${label}` });
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    } else {
      buckets.push({ id, label: id.slice(5), heading: id });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return { buckets, labelGap };
}
