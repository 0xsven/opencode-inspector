import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { UsageDelegationNode, UsageDelegations } from './usage-types';

const fmt = (value: number) => value.toLocaleString('en-US');
const statusNames = ['pending', 'streaming', 'running', 'completed', 'error', 'unknown'] as const;
type TreeNode = UsageDelegationNode & { children: TreeNode[] };
type Selection = { rootId: string; id: string; pinned: boolean } | null;

export function delegationLayout(nodes: UsageDelegationNode[]) {
  const byId = new Map(nodes.map(node => [node.id, { ...node, children: [] as TreeNode[] }]));
  const allRoots: TreeNode[] = [];
  for (const node of nodes) {
    const mapped = byId.get(node.id)!;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(mapped);
    else allRoots.push(mapped);
  }
  // Filter whole branches, never reparent descendants across an unattributed link.
  const attributed = (node: TreeNode) => Boolean(node.agent?.trim()) && node.role !== 'unknown';
  const roots = allRoots.filter(attributed);
  const pending = [...roots];
  let maxAttempts = 0;
  while (pending.length) {
    const node = pending.pop()!;
    maxAttempts = Math.max(maxAttempts, node.attempts);
    node.children = node.children.filter(attributed);
    pending.push(...node.children);
  }
  const rootRank = (node: TreeNode) => node.role !== 'main' ? 3 : node.agent?.toLowerCase() === 'plan' ? 0 : node.agent?.toLowerCase() === 'build' ? 1 : 2;
  roots.sort((a, b) => rootRank(a) - rootRank(b)
    || (rootRank(a) === 2 ? (a.agent || '').toLocaleLowerCase().localeCompare((b.agent || '').toLocaleLowerCase()) : 0));
  return { roots, maxAttempts };
}

const agentName = (node: UsageDelegationNode) => node.agent || (node.role === 'main' ? 'Unknown main agent' : node.role === 'unknown' ? 'Unknown root' : 'Unknown agent');
const countLabel = (node: UsageDelegationNode) => `${fmt(node.attempts)} ${node.countBasis}`;
const visibleCountLabel = (node: UsageDelegationNode) => `${countLabel(node)}${node.contextOnly ? ' · context' : ''}`;
function nameLines(name: string, limit: number) {
  const lines: string[] = [];
  let rest = Array.from(name);
  while (rest.length > limit) {
    const space = rest.slice(0, limit + 1).lastIndexOf(' ');
    const end = space > 0 ? space : limit;
    lines.push(rest.slice(0, end).join(''));
    rest = Array.from(rest.slice(end).join('').trimStart());
  }
  if (rest.length) lines.push(rest.join(''));
  return lines;
}

export function delegationRadius(node: UsageDelegationNode, maxAttempts: number) {
  return node.contextOnly ? 8 : Math.max(8, 32 * Math.sqrt(Math.max(0, node.attempts) / (maxAttempts || 1)));
}

/** Preorder rows trade sibling width for height, without scaling text or circles.
 * Very deep paths retain a readable minimum indent and can overflow horizontally.
 */
export function delegationGraph(root: TreeNode, maxAttempts: number, availableWidth = 320) {
  const nodes: Array<{ node: TreeNode; x: number; y: number; depth: number; radius: number; lines: string[]; bottom: number; rowHeight: number; labelX: number; labelTop: number; hitRight: number }> = [];
  const pending = [{ node: root, depth: 0 }];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    nodes.push({ node, depth, lines: [], x: 0, y: 0, radius: delegationRadius(node, maxAttempts), bottom: 0, rowHeight: 0, labelX: 0, labelTop: 0, hitRight: 0 });
    for (let i = node.children.length - 1; i >= 0; i--) pending.push({ node: node.children[i], depth: depth + 1 });
  }
  const maxDepth = Math.max(1, ...nodes.map(point => point.depth));
  const indent = Math.max(12, Math.min(28, Math.floor((availableWidth - 240) / maxDepth)));
  for (const point of nodes) point.x = 48 + point.depth * indent;
  const width = Math.max(240, availableWidth, ...nodes.map(point => point.x + point.radius + 12 + Math.max(104, visibleCountLabel(point.node).length * 7.5) + 16));
  let cursor = 8;
  for (const point of nodes) {
    point.labelX = point.radius + 12;
    const labelRoom = width - point.x - point.labelX - 16;
    // Conservative glyph width also accommodates wide uppercase and Unicode names.
    point.lines = nameLines(agentName(point.node), Math.max(8, Math.min(32, Math.floor(labelRoom / 13))));
    point.labelTop = -(point.lines.length * 16 + 18) / 2;
    point.rowHeight = Math.max(64, point.radius * 2 + 16, point.lines.length * 16 + 34);
    point.y = cursor + point.rowHeight / 2;
    point.bottom = cursor + point.rowHeight;
    point.hitRight = point.labelX + Math.max(...point.lines.map(line => Array.from(line).length * 13), visibleCountLabel(point.node).length * 7.5) + 8;
    cursor = point.bottom;
  }
  const byId = new Map(nodes.map(point => [point.node.id, point]));
  const links = nodes.filter(point => point.node.parentId && byId.has(point.node.parentId)).map(point => {
    const parent = byId.get(point.node.parentId!)!;
    const gutter = parent.x - 40;
    return { id: point.node.id, path: `M ${parent.x - parent.radius - 4} ${parent.y} Q ${gutter} ${parent.y} ${gutter} ${parent.y + 12} V ${point.y - 10} Q ${gutter} ${point.y} ${gutter + 10} ${point.y} H ${point.x - point.radius - 5}` };
  });
  return { nodes, links, width, height: cursor + 8 };
}

export function DelegationDetails({ node }: { node: UsageDelegationNode }) {
  const statuses = statusNames.filter(status => node.statuses[status] > 0);
  return <>
    <strong className="delegation-detail-name">{agentName(node)}</strong>
    <p>{fmt(node.attempts)} recorded {node.countBasis} attempts</p>
    {statuses.length > 0 && <dl className="delegation-statuses">{statuses.map(status => <div key={status}><dt>{status}</dt><dd>{fmt(node.statuses[status])}</dd></div>)}</dl>}
    {node.contextOnly && <p>Context only · zero period attempts</p>}
  </>;
}

const DelegationTree = memo(function DelegationTree({ root, maxAttempts, selection, setSelection }: { root: TreeNode; maxAttempts: number; selection: Selection; setSelection: Dispatch<SetStateAction<Selection>> }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(320);
  const graph = useMemo(() => delegationGraph(root, maxAttempts, availableWidth), [root, maxAttempts, availableWidth]);
  const card = useRef<HTMLElement>(null);
  const anchors = useRef(new Map<string, SVGGElement>());
  const panel = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const focusDetails = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 232, maxHeight: 400 });
  const detailId = useId();
  const isActive = selection?.rootId === root.id;
  const active = isActive ? graph.nodes.find(point => point.node.id === selection?.id) : undefined;
  const cancelClose = () => clearTimeout(closeTimer.current);
  const dismiss = () => {
    cancelClose();
    if (selection && panel.current?.contains(document.activeElement)) {
      const trigger = anchors.current.get(selection.id);
      restoreFocus.current = true;
      trigger?.focus({ preventScroll: true });
      trigger?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      restoreFocus.current = false;
    }
    setSelection(null);
  };
  const show = (id: string) => {
    cancelClose();
    setSelection(current => current?.pinned || (current?.rootId === root.id && current.id === id) ? current : { rootId: root.id, id, pinned: false });
  };
  const leave = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setSelection(current => {
      if (current?.rootId !== root.id) return current;
      const focused = document.activeElement;
      return current && (current.pinned || anchors.current.get(current.id) === focused || panel.current?.contains(focused)) ? current : null;
    }), 150);
  };
  const toggle = (id: string, keyboard = false) => {
    cancelClose();
    focusDetails.current = keyboard;
    setSelection(current => current?.rootId === root.id && current.id === id && current.pinned ? null : { rootId: root.id, id, pinned: true });
  };
  useEffect(() => {
    if (active && selection?.pinned && focusDetails.current && position.maxHeight) {
      panel.current?.querySelector('button')?.focus({ preventScroll: true });
      focusDetails.current = false;
    }
    if (!active || !selection?.pinned) focusDetails.current = false;
  }, [active, selection?.pinned, position.maxHeight]);
  useLayoutEffect(() => {
    const scroller = viewport.current;
    if (!scroller) return;
    const measure = () => setAvailableWidth(scroller.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!viewport.current) return;
    viewport.current.scrollLeft = 0;
    viewport.current.scrollTop = 0;
  }, [root]);
  useLayoutEffect(() => {
    if (!active) return;
    const place = () => {
      const anchor = anchors.current.get(active.node.id)?.querySelector('.delegation-circle')?.getBoundingClientRect();
      const bounds = card.current?.getBoundingClientRect();
      const popup = panel.current;
      if (!anchor || !bounds || !popup) return;
      const minLeft = Math.max(8, bounds.left + 8);
      const maxRight = Math.min(window.innerWidth - 8, bounds.right - 8);
      const width = Math.min(232, Math.max(0, maxRight - minLeft));
      const beside = anchor.right + 12 + width <= maxRight || anchor.left - 12 - width >= minLeft;
      const preferredLeft = anchor.right + 12 + width <= maxRight ? anchor.right + 12 : beside ? anchor.left - 12 - width : anchor.left;
      const left = Math.max(minLeft, Math.min(preferredLeft, maxRight - width));
      const minTop = Math.max(8, bounds.top + 8);
      const maxBottom = Math.min(window.innerHeight - 8, bounds.bottom - 8);
      const maxHeight = Math.max(0, maxBottom - minTop);
      let preferredTop = beside ? anchor.top : anchor.bottom + 8;
      if (!beside && preferredTop + popup.offsetHeight > maxBottom && anchor.top - popup.offsetHeight - 8 >= minTop) preferredTop = anchor.top - popup.offsetHeight - 8;
      const top = Math.max(minTop, Math.min(preferredTop, maxBottom - popup.offsetHeight));
      setPosition({ left, top, width, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [active]);
  useEffect(() => {
    if (!isActive) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      // A circle click is an explicit replacement action; let its click handle it.
      if (!panel.current?.contains(target) && !target.closest('.delegation-circle')) setSelection(null);
    };
    window.addEventListener('keydown', escape);
    window.addEventListener('pointerdown', outside);
    return () => { clearTimeout(closeTimer.current); window.removeEventListener('keydown', escape); window.removeEventListener('pointerdown', outside); };
  }, [selection, isActive]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  return <section ref={card} className="surface-card delegation-root" aria-label={`Delegation tree: ${agentName(root)}`}>
    <div className="delegation-tree" ref={viewport}>
      <div className="delegation-canvas" style={{ width: graph.width }}>
      <svg className="delegation-graph" width={graph.width} height={graph.height} role="group" aria-label={`${agentName(root)} delegation graph`}>
        <g className="delegation-links" aria-hidden="true">{graph.links.map(link => <path key={link.id} d={link.path}/>)}</g>
        {graph.nodes.map(point => {
          const { node, x, y, radius, lines } = point;
          const statuses = statusNames.map(status => `${status}: ${fmt(node.statuses[status] || 0)}`).join(', ');
          return <g key={node.id} ref={element => { if (element) anchors.current.set(node.id, element); else anchors.current.delete(node.id); }}
            className={`delegation-node${node.contextOnly ? ' context-only' : ''}${active?.node.id === node.id ? ' is-active' : ''}`}
            transform={`translate(${x} ${y})`} role="button" tabIndex={0}
            aria-label={`${agentName(node)}; ${countLabel(node)} recorded attempts; ${node.contextOnly ? 'context only; ' : ''}ancestry ${node.ancestry}; ${statuses}. Pin agent details.`}
            aria-pressed={isActive && selection?.id === node.id && selection.pinned} aria-haspopup="dialog" aria-expanded={active?.node.id === node.id} aria-controls={active?.node.id === node.id ? detailId : undefined}
            onFocus={event => {
              if (restoreFocus.current) return;
              event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              show(node.id);
            }}
            onBlur={event => { if (!panel.current?.contains(event.relatedTarget as Node)) leave(); }}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(node.id, true); } }}>
            <rect className="delegation-hit" x={-radius - 7} y={-point.rowHeight / 2 + 4} width={point.hitRight + radius + 7} height={point.rowHeight - 8} rx={8}/>
            <circle className="delegation-halo" r={radius + 5}/>
            <circle className="delegation-circle" r={radius} onPointerEnter={() => show(node.id)} onPointerLeave={leave} onClick={() => toggle(node.id)}/>
            <text aria-hidden="true" className="delegation-name">{lines.map((line, index) => <tspan key={index} x={point.labelX} y={point.labelTop + 13 + index * 16}>{line}</tspan>)}</text>
            <text aria-hidden="true" className="delegation-count" x={point.labelX} y={point.labelTop + lines.length * 16 + 15}>{visibleCountLabel(node)}</text>
          </g>;
        })}
      </svg>
      </div>
    </div>
    {active && <div ref={panel} id={detailId} role="dialog" aria-label="Agent details" className="delegation-detail surface-card" style={{ ...position, visibility: position.maxHeight ? 'visible' : 'hidden' }}
      onPointerEnter={cancelClose} onPointerLeave={leave} onFocus={cancelClose} onBlur={leave}>
      <button className="delegation-close" aria-label="Close agent details" onClick={dismiss}>×</button>
      <DelegationDetails node={active.node}/>
    </div>}
  </section>;
});

export function DelegationTrees({ delegations }: { delegations?: UsageDelegations }) {
  const { roots, maxAttempts } = useMemo(() => delegationLayout(delegations?.nodes ?? []), [delegations?.nodes]);
  const [selection, setSelection] = useState<Selection>(null);
  const [mainAgent, setMainAgent] = useState('');
  useLayoutEffect(() => setSelection(null), [roots]);
  if (!delegations) return <p className="secondary">Delegation data is not available in this response yet. Restart Inspector if it was running before this update.</p>;
  const mainRoots = roots.filter(node => node.role === 'main');
  const namedRoots = mainRoots.filter(node => node.agent !== null);
  const filter = namedRoots.some(root => root.id === mainAgent) ? mainAgent : '';
  const ordered = filter ? mainRoots.filter(root => root.id === filter) : [...mainRoots, ...roots.filter(node => node.role !== 'main')];
  return <>
    {namedRoots.length > 0 && <label className="delegation-agent-filter">Main agent <select value={filter} onChange={event => { setMainAgent(event.target.value); setSelection(null); }}>
      <option value="">All delegation trees</option>
      {namedRoots.map(root => <option key={root.id} value={root.id}>{agentName(root)}</option>)}
    </select></label>}
    {ordered.length ? <div className="delegation-roots">{ordered.map(root => <DelegationTree key={root.id} root={root} maxAttempts={maxAttempts} selection={selection} setSelection={setSelection}/>)}</div> : <p className="secondary">{delegations.nodes.length ? 'No attributed delegation paths to display in this period. Unattributed branches are hidden; recorded totals are unchanged.' : 'No delegation attempts or delegation context recorded in this period.'}</p>}
    {delegations.unlocatedAttempts > 0 && <details className="delegation-diagnostics surface-card"><summary>{fmt(delegations.unlocatedAttempts)} unlocated attempts (snapshot-wide diagnostic)</summary><p>These records cannot be assigned to a period; this number is not a period count.</p></details>}
  </>;
}
