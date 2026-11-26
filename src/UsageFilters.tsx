import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, Show } from 'solid-js';

export function UsageFilters(props: {
  options: readonly { id: string; label: string }[];
  selected?: string;
  onChange: (id?: string) => void;
  active: boolean;
  buttonRef?: (button: HTMLButtonElement) => void;
}) {
  let trigger!: HTMLButtonElement;
  let panel!: HTMLDivElement;
  const panelId = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [search, setSearch] = createSignal('');
  const [searchFocused, setSearchFocused] = createSignal(false);
  const options = createMemo(() => new Map(props.options.map(option => [option.id, option.label])));
  const ids = createMemo(() => [...options().keys()]);
  const visibleIds = createMemo(() => {
    const query = search().trim().toLocaleLowerCase();
    return query ? ids().filter(id => options().get(id)!.toLocaleLowerCase().includes(query)) : ids();
  });
  const selectedLabel = () => options().get(props.selected ?? '') ?? 'All projects';
  const close = (restoreFocus = false) => {
    setOpen(false);
    setSearch('');
    setSearchFocused(false);
    if (restoreFocus) trigger.focus({ preventScroll: true });
  };
  createEffect(on(() => props.active, active => { if (!active) close(); }));

  const positionPanel = () => {
    const gap = 6, edge = 8;
    const anchor = trigger.getBoundingClientRect();
    const { clientWidth: width, clientHeight: height } = document.documentElement;
    if (anchor.bottom <= 0 || anchor.top >= height) {
      close();
      return;
    }
    const below = height - anchor.bottom - gap - edge;
    const above = anchor.top - gap - edge;
    const flip = below < 220 && above > below;
    panel.style.left = `${Math.max(edge, Math.min(anchor.left, width - panel.offsetWidth - edge))}px`;
    panel.style.maxHeight = `${Math.max(0, flip ? above : below)}px`;
    panel.style.top = flip ? 'auto' : `${anchor.bottom + gap}px`;
    panel.style.bottom = flip ? `${height - anchor.top + gap}px` : 'auto';
  };
  createEffect(on(() => props.selected, () => { if (open()) positionPanel(); }, { defer: true }));

  createEffect(on(open, expanded => {
    if (!expanded) return;
    positionPanel();
    const inside = (target: EventTarget | null) => target instanceof Node && (trigger.contains(target) || panel.contains(target));
    const outside = (event: Event) => { if (!inside(event.target)) close(); };
    const scroll = (event: Event) => { if (!inside(event.target)) positionPanel(); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', positionPanel);
    onCleanup(() => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', positionPanel);
    });
    (panel.querySelector<HTMLInputElement>('input[type="search"], input[type="radio"]:checked') ?? panel)
      .focus({ preventScroll: true });
  }));

  return <div class="usage-filters" onKeyDown={event => {
    if (open() && event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }}>
    <button ref={button => { trigger = button; props.buttonRef?.(button); }}
      type="button" class="plain-button usage-filter-trigger" aria-label={`Project filter: ${selectedLabel()}`} title={selectedLabel()}
      aria-expanded={open()} aria-controls={open() ? panelId : undefined}
      onClick={() => { if (open()) close(true); else if (props.active) setOpen(true); }}>
      <span class="usage-filter-trigger-label">{selectedLabel()}</span>
      <span class="usage-filter-chevron" aria-hidden="true"/>
    </button>
    <Show when={open()}>
      <div ref={panel} id={panelId} class="usage-filter-panel surface-card" role="group" aria-label="Projects" tabIndex={-1}>
        <div class="usage-filter-choices">
          <Show when={ids().length > 12 || search() || searchFocused()}>
            <input class="usage-filter-search" type="search" placeholder="Search projects" aria-label="Search projects"
              value={search()} onInput={event => setSearch(event.currentTarget.value)}
              onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)}/>
          </Show>
          <label class="usage-filter-value">
            <input type="radio" name={panelId} checked={props.selected === undefined} onChange={() => props.onChange()}/>
            <span>All projects</span>
          </label>
          <Show when={ids().length} fallback={<p>No projects available.</p>}>
            <For each={visibleIds()} fallback={<p>No matching projects.</p>}>{id =>
              <label class="usage-filter-value">
                <input type="radio" name={panelId} checked={props.selected === id} onChange={() => props.onChange(id)}/>
                <span>{options().get(id)}</span>
              </label>
            }</For>
          </Show>
        </div>
      </div>
    </Show>
  </div>;
}
