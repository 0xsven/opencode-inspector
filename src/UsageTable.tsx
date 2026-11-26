import { createMemo, For, type JSX } from 'solid-js';

type UsageRow = { id: string; name: () => JSX.Element; values: string[] };

export function UsageTable(props: {
  label: string;
  columns: readonly string[];
  rows: UsageRow[];
  highlights: readonly number[];
  rankedBy?: number;
}) {
  const metrics = createMemo(() => props.columns.slice(1));
  // Keep compact disclosures mounted across polling updates to the same rows.
  const ids = createMemo(() => props.rows.map(row => row.id));
  const byId = createMemo(() => new Map(props.rows.map(row => [row.id, row])));

  return <>
    <div class="usage-table-wrap usage-full-table">
      <table class="technical-table" aria-label={props.label}>
        <thead><tr><For each={props.columns}>{(col, i) =>
          <th scope="col" aria-sort={i() - 1 === props.rankedBy ? 'descending' : undefined}>{col}</th>
        }</For></tr></thead>
        <tbody><For each={ids()}>{id => {
          const row = () => byId().get(id);
          return <tr>
            <th scope="row">{row()?.name()}</th>
            <For each={metrics()}>{(_, i) => <td classList={{ 'usage-rank-value': i() === props.rankedBy }}>{row()?.values[i()]}</td>}</For>
          </tr>;
        }}</For></tbody>
      </table>
    </div>
    <ul class="usage-compact-table surface-card" aria-label={props.label}>
      <For each={ids()}>{id => {
        const row = () => byId().get(id);
        return <li>
          <details>
            <summary>
              <span class="usage-compact-name">{row()?.name()}</span>
              <span class="usage-compact-metrics"><For each={props.highlights}>{i => <span><small>{metrics()[i]}</small><b>{row()?.values[i]}</b></span>}</For></span>
            </summary>
            <dl><For each={metrics()}>{(metric, i) => !props.highlights.includes(i()) && <div><dt>{metric}</dt><dd>{row()?.values[i()]}</dd></div>}</For></dl>
          </details>
        </li>;
      }}</For>
    </ul>
  </>;
}
