import { batch, createEffect, createMemo, createSelector, createSignal, createUniqueId, For, Index, on, onCleanup, onMount, Show, type Setter } from 'solid-js';
import { agentName, countLabel, delegationGraph, delegationLayout, visibleCountLabel, type DelegationTreeNode } from './delegation-layout';
import type { UsageDelegationNode, UsageDelegations } from './usage-types';

export { delegationGraph, delegationLayout, delegationRadius } from './delegation-layout';

const fmt = (value: number) => value.toLocaleString('en-US');
const statusNames = ['pending', 'streaming', 'running', 'completed', 'error', 'unknown'] as const;
type Selection = { rootId: string; id: string; pinned: boolean } | null;
type Graph = ReturnType<typeof delegationGraph>;
type Point = Graph['nodes'][number];

export function DelegationDetails(props: { node: UsageDelegationNode }) {
  const statuses = createMemo(() => statusNames.filter(status => props.node.statuses[status] > 0));
  return <>
    <strong class="delegation-detail-name">{agentName(props.node)}</strong>
    <p>{`${fmt(props.node.attempts)} recorded ${props.node.countBasis} attempts`}</p>
    <Show when={statuses().length > 0}>
      <dl class="delegation-statuses"><For each={statuses()}>{status => <div><dt>{status}</dt><dd>{fmt(props.node.statuses[status])}</dd></div>}</For></dl>
    </Show>
    <Show when={props.node.contextOnly}><p>Context only · zero period attempts</p></Show>
  </>;
}

function DelegationTree(props: { root: DelegationTreeNode; maxAttempts: number; selection: Selection; setSelection: Setter<Selection> }) {
  let viewport!: HTMLDivElement;
  let card!: HTMLElement;
  let panel: HTMLDivElement | undefined;
  const anchors = new Map<string, SVGGElement>();
  const [availableWidth, setAvailableWidth] = createSignal(320);
  const graph = createMemo(() => delegationGraph(props.root, props.maxAttempts, availableWidth()));
  const points = createMemo(() => new Map(graph().nodes.map(point => [point.node.id, point])));
  const detailId = createUniqueId();
  const selection = createMemo(() => props.selection?.rootId === props.root.id ? props.selection : null);
  const activeId = createMemo(() => selection()?.id);
  const active = createMemo(() => {
    const id = activeId();
    return id === undefined ? undefined : points().get(id);
  });
  const isActive = createSelector(activeId);
  const isPinned = createSelector(() => selection()?.pinned ? activeId() : undefined);
  let restoreFocus = false;
  let focusDetails = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelClose = () => clearTimeout(closeTimer);
  const dismiss = () => {
    cancelClose();
    const current = selection();
    if (current && panel?.contains(document.activeElement)) {
      const trigger = anchors.get(current.id);
      restoreFocus = true;
      trigger?.focus({ preventScroll: true });
      trigger?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      restoreFocus = false;
    }
    props.setSelection(null);
  };
  const show = (id: string) => {
    cancelClose();
    const rootId = props.root.id;
    props.setSelection(current => current?.pinned || (current?.rootId === rootId && current.id === id) ? current : { rootId, id, pinned: false });
  };
  const leave = () => {
    cancelClose();
    closeTimer = setTimeout(() => props.setSelection(current => {
      if (current?.rootId !== props.root.id) return current;
      const focused = document.activeElement;
      return current.pinned || anchors.get(current.id) === focused || panel?.contains(focused) ? current : null;
    }), 150);
  };
  const toggle = (id: string, keyboard = false) => {
    cancelClose();
    focusDetails = keyboard;
    const rootId = props.root.id;
    props.setSelection(current => current?.rootId === rootId && current.id === id && current.pinned ? null : { rootId, id, pinned: true });
  };
  const focusPanel = (button: HTMLButtonElement) => {
    if (!focusDetails) return;
    button.focus({ preventScroll: true });
    focusDetails = false;
  };
  const register = (id: string, element: SVGGElement) => {
    anchors.set(id, element);
    onCleanup(() => anchors.delete(id));
  };
  onMount(() => {
    const measure = () => setAvailableWidth(viewport.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    onCleanup(() => observer.disconnect());
  });
  createEffect(on(() => props.root, () => {
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  }));
  createEffect(on(selection, current => {
    if (!current?.pinned) focusDetails = false;
    if (!current) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    const outside = (event: PointerEvent) => {
      const target = event.target;
      // A circle click is an explicit replacement action; let its click handle it.
      if (target instanceof Element && !panel?.contains(target) && !target.closest('.delegation-circle')) props.setSelection(null);
    };
    window.addEventListener('keydown', escape);
    window.addEventListener('pointerdown', outside);
    onCleanup(() => { cancelClose(); window.removeEventListener('keydown', escape); window.removeEventListener('pointerdown', outside); });
  }));
  onCleanup(cancelClose);

  return <section ref={card} class="surface-card delegation-root" aria-label={`Delegation tree: ${agentName(props.root)}`}>
    <div class="delegation-tree" ref={viewport}>
      <DelegationGraph graph={graph()} points={points()} name={agentName(props.root)} detailId={detailId} isActive={isActive} isPinned={isPinned} register={register}
        show={show} leave={leave} toggle={toggle} restoreFocus={() => restoreFocus} inPanel={target => panel?.contains(target) ?? false}/>
    </div>
    <Show when={active()}>{point => <DelegationPanel point={point()} pinned={isPinned(point().node.id)} id={detailId} card={() => card}
      anchor={id => anchors.get(id)} ref={element => {
        panel = element;
        onCleanup(() => { panel = undefined; });
      }} dismiss={dismiss} cancelClose={cancelClose} leave={leave} focusPanel={focusPanel}/>}</Show>
  </section>;
}

function DelegationGraph(props: {
  graph: Graph; points: Map<string, Point>; name: string; detailId: string;
  isActive: (id: string) => boolean; isPinned: (id: string) => boolean;
  register: (id: string, element: SVGGElement) => void;
  show: (id: string) => void; leave: () => void; toggle: (id: string, keyboard?: boolean) => void;
  restoreFocus: () => boolean; inPanel: (node: Node | null) => boolean;
}) {
  return <div class="delegation-canvas" style={{ width: `${props.graph.width}px` }}>
    <svg class="delegation-graph" width={props.graph.width} height={props.graph.height} role="group" aria-label={`${props.name} delegation graph`}>
      <g class="delegation-links" aria-hidden="true"><Index each={props.graph.links}>{link => <path d={link().path}/>}</Index></g>
      <For each={[...props.points.keys()]}>{id => {
        // Key by stable node id: resizing/reordering updates geometry without losing SVG focus.
        const point = () => props.points.get(id)!;
        const node = () => point().node;
        const radius = () => point().radius;
        const statuses = () => statusNames.map(status => `${status}: ${fmt(node().statuses[status] || 0)}`).join(', ');
        return <g ref={element => props.register(id, element)}
          class="delegation-node" classList={{ 'context-only': node().contextOnly, 'is-active': props.isActive(id) }}
          transform={`translate(${point().x} ${point().y})`} role="button" tabindex={0}
          aria-label={`${agentName(node())}; ${countLabel(node())} recorded attempts; ${node().contextOnly ? 'context only; ' : ''}ancestry ${node().ancestry}; ${statuses()}. Pin agent details.`}
          aria-pressed={props.isPinned(id)} aria-haspopup="dialog" aria-expanded={props.isActive(id)} aria-controls={props.isActive(id) ? props.detailId : undefined}
          onFocus={event => {
            if (props.restoreFocus()) return;
            event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            props.show(id);
          }}
          onBlur={event => { if (!props.inPanel(event.relatedTarget as Node | null)) props.leave(); }}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.toggle(id, true); } }}>
          <rect class="delegation-hit" x={-radius() - 7} y={-point().rowHeight / 2 + 4} width={point().hitRight + radius() + 7} height={point().rowHeight - 8} rx={8}/>
          <circle class="delegation-halo" r={radius() + 5}/>
          <circle class="delegation-circle" r={radius()} onPointerEnter={() => props.show(id)} onPointerLeave={props.leave} onClick={() => props.toggle(id)}/>
          <text aria-hidden="true" class="delegation-name"><Index each={point().lines}>{(line, i) =>
            <tspan x={point().labelX} y={point().labelTop + 13 + i * 16}>{line()}</tspan>}</Index></text>
          <text aria-hidden="true" class="delegation-count" x={point().labelX} y={point().labelTop + point().lines.length * 16 + 15}>{visibleCountLabel(node())}</text>
        </g>;
      }}</For>
    </svg>
  </div>;
}

function DelegationPanel(props: {
  point: Point; pinned: boolean; id: string; card: () => HTMLElement; anchor: (id: string) => SVGGElement | undefined;
  ref: (element: HTMLDivElement) => void; dismiss: () => void; cancelClose: () => void; leave: () => void; focusPanel: (button: HTMLButtonElement) => void;
}) {
  let panel!: HTMLDivElement;
  let close!: HTMLButtonElement;
  const [position, setPosition] = createSignal({ left: 0, top: 0, width: 232, maxHeight: 0 });
  createEffect(on(() => props.point, point => {
    const place = () => {
      const card = props.card();
      const anchor = props.anchor(point.node.id)?.querySelector('.delegation-circle')?.getBoundingClientRect();
      if (!anchor) return;
      const bounds = card.getBoundingClientRect();
      const visiblePane = card.closest('.usage-workspace-content')?.getBoundingClientRect();
      const minLeft = Math.max(8, bounds.left + 8);
      const maxRight = Math.min(window.innerWidth - 8, bounds.right - 8);
      const width = Math.min(232, Math.max(0, maxRight - minLeft));
      const beside = anchor.right + 12 + width <= maxRight || anchor.left - 12 - width >= minLeft;
      const preferredLeft = anchor.right + 12 + width <= maxRight ? anchor.right + 12 : beside ? anchor.left - 12 - width : anchor.left;
      const left = Math.max(minLeft, Math.min(preferredLeft, maxRight - width));
      const minTop = Math.max(8, bounds.top + 8, (visiblePane?.top ?? 0) + 8);
      const maxBottom = Math.min(window.innerHeight - 8, bounds.bottom - 8, (visiblePane?.bottom ?? window.innerHeight) - 8);
      const maxHeight = Math.max(0, maxBottom - minTop);
      let preferredTop = beside ? anchor.top : anchor.bottom + 8;
      if (!beside && preferredTop + panel.offsetHeight > maxBottom && anchor.top - panel.offsetHeight - 8 >= minTop) preferredTop = anchor.top - panel.offsetHeight - 8;
      const top = Math.max(minTop, Math.min(preferredTop, maxBottom - panel.offsetHeight));
      setPosition({ left, top, width, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    onCleanup(() => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); });
  }));
  createEffect(on([() => props.point, () => props.pinned, () => position().maxHeight], ([, pinned, maxHeight]) => {
    if (!pinned || !maxHeight) return;
    // Placement and visibility bindings may still be updating in this effect flush.
    let current = true;
    queueMicrotask(() => { if (current) props.focusPanel(close); });
    onCleanup(() => { current = false; });
  }));
  return <div ref={element => { panel = element; props.ref(element); }} id={props.id} role={props.pinned ? 'dialog' : 'tooltip'} aria-label="Agent details" class="delegation-detail surface-card"
    classList={{ 'delegation-detail-preview': !props.pinned }}
    style={{ left: `${position().left}px`, top: `${position().top}px`, width: `${position().width}px`, 'max-height': `${position().maxHeight}px`, visibility: position().maxHeight ? 'visible' : 'hidden' }}
    onPointerEnter={props.cancelClose} onPointerLeave={props.leave} onFocusIn={props.cancelClose} onFocusOut={props.leave}>
    <Show when={props.pinned}><button ref={close} class="delegation-close" aria-label="Close agent details" onClick={props.dismiss}>×</button></Show>
    <DelegationDetails node={props.point.node}/>
  </div>;
}

const noNodes: UsageDelegationNode[] = [];
export type MainAgentFilter = { id: string; label: string };

export function DelegationTrees(props: {
  delegations?: UsageDelegations;
  mainAgent?: MainAgentFilter;
  onMainAgentChange?: (agent: MainAgentFilter | undefined) => void;
}) {
  const nodes = createMemo(() => props.delegations?.nodes ?? noNodes);
  const layout = createMemo(() => delegationLayout(nodes()));
  const roots = createMemo(() => new Map(layout().roots.map(root => [root.id, root])));
  const [selection, setSelection] = createSignal<Selection>(null);
  const filter = () => props.mainAgent?.id;
  const mainAgents = createMemo(() => layout().roots.filter(root => root.role === 'main'));
  createEffect(on([nodes, filter], () => setSelection(null), { defer: true }));
  const ordered = createMemo(() => {
    const id = filter();
    if (id === undefined) return [...roots().keys()];
    return roots().has(id) ? [id] : [];
  });
  return <Show when={props.delegations} fallback={<p class="secondary">Delegation data is not available in this response yet. Restart Inspector if it was running before this update.</p>}>
    <Show when={props.onMainAgentChange && (mainAgents().length > 0 || props.mainAgent)}>
      <label class="delegation-agent-filter">Main agent <select onChange={event => {
        const root = roots().get(event.currentTarget.value);
        props.onMainAgentChange?.(root ? { id: root.id, label: agentName(root) } : undefined);
      }}>
        <option value="" selected={filter() === undefined}>All delegation trees</option>
        <Index each={mainAgents()}>{root => <option value={root().id} selected={filter() === root().id}>{agentName(root())}</option>}</Index>
        <Show when={props.mainAgent && !roots().has(props.mainAgent.id) ? props.mainAgent : undefined}>{agent =>
          <option value={agent().id} selected>{agent().label}</option>
        }</Show>
      </select></label>
    </Show>
    <Show when={ordered().length > 0}
      fallback={<p class="secondary">{props.mainAgent ? `No delegation paths for ${props.mainAgent.label} in this selection.`
        : nodes().length ? 'No attributed delegation paths to display in this period. Unattributed branches are hidden; recorded totals are unchanged.' : 'No delegation attempts or delegation context recorded in this period.'}</p>}>
      <div class="delegation-roots"><For each={ordered()}>{id => <DelegationTree root={roots().get(id)!} maxAttempts={layout().maxAttempts} selection={selection()} setSelection={setSelection}/>}</For></div>
    </Show>
    <Show when={props.delegations?.unlocatedAttempts}>{count =>
      <details class="delegation-diagnostics surface-card"><summary>{`${fmt(count())} unlocated attempts (snapshot-wide diagnostic)`}</summary><p>These records cannot be assigned to a period; this number is not a period count.</p></details>}
    </Show>
  </Show>;
}
