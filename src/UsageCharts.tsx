import { createMemo, createSignal, Index, mergeProps, Show } from 'solid-js';
import { ChartInspection, ChartLegend, chartNumber as number, chartTargetKey, useChartInspection, usePlotWidth, type ChartDatum, type InspectionState } from './ChartInspection';
import { usageBucketAxis, usageBucketFrequency, usageChartBuckets } from './usage-chart-dates';
import { localDateInput } from './usage-period';
import type { UsageCounts, UsageGranularity, UsageTokens } from './usage-types';

export { ChartInspection, useChartInspection, usePlotWidth } from './ChartInspection';

export type UsageMeasure = 'tokens' | 'steps';

const parts = [
  { label: 'Input', key: 'input', color: '#80b9c2' },
  { label: 'Output', key: 'output', color: '#d49a65' },
  { label: 'Reasoning', key: 'reasoning', color: '#ad91c7' },
  { label: 'Cache read', key: 'cacheRead', color: '#8eae78' },
  { label: 'Cache write', key: 'cacheWrite', color: '#d17f84' },
] as const;
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const rankingLimit = 8;
const tokenEntries = (tokens?: UsageTokens, items: readonly { label: string; key: typeof parts[number]['key']; color: string }[] = parts) =>
  items.map(({ label, key, color }) => ({ label, color, value: tokens?.[key] ?? 0 }));
const stepEntries = (value: number) => [{ label: 'Assistant steps', color: parts[0].color, value }];

function BreakdownBar(props: { datum: ChartDatum; max: number; state: InspectionState }) {
  return <div class="usage-chart-bar" aria-hidden="true">
    <Index each={props.datum.entries}>{(entry, i) => <Show when={entry().value > 0}>
      <span data-chart-key={i} class="usage-token-segment" classList={{ 'is-hovered': props.state.isSegment(props.datum.id, String(i)) }}
        style={{ 'background-color': entry().color, '--token-size': `${entry().value / props.max * 100}%` }}/>
    </Show>}</Index>
  </div>;
}

function inspectDatum(id: () => string, state: InspectionState) {
  return {
    get 'data-chart-bucket'() { return id(); },
    get 'data-active'() { return state.isActive(id()); },
    onPointerMove: (event: PointerEvent) => { if (event.pointerType === 'mouse') state.preview(id(), chartTargetKey(event.target)); },
    onClick: (event: MouseEvent) => state.select(id(), chartTargetKey(event.target)),
  };
}

function activityScale(peak: number) {
  // Aim for at most three intervals, using rounded whole-count steps.
  const target = Math.max(1, peak / 3);
  const power = 10 ** Math.floor(Math.log10(target));
  const multiple = [1, 2, 2.5, 5, 10].find(n => n * power >= target) ?? 10;
  const step = Math.ceil(multiple * power);
  const intervals = Math.max(1, Math.ceil(peak / step));
  return { ceiling: intervals * step, ticks: Array.from({ length: intervals + 1 }, (_, i) => i * step) };
}

export function OverviewChart(input: {
  activity: Array<UsageCounts & { date: string }>; from: number; to: number; metric: UsageMeasure; granularity?: UsageGranularity;
}) {
  const props = mergeProps({ granularity: 'day' } as const, input);
  const [hiddenParts, setHiddenParts] = createSignal<readonly typeof parts[number]['key'][]>([]);
  const togglePart = (key: typeof parts[number]['key']) => setHiddenParts(current =>
    current.includes(key) ? current.filter(hidden => hidden !== key) : [...current, key]);
  const displayedParts = createMemo(() => parts.filter(part => !hiddenParts().includes(part.key)));
  const measure = () => props.metric === 'steps' ? 'assistant steps' : hiddenParts().length ? 'visible tokens' : 'tokens';
  // The API still returns daily overview counts for hourly ranges.
  const frequency = createMemo(() => props.granularity === 'hour' ? 'day' : props.granularity);
  const buckets = createMemo(() => {
    // A refresh can extend the observed portion of a range ending in the future.
    void props.activity;
    const now = Date.now();
    const today = frequency() === 'day' && props.from <= now && now < props.to ? localDateInput(new Date(now)) : undefined;
    const { buckets, labelGap } = usageChartBuckets(props.from, props.to, frequency(), now);
    return buckets.map(bucket => {
      if (frequency() === 'month') return { ...bucket, labelGap };
      const date = new Date(bucket.id);
      if (bucket.id === today) return { ...bucket, heading: `Today so far · ${fullDate.format(date)}`, label: 'Today so far', labelGap: 76 };
      return {
        ...bucket,
        heading: frequency() === 'day' ? fullDate.format(date) : bucket.heading,
        label: shortDate.format(date),
        labelGap: 52,
      };
    });
  });
  const data = createMemo(() => {
    const byDate = new Map(props.activity.map(day => [day.date, day]));
    return buckets().map(({ id, heading, label, labelGap }) => {
      const day = byDate.get(id);
      const entries = props.metric === 'steps' ? stepEntries(day?.steps ?? 0) : tokenEntries(day?.tokens, displayedParts());
      return { id, heading, label, labelGap, entries, total: entries.reduce((total, entry) => total + entry.value, 0) };
    });
  });
  const scale = createMemo(() => activityScale(data().reduce((peak, day) => Math.max(peak, day.total), 0)));
  const state = useChartInspection(() => [props.activity, props.from, props.to, frequency(), props.metric, hiddenParts()]);
  const plot = usePlotWidth();
  const labelOffsets = createMemo(() => {
    const offsets = new Map<number, number>();
    const width = plot.width(), days = data(), bin = width / days.length;
    // Keep the latest date (or Today so far) visible, then fit older labels.
    let next = width;
    for (let i = days.length - 1; i >= 0; i--) {
      const half = days[i].labelGap / 2;
      const center = (i + .5) * bin;
      const x = Math.max(half, Math.min(center, width - half));
      if (x + half > next) continue;
      offsets.set(i, x - center);
      next = x - half;
    }
    return offsets;
  });
  return <Show when={props.activity.length && data().length} fallback={<p class="secondary">No recorded activity in this period.</p>}>
    <div class="usage-chart-card usage-overview-chart" ref={state.ref}>
      <Show when={props.metric === 'tokens'}>
        <ul class="usage-chart-legend usage-activity-legend" aria-label="Token categories shown in Activity">
          <Index each={parts}>{part => <li>
            <button type="button" aria-pressed={!hiddenParts().includes(part().key)} onClick={() => togglePart(part().key)}>
              <span style={{ '--token-color': part().color }} aria-hidden="true"/>
              {part().label}
            </button>
          </li>}</Index>
        </ul>
      </Show>
      <div class="usage-activity-plot" ref={plot.ref} aria-label={`${usageBucketFrequency[frequency()]} recorded ${measure()}, earliest at left`}
        {...state.keyboard(data)} onPointerLeave={state.leave}>
        <div class="usage-activity-grid" aria-hidden="true">
          <Index each={scale().ticks}>{tick => <div class="usage-activity-tick" classList={{ 'is-baseline': tick() === 0 }}
            style={{ bottom: `${tick() / scale().ceiling * 100}%` }}>
            <span>{compactNumber.format(tick())}</span>
          </div>}</Index>
        </div>
        <Show when={props.metric === 'tokens' && !displayedParts().length}>
          <p class="usage-activity-empty" role="status">All categories hidden. Select a category to show it.</p>
        </Show>
        <Index each={data()}>{(day, i) => {
          return <div class="usage-activity-column" {...inspectDatum(() => day().id, state)}
            style={{ '--activity-mark-height': `${day().total / scale().ceiling * 100}%` }}>
            <BreakdownBar datum={day()} max={day().total || 1} state={state}/>
            <Show when={labelOffsets().has(i)}><time dateTime={day().id} style={{ transform: `translateX(${labelOffsets().get(i)}px)` }}>{day().label}</time></Show>
          </div>;
        }}</Index>
      </div>
      <Show when={frequency() !== 'day'}><p class="usage-overview-axis">{usageBucketAxis[frequency()]}</p></Show>
      <ChartInspection data={data()} state={state} totalLabel={`Total ${measure()}`}/>
    </div>
  </Show>;
}

export function RankedModelChart(props: { label: string; measure: UsageMeasure; rows: Array<{ label: string; tokens: UsageTokens; steps: number }> }) {
  const state = useChartInspection(() => [props.rows, props.measure]);
  const data = createMemo(() => props.rows.map((row, index) => ({
    id: String(index), heading: row.label,
    entries: props.measure === 'tokens' ? tokenEntries(row.tokens) : stepEntries(row.steps),
    total: props.measure === 'tokens' ? row.tokens.total : row.steps,
  })));
  const max = createMemo(() => data().reduce((peak, row) => Math.max(peak, row.total), 1));
  return <div class="usage-chart-card" ref={state.ref}>
    <Show when={props.measure === 'tokens'}><ChartLegend items={parts}/></Show>
    <RankedBars label={props.label} data={data()} max={max()} state={state}/>
  </div>;
}

function RankedBars(props: { label?: string; data: ChartDatum[]; max: number; state: InspectionState }) {
  return <>
    <ol class="usage-ranked-chart" aria-label={props.label} onPointerLeave={props.state.leave}>
      <Index each={props.data}>{datum => <li {...inspectDatum(() => datum().id, props.state)}>
        <span class="usage-chart-label">{datum().heading}</span>
        <BreakdownBar datum={datum()} max={props.max} state={props.state}/><strong>{number(datum().total)}</strong>
      </li>}</Index>
    </ol>
    <ChartInspection label="Inspect entry" data={props.data} state={props.state}/>
  </>;
}

export function RankedCountChart(props: {
  label: string; rows: Array<{ name: string; success: number; failure?: number }>; successLabel: string; failureLabel?: string;
}) {
  const max = createMemo(() => Math.max(1, ...props.rows.map(row => row.success + (row.failure || 0))));
  const legend = createMemo(() => [
    { label: props.successLabel, color: '#80b9c2' },
    ...(props.failureLabel ? [{ label: props.failureLabel, color: '#d17f84' }] : []),
  ]);
  const state = useChartInspection(() => props.rows);
  const data = createMemo(() => props.rows.slice(0, rankingLimit).map((row, index) => ({
    id: String(index), heading: row.name, entries: legend().map((item, i) => ({ ...item, value: i === 0 ? row.success : row.failure ?? 0 })),
    total: row.success + (row.failure ?? 0),
  })));
  return <div class="usage-chart-card" ref={state.ref}><ChartLegend items={legend()}/>
    <RankedBars label={props.label} data={data()} max={max()} state={state}/>
    <Show when={props.rows.length > rankingLimit}><p class="usage-chart-note secondary">Top {rankingLimit} of {props.rows.length}. See the table for all entries.</p></Show>
  </div>;
}
