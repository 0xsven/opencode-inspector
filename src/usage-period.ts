import type { UsageGranularity } from './usage-types';

export const usageDatePresets = [
  ['day', '1 day'], ['week', '1 week'], ['month', '1 month'], ['quarter', '3 months'],
  ['half', '6 months'], ['year', '1 year'], ['all', 'All'],
] as const;
type Preset = typeof usageDatePresets[number][0];
export type UsageDateSelection = Preset | { from: string; to: string };

const dayMs = 86_400_000;
export const localDateInput = (date: Date) => [
  String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
].join('-');
export const parseLocalDate = (date: string) => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day);
};
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
function subtractMonths(date: Date, months: number) {
  const start = new Date(date.getFullYear(), date.getMonth() - months, 1);
  const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  start.setDate(Math.min(date.getDate(), lastDay));
  return start;
}

export function usageRange(date: Date, selection: UsageDateSelection): { from: number; to: number; granularity: UsageGranularity } {
  const today = addDays(date, 0);
  const tomorrow = addDays(today, 1);
  if (selection === 'all') return { from: 0, to: +tomorrow, granularity: 'month' };
  const to = typeof selection === 'string' ? tomorrow : addDays(parseLocalDate(selection.to), 1);
  const from = typeof selection === 'object' ? parseLocalDate(selection.from)
    : selection === 'day' ? today
    : selection === 'week' ? addDays(today, -6)
    : subtractMonths(tomorrow, { month: 1, quarter: 3, half: 6, year: 12 }[selection]);
  const duration = +to - +from;
  const singleDay = typeof selection === 'object' ? selection.from === selection.to : selection === 'day';
  const granularity = singleDay && duration <= 26 * 3_600_000 ? 'hour' : duration <= 32 * dayMs ? 'day' : duration <= 100 * dayMs ? 'week' : 'month';
  return { from: +from, to: +to, granularity };
}

export function usageRequestUrl(params: URLSearchParams, intent: number, consumed: { current: number }) {
  const request = new URLSearchParams(params);
  if (intent > consumed.current) {
    consumed.current = intent;
    request.set('refresh', '1');
  }
  return `/api/usage?${request}`;
}
