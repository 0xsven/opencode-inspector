import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App, EntryDetail } from '../src/App.js';
import { configuredTaskRules } from '../src/task-rules.js';
import type { Entry, Snapshot } from '../src/types.js';

const agent = (id: string, data: Entry['data'] = {}): Entry => ({ id, name: id, category: 'Agents', description: 'Full description. '.repeat(40) + 'Final sentence.', data, sources: [], provenance: {} });
const render = (entry: Entry, entries = [entry]) => renderToStaticMarkup(createElement(EntryDetail, { entry, entries, choose() {} }));

test('agent detail keeps full overview, removes duplicate disclosures, and retains raw permissions', () => {
  const entry = agent('build', { permission: { bash: 'ask', edit: 'deny' } });
  const html = render(entry);
  assert.equal(html.split(entry.description).length - 1, 1);
  assert.match(html, /class="overview-about" aria-label="About"/);
  assert.doesNotMatch(html, /data-section="(?:about|permissions|agent-rules)"/);
  assert.match(html, /data-section="raw-configuration"[\s\S]*&quot;bash&quot;: &quot;ask&quot;[\s\S]*&quot;edit&quot;: &quot;deny&quot;/);
  assert.doesNotMatch(html, /<details[^>]*\bopen[\s=>]/);
  const skill = { ...entry, category: 'Skills' as const };
  assert.match(render(skill), /data-section="about"><summary>About<\/summary><div class="section-content"><p>Full description/);
});

test('model table preserves settings, configured limits, published capacity and provenance', () => {
  const model: Entry = { ...agent('provider/long-model'), category: 'Models', data: { limit: { context: 100, input: 80, output: 20 } }, modelCapacity: { context: 200, provider: 'provider', model: 'long-model', source: { url: 'https://models.dev/api.json', checked: '2026-10-15', sha256: 'test' } } };
  const entry = { ...agent('build', { model: model.id, mode: 'all', variant: 'careful', reasoningEffort: 'high' }), provenance: { model: '/local/config.json → model', mode: '/local/agent.md → mode', variant: '/local/agent.md → variant' } };
  const html = render(entry, [entry, model]);
  const table = html.match(/<table[^>]*aria-label="Model and settings"[\s\S]*?<\/table>/)![0];
  assert.match(table, /^<table role="table"/);
  assert.match(table, /<tbody role="rowgroup"><tr role="row"><th role="rowheader" scope="row"/);
  for (const label of ['Setting', 'Value', 'Source']) assert.ok(table.includes(`<th role="columnheader" scope="col">${label}</th>`));
  for (const [key, value] of [['Model', model.id], ['Reasoning', 'high'], ['Variant', 'careful'], ['Mode', 'all'], ['Configured context', '100'], ['Model capacity', '200'], ['Configured input', '80'], ['Configured output', '20']]) {
    assert.ok(table.includes(`>${key}</th><td role="cell" data-label="Value"><code>${value}</code>`), key);
  }
  for (const text of ['Capped below model capacity', 'Configured · provider model', 'Published catalogue', 'checked 2026-10-15', 'Offline snapshot', 'Runtime support and enforcement are unknown.', '/local/config.json', '/local/agent.md']) assert.ok(table.includes(text), text);
  assert.match(render(agent('unknown')), /Mode<\/th><td role="cell" data-label="Value"><code>Unknown<\/code><\/td><td role="cell" data-label="Source">Unknown · not configured/);
});

test('subagent resolution includes deny, ask, unknown and last matching pattern without an accessible-name list', () => {
  const entry = agent('build', { effectivePermission: { task: { 'quick*': 'allow', quick: 'deny', visual: 'ask', broken: { invalid: true }, 'absent-*': 'allow' } } });
  const candidates = ['quick', 'quick-extra', 'visual', 'unknown', 'broken'].map(id => agent(id));
  const excluded = [agent('primary', { mode: 'primary' }), agent('disabled', { disable: true })];
  const html = render(entry, [entry, ...candidates, ...excluded]);
  const table = html.match(/<table[^>]*aria-label="Subagent rule resolution"[\s\S]*?<\/table>/)![0];
  for (const [id, decision, rule] of [['quick', 'deny', 'quick'], ['quick-extra', 'allow', 'quick*'], ['visual', 'ask — Requires approval', 'visual'], ['unknown', 'unknown', 'No matching configured rule'], ['broken', 'unknown', 'broken']]) {
    assert.ok(table.includes(`href="/agents/${id}"`), id);
    assert.ok(table.includes(`<td role="cell" data-label="Decision">${decision}</td><td role="cell" data-label="Matching rule"><code>${rule}</code>`), id);
  }
  assert.doesNotMatch(table, /href="\/agents\/(?:build|primary|disabled)"/);
  assert.doesNotMatch(html, /subagent-list|rule-list/);
  assert.match(html, /data-section="task-rules"><summary>Configured task rules/);
  const rules = html.match(/<table[^>]*aria-label="Configured task rules in matching order"[\s\S]*?<\/table>/)![0];
  assert.match(rules, />5<\/th><td role="cell" data-label="Pattern"><code>absent-\*<\/code><\/td><td role="cell" data-label="Action">allow/);
  assert.ok(rules.indexOf('quick*') < rules.indexOf('<code>quick</code>'));
  assert.match(html, /Unspecified runtime eligibility and task availability remain unknown/);
});

test('configured task rule display handles shorthand and malformed values safely', () => {
  assert.deepEqual(configuredTaskRules('ask'), [{ pattern: 'task shorthand', action: 'ask' }]);
  assert.deepEqual(configuredTaskRules({ task: 'deny' }), [{ pattern: 'task shorthand', action: 'deny' }]);
  assert.deepEqual(configuredTaskRules({ task: { '*': false, foo: 'invalid' } }), [{ pattern: '*', action: 'unknown' }, { pattern: 'foo', action: 'unknown' }]);
  for (const permission of [null, false, 42, {}, { task: [] }, { task: 42 }]) assert.deepEqual(configuredTaskRules(permission), []);
});

test('legacy agent queries open nothing; prompt rendered/raw routes and subagent keys still work', () => {
  const entry = { ...agent('build'), prompt: '**Prompt emphasis**\n\nLiteral body.' };
  const snapshot: Snapshot = { root: '/example', realpath: '/example', loadedAt: '2026-10-15', entries: [entry], warnings: [], theme: { selection: { name: null, source: 'fallback', detail: 'Test' }, palettes: [], warnings: [] } };
  const route = (query: string) => renderToStaticMarkup(createElement(App, { initialSnapshot: snapshot, initialRoute: `/agents/build?${query}` }));
  const legacy = route('open=about,permissions,agent-rules');
  assert.doesNotMatch(legacy, /<details[^>]*\bopen[\s=>]/);
  assert.match(legacy, /<strong>Prompt emphasis<\/strong>/);
  const raw = route('open=prompt&raw=1');
  assert.match(raw, /data-section="prompt" open=""/);
  assert.match(raw, /aria-pressed="true"[^>]*>Show Markdown/);
  assert.match(raw, /<pre>\*\*Prompt emphasis\*\*\n\nLiteral body\.<\/pre>/);
  assert.doesNotMatch(raw, /class="markdown"/);
  assert.match(route('open=subagents,task-rules'), /data-section="subagents" open=""/);
  assert.match(route('open=subagents,task-rules'), /data-section="task-rules" open=""/);
});
