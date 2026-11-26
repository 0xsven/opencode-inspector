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
      from, to, metric: 'tokens',
      activity: [{
        date: '2024-11-19', activeSessions: 1, steps: 1, newSessions: 1, subagentSessions: 0,
        tokens: { input: total, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total },
      }],
    });
    assert.deepEqual([...html.matchAll(/class="usage-activity-tick[^"]*"[^>]*><span>([^<]*)<\/span>/g)].map(match => match[1]), expected);
  }
});
