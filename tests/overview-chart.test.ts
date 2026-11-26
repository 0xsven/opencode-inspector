import assert from 'node:assert/strict';
import test from 'node:test';
import type { OverviewChart as OverviewChartComponent } from '../src/UsageCharts';
import { loadComponents, renderComponent } from './solid-render';

test('Overview Activity uses a zero baseline and distinct round ticks for empty, small and large counts', async () => {
  const { OverviewChart } = await loadComponents<{ OverviewChart: typeof OverviewChartComponent }>('/src/UsageCharts.tsx');
  const from = +new Date(2024, 10, 19);
  const to = +new Date(2024, 10, 21);
  for (const [total, expected] of [
    [0, ['0', '1']],
    [2, ['0', '1', '2']],
    [230_000_000, ['0', '100M', '200M', '300M']],
  ] as const) {
    const html = renderComponent(OverviewChart, {
      from, to, metric: 'tokens', view: 'timeline', active: true, onViewChange: () => {},
      activity: [{
        date: '2024-11-19', activeSessions: 1, steps: 1, newSessions: 1, subagentSessions: 0,
        tokens: { input: total, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total },
      }],
    });
    assert.deepEqual([...html.matchAll(/class="usage-activity-tick[^"]*"[^>]*><span>([^<]*)<\/span>/g)].map(match => match[1]), expected);
  }
});

test('Overview hour-of-day draws every ordered hour and distinguishes old responses from zero counts', async () => {
  const { OverviewChart } = await loadComponents<{ OverviewChart: typeof OverviewChartComponent }>('/src/UsageCharts.tsx');
  const options = {
    from: +new Date(2024, 10, 19), to: +new Date(2024, 10, 21), metric: 'steps', view: 'hourOfDay',
    active: true, onViewChange: () => {}, activity: [],
  } as const;
  const activityByHour = Array.from({ length: 24 }, (_, hour) => ({
    hour, steps: hour === 23 ? 2 : 0,
    tokens: { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 100 },
  }));
  const html = renderComponent(OverviewChart, { ...options, activityByHour });
  assert.deepEqual([...html.matchAll(/data-chart-bucket="hour-(\d+)"/g)].map(match => Number(match[1])), activityByHour.map(row => row.hour));
  assert.deepEqual([...html.matchAll(/class="usage-activity-tick[^"]*"[^>]*><span>([^<]*)<\/span>/g)].map(match => match[1]), ['0', '1', '2']);
  assert.match(html, /Counts combined across selected days/);
  const legacy = renderComponent(OverviewChart, options);
  assert.match(legacy, /Restart Inspector to see activity by hour of day/);
  assert.doesNotMatch(legacy, /No recorded activity|data-chart-bucket/);
});
