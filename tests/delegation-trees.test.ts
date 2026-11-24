import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DelegationDetails, DelegationTrees, delegationGraph, delegationLayout, delegationRadius } from '../src/DelegationTrees.js';
import type { UsageDelegationNode, UsageDelegations } from '../src/usage-types.js';

const statuses = { pending: 0, streaming: 0, running: 0, completed: 0, error: 0, unknown: 0 };
function node(id: string, agent: string | null, parentId: string | null, attempts: number, options: Partial<UsageDelegationNode> = {}): UsageDelegationNode {
  return { id, agent, parentId, attempts, role: parentId ? 'subagent' : 'main', countBasis: parentId ? 'incoming' : 'outgoing', statuses: { ...statuses, completed: attempts }, contextOnly: attempts === 0, ancestry: 'verified', ...options };
}
const dto = (nodes: UsageDelegationNode[]): UsageDelegations => ({ metric: 'recorded-attempts', timeBasis: 'creation', totalAttempts: 12, unlocatedAttempts: 1, warnings: ['Some ancestry is unknown.'], nodes });

test('delegation layout uses visible shared maximum and stable Plan/Build/main root order', () => {
  const data = dto([
    node('z', 'Zeta', null, 1), node('b', 'build', null, 9), node('u', null, null, 1, { role: 'unknown' }),
    node('a', 'Alpha', null, 2), node('p', 'plan', null, 12), node('c', 'child', 'p', 3),
  ]);
  const { roots, maxAttempts } = delegationLayout(data.nodes);
  assert.equal(maxAttempts, 12);
  assert.deepEqual(roots.map(root => root.agent), ['plan', 'build', 'Alpha', 'Zeta']);
  assert.equal(roots[0].children[0].agent, 'child');
  assert.ok(Math.abs(delegationRadius(data.nodes[1], maxAttempts) ** 2 / delegationRadius(data.nodes[5], maxAttempts) ** 2 - 3) < 1e-12);
  assert.equal(delegationRadius(node('small', 'small', null, 1), 1000), 8);
  assert.equal(delegationRadius(node('context', 'old', null, 0), 1000), 8);
});

test('SVG markup retains attributed nodes, accessible actions, exact external counts and trailing diagnostics', () => {
  const html = renderToStaticMarkup(createElement(DelegationTrees, { delegations: dto([
    node('root', 'build', null, 2), node('context', 'old-agent', 'root', 0),
    node('child', 'child', 'context', 1, { ancestry: 'unknown' }),
  ]) }));
  assert.match(html, /<svg class="delegation-graph"/);
  assert.equal((html.match(/role="button"/g) || []).length, 3);
  assert.equal((html.match(/<path /g) || []).length, 2);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /0 incoming · context/);
  assert.match(html, />child</);
  assert.match(html, /ancestry unknown/);
  assert.match(html, /2 outgoing/);
  assert.match(html, /1 incoming/);
  assert.match(html, /snapshot-wide diagnostic/);
  assert.doesNotMatch(html, /Some ancestry is unknown/);
  assert.doesNotMatch(html, /<title|<figure|delegation-branch/);
  assert.doesNotMatch(html, />verified</);
  assert.doesNotMatch(html, /delegation-explainer/);
  assert.doesNotMatch(html, /delegation-hint|Hover or focus for details/);
  assert.ok(html.indexOf('delegation-diagnostics') > html.indexOf('</svg>'));
});

test('unattributed branches are removed before layout and scale without promoting descendants or changing DTO counts', () => {
  const data = dto([
    node('p', 'Plan', null, 12), node('known', 'explore', 'p', 3),
    node('missing', null, 'p', 50), node('beneath-missing', 'hidden-child', 'missing', 100),
    node('unknown-role', 'untrusted-root', null, 200, { role: 'unknown' }),
    node('beneath-role', 'also-hidden', 'unknown-role', 300),
    node('whitespace', '  ', null, 400),
    node('nested-role', 'untrusted-child', 'p', 500, { role: 'unknown' }),
    node('nested-descendant', 'still-hidden', 'nested-role', 600),
  ]);
  const original = structuredClone(data);
  const { roots, maxAttempts } = delegationLayout(data.nodes);
  assert.equal(maxAttempts, 12);
  assert.deepEqual(roots.map(root => root.id), ['p']);
  assert.deepEqual(delegationGraph(roots[0], maxAttempts).nodes.map(point => point.node.id), ['p', 'known']);
  const html = renderToStaticMarkup(createElement(DelegationTrees, { delegations: data }));
  assert.equal((html.match(/role="button"/g) || []).length, 2);
  assert.match(html, /12 outgoing/);
  assert.doesNotMatch(html, /hidden-child|untrusted-root|also-hidden|untrusted-child|still-hidden/);
  assert.deepEqual(data, original);
});

test('responsive preorder rows preserve hierarchy and sibling order without overlapping labels', () => {
  const { roots, maxAttempts } = delegationLayout([
    node('p', 'Plan', null, 10), node('a', 'a-very-long-agent-name-that-needs-multiple-lines', 'p', 4),
    node('b', 'B', 'p', 6), node('c', 'C', 'a', 2), node('d', 'D', 'a', 2),
  ]);
  for (const width of [270, 340, 559]) {
    const graph = delegationGraph(roots[0], maxAttempts, width);
    assert.equal(graph.width, width);
    assert.deepEqual(graph.nodes.map(point => point.node.id), ['p', 'a', 'c', 'd', 'b']);
    const points = new Map(graph.nodes.map(point => [point.node.id, point]));
    assert.equal(points.get('a')!.lines.join(''), points.get('a')!.node.agent);
    for (let i = 0; i < graph.nodes.length; i++) {
      const point = graph.nodes[i];
      assert.ok(point.labelX > point.radius);
      assert.ok(point.x - point.radius - 7 >= 0);
      assert.ok(point.x + point.hitRight <= graph.width);
      assert.equal(point.radius, delegationRadius(point.node, maxAttempts));
      if (i) assert.ok(point.y - point.rowHeight / 2 >= graph.nodes[i - 1].bottom);
      if (point.node.parentId) {
        const parent = points.get(point.node.parentId)!;
        assert.ok(point.x > parent.x && point.y > parent.y);
      }
    }
  }
});

test('many siblings grow vertically, while very deep paths retain a readable overflow fallback', () => {
  const broad = delegationLayout([node('p', 'Build', null, 156), ...Array.from({ length: 30 }, (_, i) => node(String(i), 'quick-build', 'p', 5))]);
  for (const width of [270, 340, 559]) {
    const graph = delegationGraph(broad.roots[0], broad.maxAttempts, width);
    assert.equal(graph.width, width);
    assert.equal(graph.nodes.length, 31);
    assert.equal(graph.links.length, 30);
    assert.ok(graph.height > 480);
    assert.equal(graph.nodes[0].radius, 32);
  }
  const deep = delegationLayout(Array.from({ length: 33 }, (_, i) => node(String(i), 'deep-build', i ? String(i - 1) : null, 5)));
  const graph = delegationGraph(deep.roots[0], deep.maxAttempts, 270);
  assert.ok(graph.width > 270);
  assert.equal(graph.nodes.length, 33);
  assert.equal(graph.links.length, 32);
  for (let i = 1; i < graph.nodes.length; i++) {
    assert.ok(graph.nodes[i].x - graph.nodes[i - 1].x >= 12);
    assert.equal(graph.nodes[i].radius, 32);
    assert.ok(graph.nodes[i].x + graph.nodes[i].hitRight <= graph.width);
  }
});

test('broad and deep 2000-node trees retain every node without recursive rendering or text shrinking', () => {
  for (const deep of [false, true]) {
    const data = Array.from({ length: 2000 }, (_, i) => node(String(i), `Agent ${i}`, i ? String(deep ? i - 1 : 0) : null, 1));
    const { roots, maxAttempts } = delegationLayout(data);
    const graph = delegationGraph(roots[0], maxAttempts);
    assert.equal(graph.nodes.length, 2000);
    assert.equal(graph.links.length, 1999);
    assert.ok(Number.isFinite(graph.width) && Number.isFinite(graph.height));
    assert.equal(new Set(graph.nodes.map(point => `${point.x},${point.y}`)).size, 2000);
    const html = renderToStaticMarkup(createElement(DelegationTrees, { delegations: dto(data) }));
    assert.equal((html.match(/role="button"/g) || []).length, 2000);
  }
});

test('compact details show name, exact count and only nonzero statuses, including unknown', () => {
  const html = renderToStaticMarkup(createElement(DelegationDetails, { node: node('c', 'quick-build', 'p', 4, { ancestry: 'ambiguous', statuses: { ...statuses, error: 2, pending: 1, unknown: 1 } }) }));
  assert.match(html, />quick-build</);
  assert.match(html, /4 recorded incoming attempts/);
  assert.match(html, /<dt>error<\/dt><dd>2<\/dd>/);
  assert.match(html, /<dt>pending<\/dt><dd>1<\/dd>/);
  assert.match(html, /<dt>unknown<\/dt><dd>1<\/dd>/);
  assert.doesNotMatch(html, /<dt>completed<|<dt>streaming<|<dt>running</);
  assert.doesNotMatch(html, /Attribution:|Ancestry:|not necessarily|delegation-detail-hint|press Enter/);
  const context = renderToStaticMarkup(createElement(DelegationDetails, { node: node('old', 'old-agent', 'p', 0) }));
  assert.match(context, /0 recorded incoming attempts/);
  assert.match(context, /Context only · zero period attempts/);
  assert.doesNotMatch(context, /<dl/);
  const outgoing = renderToStaticMarkup(createElement(DelegationDetails, { node: node('r', 'Build', null, 5) }));
  assert.match(outgoing, /5 recorded outgoing attempts/);
  assert.match(outgoing, /<dt>completed<\/dt><dd>5<\/dd>/);
});

test('missing DTO and empty periods keep their distinct fallback messages', () => {
  assert.match(renderToStaticMarkup(createElement(DelegationTrees)), /not available in this response yet/);
  assert.match(renderToStaticMarkup(createElement(DelegationTrees, { delegations: dto([]) })), /No delegation attempts or delegation context recorded in this period/);
  const unattributed = renderToStaticMarkup(createElement(DelegationTrees, { delegations: dto([
    node('unknown', null, null, 2), node('child', 'named-child', 'unknown', 2),
  ]) }));
  assert.match(unattributed, /No attributed delegation paths to display/);
  assert.match(unattributed, /recorded totals are unchanged/);
  assert.doesNotMatch(unattributed, /No delegation attempts or delegation context recorded|<svg/);
  assert.match(unattributed, /snapshot-wide diagnostic/);
});
