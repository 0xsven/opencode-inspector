import { createMemo, Index, mergeProps, Show } from 'solid-js';
import type { UsageGranularity, UsageResponse } from './usage-types';
import { ChartInspection, ChartLegend, chartTargetKey, useChartInspection, usePlotWidth, type ChartDatum, type InspectionState } from './ChartInspection';
import { usageBucketAxis, usageBucketFrequency, usageChartBuckets } from './usage-chart-dates';
import type { UsageMeasure } from './UsageCharts';

type Available = Extract<UsageResponse, { status: 'available' | 'partial' }>;
type ModelPoint = Available['modelActivity'][number];
type AgentPoint = Available['agentActivity'][number];
type Point = ModelPoint | AgentPoint;
type View = 'bars' | 'lines';
export type TimelineRole = 'all' | Point['role'];
const roleLabels = { all: 'All agents', main: 'Main agents', subagent: 'Subagents' } as const;
type Series = { key: string; label: string; values: Map<string, number>; color: string };
type TimelineBucket = ChartDatum & { label: string; peak: number };

const palette = ['#4f8cff', '#e879a9', '#36a889', '#ed9b42', '#9876df', '#d25d55', '#36a9bd', '#91a53c', '#cf6e3e', '#7085a6'];
const number = (n: number) => n.toLocaleString();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const modelName = (item: ModelPoint) => item.provider === null && item.model === null ? 'Unknown' : `${item.provider ?? 'Unknown'} / ${item.model ?? 'Unknown'}`;

type Selectors = {
  view: View; onViewChange: (view: View) => void;
  role: TimelineRole; onRoleChange: (role: TimelineRole) => void;
};

export function UsageTimeline(input: Selectors & {
  activity: ModelPoint[] | AgentPoint[]; from: number; to: number; granularity?: UsageGranularity; kind?: 'model' | 'agent'; metric: UsageMeasure;
}) {
  const props = mergeProps({ granularity: 'day', kind: 'model' } as const, input);
  const plot = usePlotWidth();
  const inspection = useChartInspection(() => [props.activity, props.view, props.metric, props.role, props.granularity, props.from, props.to, props.kind]);
  const buckets = createMemo(() => {
    // Refreshed activity can extend the observed portion of a range ending in the future.
    void props.activity;
    return usageChartBuckets(props.from, props.to, props.granularity);
  });
  const legend = createMemo(() => {
    const map = new Map<string, Series>();
    for (const point of props.activity) {
      const isAgent = 'agent' in point;
      const key = isAgent ? JSON.stringify([point.agent]) : JSON.stringify([point.provider, point.model]);
      const label = isAgent ? point.agent : modelName(point);
      const item = map.get(key) ?? { key, label, values: new Map<string, number>(), color: palette[map.size % palette.length] };
      if (props.role === 'all' || point.role === props.role) item.values.set(point.date, (item.values.get(point.date) ?? 0) + point[props.metric]);
      map.set(key, item);
    }
    return [...map.values()].filter(item => item.values.size > 0);
  });
  const series = createMemo(() => legend().filter(item => [...item.values.values()].some(value => value > 0)));
  const data = createMemo(() => buckets().buckets.map(({ id, heading, label }) => {
    const entries = series().map(item => ({ key: item.key, label: item.label, color: item.color, value: item.values.get(id) ?? 0 }))
      .filter(item => item.value > 0).sort((a, b) => b.value - a.value);
    const total = entries.reduce((sum, item) => sum + item.value, 0);
    const peak = props.view === 'bars' ? total : entries[0]?.value ?? 0;
    return { id, heading, label, entries, total, peak };
  }));
  const max = createMemo(() => data().reduce((peak, day) => Math.max(peak, day.peak), 0));
  const kindLabel = () => props.kind === 'agent' ? 'Agent series' : 'Provider and model series';
  return <div class="usage-chart-card model-timeline-card" ref={inspection.ref}>
    <div class="model-timeline-toolbar">
      <p class="usage-chart-note secondary">{usageBucketFrequency[props.granularity]} {props.metric === 'tokens' ? 'tokens, including cache.' : 'assistant steps.'}</p>
      <TimelineSelectors view={props.view} onViewChange={props.onViewChange} role={props.role} onRoleChange={props.onRoleChange}/>
    </div>
    <Show when={max() > 0} fallback={<p class="secondary">No recorded {props.kind} {props.metric} for {roleLabels[props.role].toLowerCase()} in this period.</p>}>
      <ChartLegend items={legend()} label={kindLabel()}/>
      <div class="model-timeline-plot" ref={plot.ref}>
        <Show when={plot.width() > 0}>
          <TimelinePlot data={data()} state={inspection} series={series()} width={plot.width()} max={max()} labelGap={buckets().labelGap}
            view={props.view} metric={props.metric} granularity={props.granularity} kind={props.kind}/>
        </Show>
        <ChartInspection data={data()} state={inspection} format={number}/>
      </div>
    </Show>
  </div>;
}

function TimelinePlot(props: {
  data: TimelineBucket[]; state: InspectionState; series: Series[]; width: number; max: number; labelGap: number;
  view: View; metric: UsageMeasure; granularity: UsageGranularity; kind: 'model' | 'agent';
}) {
  const state = props.state;
  const ceiling = createMemo(() => {
    const scale = props.max ? 10 ** Math.floor(Math.log10(props.max)) : 1;
    return props.max ? Math.ceil(props.max / scale) * scale : 1;
  });
  const ticks = createMemo(() => ceiling() > 1 ? [0, Math.floor(ceiling() / 2), ceiling()] : [0, 1]);
  // Match the viewBox to the measured pane without scaling type or dropping buckets.
  const height = () => props.width < 480 ? 168 : 208;
  const left = 50;
  const right = () => Math.max(left + 1, props.width - 14);
  const bin = () => (right() - left) / Math.max(1, props.data.length);
  const x = (i: number) => left + (i + .5) * bin();
  const y = (value: number) => height() - 38 - value / ceiling() * (height() - 62);
  const labelEvery = () => Math.max(1, Math.ceil(props.labelGap / bin()));
  const inspect = (event: MouseEvent & { currentTarget: SVGSVGElement }, pin: boolean) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const column = Math.floor(((event.clientX - rect.left) / rect.width * props.width - left) / bin());
    const date = props.data[column]?.id;
    if (!date) {
      if (!pin) state.leave();
      return;
    }
    (pin ? state.select : state.preview)(date, chartTargetKey(event.target));
  };
  const activeIndex = createMemo(() => {
    const id = state.activeId();
    return id === undefined ? -1 : props.data.findIndex(day => day.id === id);
  });
  return <svg class={`model-timeline model-timeline-${props.view}`} viewBox={`0 0 ${props.width} ${height()}`} height={height()}
    aria-label={`${props.view === 'bars' ? 'Stacked recorded' : 'Recorded'} ${props.kind} ${props.metric} by ${props.granularity}, earliest at left`}
    {...state.keyboard(() => props.data)}
    onPointerMove={event => { if (event.pointerType === 'mouse') inspect(event, false); }} onPointerLeave={state.leave} onClick={event => inspect(event, true)}>
    <text x={left} y="13">Recorded {props.metric}</text>
    <rect x={left} y={y(ceiling())} width={right() - left} height={y(0) - y(ceiling()) + 20} fill="transparent"/>
    <Index each={props.data}>{(day, i) => <rect data-chart-bucket={day().id} class="model-timeline-anchor" x={left + i * bin()} y={y(day().peak)}
      width={bin()} height={y(0) - y(day().peak) + 4} fill="none"/>}</Index>
    <Show when={activeIndex() >= 0}><rect class="model-timeline-active" x={left + activeIndex() * bin()} y={y(ceiling())}
      width={bin()} height={y(0) - y(ceiling()) + 4}/></Show>
    <Index each={ticks()}>{t => <g><line x1={left} x2={right()} y1={y(t())} y2={y(t())} class="model-timeline-grid"/><text x={left - 6} y={y(t()) + 4} text-anchor="end">{compact.format(t())}</text></g>}</Index>
    <Index each={props.data}>{(day, i) => <Show when={i % labelEvery() === 0 && x(i) <= props.width - props.labelGap / 2}>
      <text x={x(i)} y={height() - 21} text-anchor="middle">{day().label}</text>
    </Show>}</Index>
    <Show when={props.view === 'bars'} fallback={<Index each={props.series}>{item => {
      const points = createMemo(() => props.data.map(({ id }, i) => ({ id, i, n: item().values.get(id) ?? 0 })));
      const dots = createMemo(() => points().filter(point => point.n > 0));
      return <g style={{ color: item().color }}>
        <Show when={points().length > 1}><polyline points={points().map(point => `${x(point.i)},${y(point.n)}`).join(' ')} class="model-timeline-line"/></Show>
        <Index each={dots()}>{p => <circle cx={x(p().i)} cy={y(p().n)} r={Math.min(4, bin() * .45)} class="model-timeline-dot"
          classList={{ 'is-hovered': state.isSegment(p().id, item().key) }} data-chart-key={item().key}/>}</Index>
      </g>;
    }}</Index>}>
      <Index each={props.data}>{(day, i) => {
        const barWidth = () => Math.min(40, bin() * .75);
        const segments = createMemo(() => {
          const id = day().id;
          let accumulated = 0;
          return props.series.flatMap(item => {
            const n = item.values.get(id) ?? 0;
            const bottom = accumulated;
            accumulated += n;
            return n > 0 ? [{ bottom, top: accumulated, color: item.color, key: item.key }] : [];
          });
        });
        return <g><Index each={segments()}>{segment => <rect x={x(i) - barWidth() / 2} y={y(segment().top)}
          width={barWidth()} height={y(segment().bottom) - y(segment().top)} fill={segment().color}
          classList={{ 'is-hovered': state.isSegment(day().id, segment().key) }} data-chart-key={segment().key}/>}</Index></g>;
      }}</Index>
    </Show>
    <text x={(left + right()) / 2} y={height() - 4} text-anchor="middle">{usageBucketAxis[props.granularity]}</text>
  </svg>;
}

function TimelineSelectors(props: Selectors) {
  return <div class="model-timeline-selectors">
    <div role="group" aria-label="Timeline chart style" class="model-timeline-switch"><button aria-pressed={props.view === 'bars'} onClick={() => props.onViewChange('bars')}>Stacked bars</button><button aria-pressed={props.view === 'lines'} onClick={() => props.onViewChange('lines')}>Lines</button></div>
    <div role="group" aria-label="Timeline agent role" class="model-timeline-switch">{(['all', 'main', 'subagent'] as const).map(value =>
      <button aria-pressed={props.role === value} onClick={() => props.onRoleChange(value)}>{roleLabels[value]}</button>)}</div>
  </div>;
}
