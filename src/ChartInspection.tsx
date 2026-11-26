import { batch, createEffect, createMemo, createSelector, createSignal, createUniqueId, Index, on, onCleanup, onMount, Show, type Accessor } from 'solid-js';

export const chartNumber = (value: number) => value.toLocaleString('en-US');
type LegendItem = { label: string; color: string };
export type ChartDatum = { id: string; heading: string; entries: Array<LegendItem & { value: number; key?: string }>; total: number };
type Inspection = { id: string; key?: string };
const segmentId = (id: string, key: string) => JSON.stringify([id, key]);

export function ChartLegend(props: { items: readonly LegendItem[]; label?: string }) {
  return <ul class="usage-chart-legend" aria-label={props.label}><Index each={props.items}>{item =>
    <li><span style={{ 'background-color': item().color }} aria-hidden="true"/>{item().label}</li>}</Index></ul>;
}

export function usePlotWidth() {
  const [width, setWidth] = createSignal(0);
  const ref = (plot: HTMLDivElement) => onMount(() => {
    const measure = () => setWidth(Math.floor(plot.getBoundingClientRect().width));
    const observer = new ResizeObserver(measure);
    observer.observe(plot);
    measure();
    onCleanup(() => observer.disconnect());
  });
  return { ref, width };
}

export const chartTargetKey = (target: EventTarget | null) =>
  target instanceof Element ? target.getAttribute('data-chart-key') ?? undefined : undefined;

export function useChartInspection(identity: Accessor<unknown>) {
  let root: HTMLDivElement | undefined;
  const instructions = createUniqueId();
  const [hover, setHover] = createSignal<Inspection | null>(null);
  const [cursor, setCursor] = createSignal<Inspection | null>(null);
  const [selected, setSelected] = createSignal<Inspection | null>(null);
  const active = createMemo(() => selected() ?? hover() ?? cursor());
  const activeId = createMemo(() => active()?.id);
  const isActive = createSelector(activeId);
  const isSegment = createSelector(() => {
    const item = active();
    return item?.key !== undefined ? segmentId(item.id, item.key) : undefined;
  });
  const clear = () => batch(() => { setHover(null); setCursor(null); setSelected(null); });
  const select = (id: string, key?: string) => batch(() => { setHover(null); setCursor(null); setSelected({ id, key }); });
  createEffect(on(identity, clear, { defer: true }));
  createEffect(on(() => active() !== null, open => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    window.addEventListener('keydown', escape);
    onCleanup(() => window.removeEventListener('keydown', escape));
  }));
  return {
    root: () => root, ref: (element: HTMLDivElement) => { root = element; },
    active, activeId, selected, cursor, instructions, clear, select, isActive,
    isSegment: (id: string, key: string) => isSegment(segmentId(id, key)),
    leave: () => setHover(null),
    preview: (id: string, key?: string) => {
      if (!selected()) setHover(current => current?.id === id && current.key === key ? current : { id, key });
    },
    keyboard: (data: Accessor<ChartDatum[]>) => ({
      tabindex: 0,
      role: 'group' as const,
      'aria-describedby': instructions,
      'data-chart-keyboard': '',
      onFocus: (event: FocusEvent & { currentTarget: Element }) => {
        const first = data()[0];
        if (event.currentTarget.matches(':focus-visible') && !selected() && first) {
          batch(() => { setHover(null); setCursor({ id: first.id }); });
        }
      },
      onBlur: () => setCursor(null),
      onKeyDown: (event: KeyboardEvent) => {
        const { key } = event;
        if (!['ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(key)) return;
        event.preventDefault();
        const current = selected() ?? cursor() ?? hover();
        const items = data();
        const i = items.findIndex(item => item.id === current?.id);
        if (key === 'Enter' || key === ' ') {
          if (i >= 0 && current) select(current.id, current.key);
          else if (items[0]) select(items[0].id);
        } else {
          const next = items[i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + (key === 'ArrowLeft' ? -1 : 1)))];
          if (!next) return;
          batch(() => { setHover(null); setSelected(null); setCursor({ id: next.id }); });
        }
      },
    }),
  };
}

export type InspectionState = ReturnType<typeof useChartInspection>;

function positionPreview(root: HTMLDivElement, panel: HTMLDivElement, previewed: string) {
  const anchor = root.querySelector(`[data-chart-bucket="${CSS.escape(previewed)}"]`);
  if (!anchor) return;
  const mark = anchor.querySelector('.usage-chart-bar') ?? anchor;
  const pane = root.closest('.usage-workspace-content');
  const position = () => {
    const box = mark.getBoundingClientRect();
    // Empty timeline buckets still have a hit area above the baseline.
    const plot = anchor instanceof SVGElement ? anchor.ownerSVGElement?.getBoundingClientRect() ?? box : anchor.getBoundingClientRect();
    const view = pane?.getBoundingClientRect();
    const viewTop = view && pane ? view.top + pane.clientTop : 0;
    const viewLeft = view && pane ? view.left + pane.clientLeft : 0;
    const top = Math.max(viewTop, 0);
    const left = Math.max(viewLeft, 0);
    const right = Math.min(pane ? viewLeft + pane.clientWidth : window.innerWidth, window.innerWidth);
    const bottom = Math.min(pane ? viewTop + pane.clientHeight : window.innerHeight, window.innerHeight);
    const gap = 8;
    const width = Math.min(320, right - left - 2 * gap);
    if (plot.top >= bottom || plot.bottom <= top || box.left >= right || box.right <= left || width <= 0) {
      panel.style.visibility = 'hidden';
      return;
    }
    const rightSpace = right - box.right - 2 * gap;
    const leftSpace = box.left - left - 2 * gap;
    const minSideWidth = 240;
    const besideRight = rightSpace >= width || (rightSpace >= minSideWidth && rightSpace >= leftSpace);
    const sideWidth = Math.min(width, besideRight ? rightSpace : leftSpace);
    if (sideWidth >= minSideWidth) {
      panel.style.width = `${sideWidth}px`;
      panel.style.left = `${besideRight ? box.right + gap : box.left - gap - sideWidth}px`;
      panel.dataset.summary = 'false';
      const space = bottom - top - 2 * gap;
      if (panel.offsetHeight > space) panel.dataset.summary = 'true';
      const height = panel.offsetHeight;
      panel.style.top = `${Math.max(top + gap, Math.min(bottom - gap - height, (box.top + box.bottom - height) / 2))}px`;
      panel.style.visibility = height <= space ? 'visible' : 'hidden';
      return;
    }
    const start = Math.max(top + gap, box.bottom + gap);
    const end = Math.min(bottom - gap, box.top - gap);
    const below = bottom - gap - start;
    const above = end - top - gap;
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(left + gap, Math.min(right - gap - width, (box.left + box.right - width) / 2))}px`;
    panel.dataset.summary = 'false';
    if (panel.offsetHeight > Math.max(below, above)) panel.dataset.summary = 'true';
    const height = panel.offsetHeight;
    const y = height <= below || below >= above ? start : end - height;
    panel.style.top = `${y}px`;
    panel.style.visibility = height <= Math.max(below, above) ? 'visible' : 'hidden';
  };
  position();
  const observer = new ResizeObserver(position);
  observer.observe(mark);
  observer.observe(root);
  observer.observe(panel);
  if (pane) observer.observe(pane);
  window.addEventListener('scroll', position, true);
  window.addEventListener('resize', position);
  onCleanup(() => {
    observer.disconnect();
    window.removeEventListener('scroll', position, true);
    window.removeEventListener('resize', position);
  });
}

export function ChartInspection(props: {
  label?: string; data: ChartDatum[]; state: InspectionState; totalLabel?: string; format?: (value: number) => string;
}) {
  const state = props.state;
  const id = createUniqueId();
  let select: HTMLSelectElement | undefined;
  const detail = createMemo(() => props.data.find(item => item.id === state.activeId()));
  const announced = createMemo(() => props.data.find(item => item.id === (state.selected() ?? state.cursor())?.id));
  const pinned = createMemo(() => Boolean(state.selected()));
  const totalLabel = () => props.totalLabel ?? 'Total';
  const format = (value: number) => (props.format ?? chartNumber)(value);
  const restoreFocus = () => (select ?? state.root()?.querySelector<HTMLElement | SVGSVGElement>('[data-chart-keyboard]'))?.focus();
  return <div classList={{ 'usage-chart-inspection': Boolean(props.label) || pinned() }}>
    <Show when={props.label} fallback={<span class="visually-hidden" id={state.instructions}>Use Left and Right to examine buckets, Enter or Space to pin the full breakdown, and Escape to clear.</span>}>
      <select ref={select} aria-label={props.label} aria-controls={detail() ? id : undefined} value={state.selected()?.id ?? ''}
        onChange={event => event.currentTarget.value ? state.select(event.currentTarget.value) : state.clear()}>
        <option value="">{props.label}…</option>
        <Index each={props.data}>{item => <option value={item().id}>{item().heading}</option>}</Index>
      </select>
    </Show>
    <span class="visually-hidden" role="status">{announced() ? `${announced()!.heading}. ${totalLabel()}: ${format(announced()!.total)}.${pinned() ? ' Breakdown pinned.' : ''}` : ''}</span>
    <Show when={detail()}>{item =>
      <Show when={pinned()} fallback={<InspectionPanel id={id} item={item()} state={state} totalLabel={totalLabel()} format={format} label={props.label} restoreFocus={restoreFocus}/>}>
        <InspectionPanel pinned id={id} item={item()} state={state} totalLabel={totalLabel()} format={format} restoreFocus={restoreFocus}/>
      </Show>}
    </Show>
  </div>;
}

function InspectionPanel(props: {
  pinned?: boolean; id: string; item: ChartDatum; state: InspectionState; totalLabel: string; format: (value: number) => string;
  label?: string; restoreFocus: () => void;
}) {
  let panel!: HTMLDivElement;
  if (!props.pinned) createEffect(on(() => props.item.id, previewed => {
    const root = props.state.root();
    if (root) positionPreview(root, panel, previewed);
  }));
  return <div ref={panel} id={props.id} class={`usage-chart-tooltip${props.pinned ? '' : ' usage-chart-preview'}`} tabIndex={props.pinned ? 0 : undefined}
    role={props.pinned ? 'region' : 'tooltip'} aria-label={`${props.item.heading} breakdown`}
    onKeyDown={event => { if (event.key === 'Escape') props.restoreFocus(); }}>
    <strong>{props.item.heading}</strong>
    <ul><Index each={props.item.entries}>{(entry, index) => <li classList={{ 'is-hovered': props.state.isSegment(props.item.id, entry().key ?? String(index)) }}>
      <span style={{ 'background-color': entry().color }} aria-hidden="true"/><span>{entry().label}</span><b>{props.format(entry().value)}</b>
    </li>}</Index></ul>
    <footer>{props.totalLabel} <b>{props.format(props.item.total)}</b></footer>
    <Show when={!props.pinned}><p class="usage-chart-preview-summary">{props.label ? 'Select an entry or click the chart' : 'Click the chart or press Enter when it is focused'} to see the full breakdown.</p></Show>
  </div>;
}
