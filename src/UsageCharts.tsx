import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { UsageCounts, UsageTokens } from './usage-types';

const parts = [
  ['Input', 'input', '#80b9c2'], ['Output', 'output', '#d49a65'],
  ['Reasoning', 'reasoning', '#ad91c7'], ['Cache read', 'cacheRead', '#8eae78'],
  ['Cache write', 'cacheWrite', '#d17f84'],
] as const;
const number = (value: number) => value.toLocaleString('en-US');
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const rankingLimit = 8;

function Legend() {
  return <ul className="usage-chart-legend">{parts.map(([label, key, color]) =>
    <li key={key}><span style={{ backgroundColor: color }} aria-hidden="true"/>{label}</li>)}</ul>;
}

type Breakdown = Array<{ label: string; color: string; value: number }>;
type Hover = { id: string | number; index: number; heading: string; entries: Breakdown; total: number; left: number; top: number; width: number; above: boolean };
function useBreakdown(identity: unknown[]) {
  const root = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  useEffect(() => { setHover(null); }, [identity]);
  const active = hover !== null;
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setHover(null); };
    const dismiss = () => setHover(null);
    window.addEventListener('keydown', escape);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [active]);
  const show = (bar: HTMLElement | null, id: Hover['id'], index: number, heading: string, entries: Breakdown, total: number) => {
    const box = root.current?.getBoundingClientRect();
    if (!box || !bar) return;
    const mark = bar.getBoundingClientRect();
    const width = Math.min(320, box.width - 2);
    const center = mark.left + mark.width / 2 - box.left;
    const left = Math.max(0, Math.min(center - width / 2, box.width - width - 2));
    const above = mark.top > 230 || window.innerHeight - mark.bottom < mark.top;
    const top = (above ? mark.top - 5 : mark.bottom + 5) - box.top;
    setHover(current => current?.id === id
      ? current.index === index ? current : { ...current, index }
      : { id, index, heading, entries, total, left, top, width, above });
  };
  return { root, hover, dismiss: () => setHover(null), show };
}

function BreakdownTooltip({ hover }: { hover: Hover }) {
  return <div className={`usage-chart-tooltip model-timeline-tooltip${hover.above ? ' above-mark' : ''}`} style={{ width: hover.width, left: hover.left, top: hover.top }} role="tooltip">
    <strong>{hover.heading}</strong><ul>{hover.entries.map(({ label, color, value }, index) => <li key={index} className={hover.index === index ? 'is-hovered' : ''}><span style={{ backgroundColor: color }}/><span>{label}</span><b>{number(value)}</b></li>)}</ul>
    <footer>Total <b>{number(hover.total)}</b></footer>
  </div>;
}

const tokenEntries = (tokens: UsageTokens) => parts.map(([label, key, color]) => ({ label, color, value: tokens[key] }));

function BreakdownBar({ entries, total, max, id, heading, state }: {
  entries: Breakdown; total: number; max: number; id: Hover['id']; heading: string; state: ReturnType<typeof useBreakdown>;
}) {
  const index = state.hover?.id === id ? state.hover.index : -1;
  return <div className="usage-chart-bar" role="img" aria-label={entries.map(({ label, value }) => `${label} ${number(value)}`).join(', ') + `; total ${number(total)}`}
    onPointerLeave={state.dismiss}>
    {entries.map(({ color, value }, i) => value > 0
      ? <span key={i} className={`usage-token-segment${i === index ? ' is-hovered' : ''}`}
        onPointerEnter={event => state.show(event.currentTarget.parentElement, id, i, heading, entries, total)}
        onClick={event => state.show(event.currentTarget.parentElement, id, i, heading, entries, total)}
        style={{ backgroundColor: color, '--token-size': `${value / max * 100}%` } as CSSProperties}/>
      : null)}
  </div>;
}

export function OverviewChart({ activity, from, to }: { activity: Array<UsageCounts & { date: string }>; from: number; to: number }) {
  const dates: string[] = [];
  const cursor = new Date(from);
  const end = new Date(to);
  const today = new Date();
  const observedThrough = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  while (cursor < end && cursor < observedThrough && dates.length < 32) {
    dates.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  const byDate = new Map(activity.map(day => [day.date, day]));
  const max = Math.max(1, ...activity.map(day => day.tokens.total));
  const state = useBreakdown(activity);
  if (!activity.length) return <p className="secondary">No recorded activity in this period.</p>;
  return <div className="usage-chart-card usage-token-chart" ref={state.root}>
    <Legend/><div className="usage-daily-scroll" role="region" aria-label="Daily recorded token composition" tabIndex={0}>
      <div className="usage-daily-chart" role="list">
      {dates.map(date => {
        const day = byDate.get(date);
        const tokens = day?.tokens || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        return <div className="usage-daily-column" role="listitem" key={date} aria-label={`${date}: ${number(tokens.total)} total tokens`}>
          <span className="usage-daily-value" title={`${number(tokens.total)} recorded tokens`}>{compactNumber.format(tokens.total)}</span>
          <BreakdownBar entries={tokenEntries(tokens)} total={tokens.total} max={max} id={date} heading={date} state={state}/>
          <time dateTime={date}>{date.slice(5)}</time>
        </div>;
      })}
      </div>
    </div>{state.hover && <BreakdownTooltip hover={state.hover}/>}
  </div>;
}

export function RankedTokenChart({ rows }: { rows: Array<{ label: string; tokens: UsageTokens }> }) {
  const max = Math.max(1, ...rows.map(row => row.tokens.total));
  const state = useBreakdown(rows);
  return <div className="usage-chart-card usage-token-chart" ref={state.root}><Legend/><ol className="usage-ranked-chart">
    {rows.map((row, index) => <li key={`${row.label}-${index}`}><span className="usage-chart-label">{row.label}</span><BreakdownBar entries={tokenEntries(row.tokens)} total={row.tokens.total} max={max} id={index} heading={row.label} state={state}/><strong>{number(row.tokens.total)}</strong></li>)}
  </ol>{state.hover && <BreakdownTooltip hover={state.hover}/>}</div>;
}

export function RankedCountChart({ label, rows, successLabel, failureLabel }: {
  label: string; rows: Array<{ name: string; success: number; failure?: number }>; successLabel: string; failureLabel?: string;
}) {
  const max = Math.max(1, ...rows.map(row => row.success + (row.failure || 0)));
  const colors = ['#80b9c2', '#d17f84'];
  const state = useBreakdown(rows);
  return <div className="usage-chart-card usage-token-chart" ref={state.root}><ul className="usage-chart-legend">
    <li><span style={{ backgroundColor: colors[0] }} aria-hidden="true"/>{successLabel}</li>
    {failureLabel && <li><span style={{ backgroundColor: colors[1] }} aria-hidden="true"/>{failureLabel}</li>}
  </ul><ol className="usage-ranked-chart" aria-label={label}>
    {rows.slice(0, rankingLimit).map((row, index) => {
      const entries = [{ label: successLabel, color: colors[0], value: row.success }];
      if (failureLabel) entries.push({ label: failureLabel, color: colors[1], value: row.failure ?? 0 });
      const total = row.success + (row.failure ?? 0);
      return <li key={`${row.name}-${index}`}><span className="usage-chart-label">{row.name}</span>
        <BreakdownBar entries={entries} total={total} max={max} id={index} heading={row.name} state={state}/><strong>{number(total)}</strong>
      </li>;
    })}
  </ol>{state.hover && <BreakdownTooltip hover={state.hover}/>}
    {rows.length > rankingLimit && <p className="usage-chart-note secondary">Top {rankingLimit} of {rows.length}. See the table for all entries.</p>}</div>;
}
