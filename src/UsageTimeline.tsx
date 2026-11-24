import type { UsageResponse } from './usage-types';
import { useEffect, useRef, useState } from 'react';

type Available = Extract<UsageResponse, { status: 'available' | 'partial' }>;
type ModelPoint = Available['modelActivity'][number];
type AgentPoint = Available['agentActivity'][number];
type Point = ModelPoint | AgentPoint;
type Metric = 'tokens' | 'sessions' | 'steps';
export type TimelineRole = 'all' | Point['role'];
const roleLabels = { all: 'All agents', main: 'Main agents', subagent: 'Subagents' } as const;
type Series = { key: string; name: string; values: Map<string, number>; color: string };

const palette = ['#4f8cff', '#e879a9', '#36a889', '#ed9b42', '#9876df', '#d25d55', '#36a9bd', '#91a53c', '#cf6e3e', '#7085a6'];
const number = (n: number) => n.toLocaleString();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const modelName = (item: ModelPoint) => item.provider === null && item.model === null ? 'Unknown' : `${item.provider ?? 'Unknown'} / ${item.model ?? 'Unknown'}`;
const hourClock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const hourOffset = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });
const hourDetail = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' });

export function UsageTimeline({ activity, from, to, granularity = 'day', kind = 'model', view, onViewChange, metric = 'tokens', onMetricChange, role, onRoleChange }: {
  activity: ModelPoint[] | AgentPoint[]; from: number; to: number; granularity?: 'hour' | 'day'; kind?: 'model' | 'agent';
  view: 'bars' | 'lines'; onViewChange: (view: 'bars' | 'lines') => void;
  metric?: Metric; onMetricChange: (metric: Metric) => void;
  role: TimelineRole; onRoleChange: (role: TimelineRole) => void;
}) {
  const plot = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ date: string; key: string; center: number; gap: number; width: number } | null>(null);
  useEffect(() => { setHover(null); }, [view, metric, role, granularity, from, to, kind]);
  const hovering = hover !== null;
  useEffect(() => {
    if (!hovering) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setHover(null); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [hovering]);
  const hourly = granularity === 'hour';
  const now = Date.now();
  const dates: string[] = [];
  for (let t = from; t < to && t <= now && dates.length < (hourly ? 26 : 32);) {
    dates.push(hourly ? new Date(t).toISOString() : (() => {
      const d = new Date(t);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })());
    if (hourly) t += 3600000;
    else { const d = new Date(t); d.setDate(d.getDate() + 1); t = d.getTime(); }
  }
  const clockLabels = hourly ? dates.map(date => hourClock.format(new Date(date))) : [];
  const repeated = new Set(clockLabels.filter((label, i) => clockLabels.indexOf(label) !== i));
  const clockLabel = (date: string, i: number) => repeated.has(clockLabels[i]) ? hourOffset.format(new Date(date)) : clockLabels[i];
  const map = new Map<string, Series>();
  for (const point of activity) {
    const isAgent = 'agent' in point;
    const key = isAgent ? JSON.stringify([point.agent]) : JSON.stringify([point.provider, point.model]);
    const name = isAgent ? point.agent : modelName(point);
    const item = map.get(key) ?? { key, name, values: new Map<string, number>(), color: palette[map.size % palette.length] };
    if (role === 'all' || point.role === role) item.values.set(point.date, (item.values.get(point.date) ?? 0) + point[metric]);
    map.set(key, item);
  }
  const legend = [...map.values()].filter(item => item.values.size > 0);
  const series = legend.filter(item => [...item.values.values()].some(value => value > 0));
  const max = Math.max(0, ...dates.map(date => series.reduce((sum, item) => {
    const n = item.values.get(date) ?? 0;
    return view === 'bars' ? sum + n : Math.max(sum, n);
  }, 0)));
  const scale = max ? 10 ** Math.floor(Math.log10(max)) : 1;
  const ceiling = max ? Math.ceil(max / scale) * scale : 1;
  const ticks = ceiling > 1 ? [0, Math.floor(ceiling / 2), ceiling] : [0, 1];
  const width = 560, chartHeight = 220, left = 54, right = width - 18;
  const bin = (right - left) / dates.length;
  const x = (i: number) => left + (i + .5) * bin;
  const y = (value: number) => chartHeight - 44 - value / ceiling * (chartHeight - 68);
  const labelEvery = Math.max(1, Math.ceil(dates.length / 8));
  const hasData = max > 0;
  const hoverValues = hover ? series.map(item => ({ ...item, value: item.values.get(hover.date) ?? 0 })).filter(item => item.value > 0).sort((a, b) => b.value - a.value) : [];
  const hoverTotal = hoverValues.reduce((sum, item) => sum + item.value, 0);
  const dismiss = () => setHover(null);
  const showHover = (event: React.MouseEvent<SVGElement>, date: string, key: string) => {
    const rect = plot.current?.getBoundingClientRect();
    const mark = event.currentTarget.getBoundingClientRect();
    if (!rect) return;
    // A bucket owns the panel position. Changing series only changes the highlight.
    setHover(current => current?.date === date
      ? current.key === key ? current : { ...current, key }
      : { date, key, center: mark.left + mark.width / 2 - rect.left, gap: mark.width / 2 + 12, width: rect.width });
  };
  const tooltipStyle = hover && (() => {
    const width = Math.min(320, hover.width);
    const side = hover.center < hover.width / 2 ? hover.center + hover.gap : hover.center - width - hover.gap;
    return side >= 0 && side + width <= hover.width
      ? { width, left: side, top: 0 }
      : { width, left: Math.max(0, Math.min(hover.center - width / 2, hover.width - width)), top: '100%' };
  })();
  return <div className="usage-chart-card model-timeline-card">
    <div className="model-timeline-toolbar">
      <p className="usage-chart-note secondary">{hourly ? 'Hourly' : 'Daily'} usage. Tokens include cache. Sessions can count in more than one series.</p>
      <TimelineSelectors {...{ view, onViewChange, metric, onMetricChange, role, onRoleChange }}/>
    </div>
    {!hasData ? <p className="secondary">No recorded {kind} {metric} for {roleLabels[role].toLowerCase()} in this period.</p> : <>
    <ul className="usage-chart-legend" aria-label={kind === 'agent' ? 'Agent series' : 'Provider and model series'}>{legend.map(item => <li key={item.key}><span style={{ backgroundColor: item.color }} aria-hidden="true"/>{item.name}</li>)}</ul>
    <div className="model-timeline-plot" ref={plot} onPointerLeave={dismiss}>
    <div className="model-timeline-scroll" tabIndex={0} role="region" aria-label={`${kind} usage timeline`} onScroll={dismiss}>
      <svg className={`model-timeline model-timeline-${view}`} viewBox={`0 0 ${width} ${chartHeight}`} style={{ minWidth: width }} role="img" aria-label={`${view === 'bars' ? 'Stacked recorded' : 'Recorded'} ${kind} ${metric} by ${hourly ? 'hour' : 'day'}, earliest at left`}>
         <text x={left} y="13">Recorded {metric}</text>
        {ticks.map(t => <g key={t}><line x1={left} x2={right} y1={y(t)} y2={y(t)} className="model-timeline-grid"/><text x={left - 6} y={y(t) + 4} textAnchor="end">{compact.format(t)}</text></g>)}
        {dates.map((d, i) => i % labelEvery === 0 && <text key={d} x={x(i)} y={chartHeight - 26} textAnchor="middle">{hourly ? clockLabel(d, i) : d.slice(5)}</text>)}
        {view === 'bars' ? dates.map((d, i) => {
          const barWidth = Math.min(40, bin * .75);
          let accumulated = 0;
          return <g key={d}>
            {series.map(item => { const n = item.values.get(d) ?? 0; const bottom = y(accumulated); accumulated += n; const top = y(accumulated); return n > 0 ? <rect key={item.key} x={x(i) - barWidth / 2} y={top} width={barWidth} height={bottom - top} fill={item.color} className={hover?.date === d && hover.key === item.key ? 'is-hovered' : ''} onPointerEnter={e => showHover(e, d, item.key)} onClick={e => showHover(e, d, item.key)}/> : null; })}
          </g>;
        }) : series.map(item => {
          const points = dates.map((d, i) => {
            const n = item.values.get(d) ?? 0;
            return { x: x(i), y: y(n), d, n };
          });
          return <g key={item.key} style={{ color: item.color }}>{points.length > 1 && <polyline points={points.map(p => `${p.x},${p.y}`).join(' ')} className="model-timeline-line"/>}{points.filter(p => p.n > 0).map(p => <circle key={p.d} cx={p.x} cy={p.y} r="4" className={`model-timeline-dot${hover?.date === p.d && hover.key === item.key ? ' is-hovered' : ''}`} onPointerEnter={e => showHover(e, p.d, item.key)} onClick={e => showHover(e, p.d, item.key)}/>)}</g>;
        })}
         <text x={(left + right) / 2} y={chartHeight - 4} textAnchor="middle">{hourly ? 'Hour' : 'Date'}</text>
      </svg>
    </div>
      {hover && tooltipStyle && <div className="model-timeline-tooltip" style={tooltipStyle} role="tooltip">
        <strong>{hourly ? hourDetail.format(new Date(hover.date)) : hover.date}</strong>
         <ul>{hoverValues.map(item => <li key={item.key} className={item.key === hover.key ? 'is-hovered' : ''}><span style={{ backgroundColor: item.color }}/><span>{item.name}</span><b>{number(item.value)}</b></li>)}</ul>
         <footer>{metric === 'sessions' ? 'Series session total' : 'Total'} <b>{number(hoverTotal)}</b></footer>
      </div>}
    </div>
    </>}
  </div>;
}

function TimelineSelectors({ view, onViewChange, metric, onMetricChange, role, onRoleChange }: { view: 'bars' | 'lines'; onViewChange: (view: 'bars' | 'lines') => void; metric: Metric; onMetricChange: (metric: Metric) => void; role: TimelineRole; onRoleChange: (role: TimelineRole) => void }) {
  return <div className="model-timeline-selectors">
    <div role="group" aria-label="Timeline metric" className="model-timeline-switch">{(['tokens', 'sessions', 'steps'] as const).map(value => <button key={value} aria-pressed={metric === value} onClick={() => onMetricChange(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div>
    <div role="group" aria-label="Timeline chart style" className="model-timeline-switch"><button aria-pressed={view === 'bars'} onClick={() => onViewChange('bars')}>Stacked bars</button><button aria-pressed={view === 'lines'} onClick={() => onViewChange('lines')}>Lines</button></div>
    <div role="group" aria-label="Timeline agent role" className="model-timeline-switch">{(['all', 'main', 'subagent'] as const).map(value => <button key={value} aria-pressed={role === value} onClick={() => onRoleChange(value)}>{roleLabels[value]}</button>)}</div>
  </div>;
}
