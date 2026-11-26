import type { UsageDelegationNode } from './usage-types';

const fmt = (value: number) => value.toLocaleString('en-US');
export type DelegationTreeNode = UsageDelegationNode & { children: DelegationTreeNode[] };

export function delegationLayout(nodes: UsageDelegationNode[]) {
  const byId = new Map(nodes.map(node => [node.id, { ...node, children: [] as DelegationTreeNode[] }]));
  const allRoots: DelegationTreeNode[] = [];
  for (const node of nodes) {
    const mapped = byId.get(node.id)!;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(mapped);
    else allRoots.push(mapped);
  }
  // Filter whole branches, never reparent descendants across an unattributed link.
  const attributed = (node: DelegationTreeNode) => Boolean(node.agent?.trim()) && node.role !== 'unknown';
  const roots = allRoots.filter(attributed);
  const pending = [...roots];
  let maxAttempts = 0;
  while (pending.length) {
    const node = pending.pop()!;
    maxAttempts = Math.max(maxAttempts, node.attempts);
    node.children = node.children.filter(attributed);
    pending.push(...node.children);
  }
  const rootRank = (node: DelegationTreeNode) => node.role !== 'main' ? 3 : node.agent?.toLowerCase() === 'plan' ? 0 : node.agent?.toLowerCase() === 'build' ? 1 : 2;
  roots.sort((a, b) => rootRank(a) - rootRank(b)
    || (rootRank(a) === 2 ? (a.agent || '').toLocaleLowerCase().localeCompare((b.agent || '').toLocaleLowerCase()) : 0));
  return { roots, maxAttempts };
}

export const agentName = (node: UsageDelegationNode) => node.agent || (node.role === 'main' ? 'Unknown main agent' : node.role === 'unknown' ? 'Unknown root' : 'Unknown agent');
export const countLabel = (node: UsageDelegationNode) => `${fmt(node.attempts)} ${node.countBasis}`;
export const visibleCountLabel = (node: UsageDelegationNode) => `${countLabel(node)}${node.contextOnly ? ' · context' : ''}`;

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
export function delegationGraph(root: DelegationTreeNode, maxAttempts: number, availableWidth = 320) {
  const nodes: Array<{ node: DelegationTreeNode; x: number; y: number; depth: number; radius: number; lines: string[]; bottom: number; rowHeight: number; labelX: number; labelTop: number; hitRight: number }> = [];
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
