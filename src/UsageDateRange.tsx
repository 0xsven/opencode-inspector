import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { localDateInput, parseLocalDate, usageDatePresets, type usageRange, type UsageDateSelection } from './usage-period';

const firstDate = '1970-01-01';
const shortLabels = { month: '1 mo', quarter: '3 mo', half: '6 mo' } as const;

export function UsageDisclosure(props: {
  class: string; panelClass: string; active: boolean; alignEnd?: boolean; scrollFocusable?: boolean;
  label: string; title?: string; summary: JSX.Element;
  onToggle?: (open: boolean) => void;
  children: (close: () => void, focusTrigger: () => void) => JSX.Element;
}) {
  let disclosure!: HTMLDetailsElement;
  let trigger!: HTMLElement;
  let panel!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const focusTrigger = () => trigger.focus({ preventScroll: true });
  const close = () => {
    disclosure.open = false;
    focusTrigger();
  };
  createEffect(() => { if (!props.active) disclosure.open = false; });

  createEffect(() => {
    if (!open()) return;
    const position = () => {
      const anchor = trigger.getBoundingClientRect();
      const { clientWidth: width, clientHeight: height } = document.documentElement;
      if (!anchor.width || anchor.bottom <= 0 || anchor.top >= height) {
        disclosure.open = false;
        return;
      }
      const gap = 6, edge = 8;
      const below = height - anchor.bottom - gap - edge;
      const above = anchor.top - gap - edge;
      const flip = below < 220 && above > below;
      const left = props.alignEnd ? anchor.right - panel.offsetWidth : anchor.left;
      panel.style.left = `${Math.max(edge, Math.min(left, width - panel.offsetWidth - edge))}px`;
      panel.style.top = flip ? 'auto' : `${anchor.bottom + gap}px`;
      panel.style.bottom = flip ? `${height - anchor.top + gap}px` : 'auto';
      panel.style.setProperty('--usage-menu-space', `${Math.max(0, flip ? above : below)}px`);
      panel.style.visibility = 'visible';
    };
    const outside = (event: Event) => {
      if (event.target instanceof Node && !disclosure.contains(event.target)) disclosure.open = false;
    };
    const scroll = (event: Event) => { if (event.target !== panel) position(); };
    position();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', position);
    onCleanup(() => {
      panel.style.visibility = '';
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', position);
    });
  });

  return <details ref={disclosure} class={props.class} on:toggle={event => {
    const expanded = event.currentTarget.open;
    setOpen(expanded);
    props.onToggle?.(expanded);
  }} onKeyDown={event => {
    if (event.key === 'Escape' && disclosure.open && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}>
    <summary ref={trigger} class="plain-button usage-toolbar-trigger" aria-label={props.label} title={props.title}>{props.summary}</summary>
    <div ref={panel} tabIndex={props.scrollFocusable ? 0 : undefined} class={`usage-toolbar-panel surface-card ${props.panelClass}`}>{props.children(close, focusTrigger)}</div>
  </details>;
}

export function UsageDateRangePicker(props: {
  selection: UsageDateSelection; range: ReturnType<typeof usageRange>; active: boolean; onChange: (selection: UsageDateSelection) => void;
}) {
  let fromInput: HTMLInputElement | undefined;
  const [custom, setCustom] = createSignal(false);
  const [from, setFrom] = createSignal('');
  const [to, setTo] = createSignal('');
  const [maxDate, setMaxDate] = createSignal(localDateInput(new Date()));
  const [dateError, setDateError] = createSignal('');
  const label = () => typeof props.selection === 'string' ? usageDatePresets.find(([id]) => id === props.selection)?.[1] : 'Custom';
  const shortLabel = () => {
    const id = props.selection;
    return id === 'month' || id === 'quarter' || id === 'half' ? shortLabels[id] : label();
  };
  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const exactRange = createMemo(() => props.selection === 'all' ? 'All recorded history' : dateFormat.formatRange(props.range.from, props.range.to - 1));

  createEffect(() => { if (custom()) fromInput?.focus(); });

  return <UsageDisclosure class="usage-date-options" panelClass="usage-date-menu" active={props.active}
    label={`Date range: ${label()}, ${exactRange()}`} title={exactRange()}
    summary={<><span class="usage-date-label">{label()}</span><span class="usage-date-short-label">{shortLabel()}</span><span class="usage-date-chevron" aria-hidden="true"/></>}
    onToggle={open => {
      if (open) setMaxDate(localDateInput(new Date()));
      else setCustom(false);
    }}>
    {(close, focusTrigger) => {
      const choose = (value: UsageDateSelection) => { props.onChange(value); close(); };
      return <>
        <div class="usage-toolbar-options" hidden={custom()}>
          <For each={usageDatePresets}>{([id, name]) => <button type="button" aria-pressed={props.selection === id} onClick={() => choose(id)}>{name}</button>}</For>
          <button type="button" class="usage-date-custom" aria-pressed={typeof props.selection !== 'string'} onClick={() => {
            setFrom(props.selection === 'all' ? '' : localDateInput(new Date(props.range.from)));
            setTo(localDateInput(new Date(props.range.to - 1)));
            setDateError('');
            setCustom(true);
          }}>Custom</button>
        </div>
        <Show when={custom()}><form class="usage-date-form" onSubmit={event => {
          event.preventDefault();
          const start = from(), end = to();
          if (!start || !end || start > end || end > maxDate() || start < firstDate) return;
          if ([start, end].some(value => localDateInput(parseLocalDate(value)) !== value)) {
            setDateError('One of these dates did not occur in your time zone. Choose another date.');
            return;
          }
          choose({ from: start, to: end });
        }}>
          <div class="usage-date-fields">
            <label>From<input ref={fromInput} type="date" required min={firstDate} max={to() || maxDate()} value={from()} onChange={event => { setFrom(event.currentTarget.value); setDateError(''); }}/></label>
            <label>To<input type="date" required min={from() || firstDate} max={maxDate()} value={to()} onChange={event => { setTo(event.currentTarget.value); setDateError(''); }}/></label>
          </div>
          <Show when={dateError()}><p role="alert">{dateError()}</p></Show>
          <div class="usage-date-actions">
            <button type="button" class="plain-button" onClick={() => {
              setCustom(false);
              focusTrigger();
            }}>Presets</button>
            <button type="submit" class="plain-button usage-date-apply">Apply</button>
          </div>
        </form></Show>
      </>;
    }}
  </UsageDisclosure>;
}
