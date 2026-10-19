import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { compareContext, formatLimit } from '../src/model-capacity.js';
import { lookupModelCapacity } from '../server/model-capacities.js';
import { inspect } from '../server/parser.js';
import { EntryDetail } from '../src/App.js';

test('context comparison requires positive numeric limits on both sides', () => {
  assert.equal(compareContext(272000, 1050000), 'lower');
  assert.equal(compareContext(1050000, 1050000), 'equal');
  assert.equal(compareContext(2000000, 1050000), 'greater');
  for (const value of [undefined, null, '272000', {}, [], NaN, Infinity, -1, 0, 0.5]) {
    assert.equal(compareContext(value, 1050000), 'unknown');
    assert.equal(compareContext(272000, value), 'unknown');
    assert.match(formatLimit(value), /Unknown/);
  }
  assert.equal(formatLimit(272000), '272,000');
});

test('catalogue lookup uses exact provider and API model ID, never family or config limits', () => {
  for (const id of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-luna']) {
    const result = lookupModelCapacity('openai', id, { limit: { context: 272000 }, modelCapacity: { context: 1 } }, {});
    assert.equal(result?.context, 1050000);
    assert.equal(result?.model, id);
    assert.equal(result?.source.checked, '2026-10-15');
  }
  assert.equal(lookupModelCapacity('openai', 'friendly', { id: 'gpt-5.2' }, {})?.context, 400000);
  assert.equal(lookupModelCapacity('openai', 'gpt-6-sol', { id: 'gpt-5.2' }, {})?.context, 400000);
  for (const id of ['gpt-6-sol-preview', 'gpt-5.2-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex', 'gpt-5.1-codex-mini', 'toString']) {
    assert.equal(lookupModelCapacity('openai', id, {}, {}), undefined);
  }
  for (const id of [null, 42, '', 'unlisted']) assert.equal(lookupModelCapacity('openai', 'gpt-6-sol', { id }, {}), undefined);
  assert.equal(lookupModelCapacity('custom', 'gpt-6-sol', {}, {}), undefined);
  assert.equal(lookupModelCapacity('example', 'atlas-code', {}, {}), undefined);
  assert.equal(lookupModelCapacity('openai', 'gpt-6-sol', {}, { options: { baseURL: 'https://custom.test' } }), undefined);
  assert.equal(lookupModelCapacity('openai', 'gpt-6-sol', {}, { npm: 'custom-adapter' }), undefined);
});

test('parser separates allowlisted capacity from raw fields; Build and Models SSR show the comparison', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inspector-capacity-'));
  try {
    await writeFile(path.join(root, 'opencode.json'), JSON.stringify({
      model: 'openai/friendly', agent: { build: {} },
      provider: {
        openai: { options: { apiKey: 'never-capacity-secret' }, models: {
          friendly: { id: 'gpt-6.1-sol', limit: { context: 272000, input: 272000, output: 128000 }, modelCapacity: { context: 999, source: { url: 'https://untrusted.test' } } },
          unlisted: { limit: { context: 272000 }, modelCapacity: { context: 1050000 } },
        } },
        custom: { models: { 'gpt-6-sol': { limit: { context: 272000 } } } },
      },
    }));
    const snapshot = await inspect(root);
    assert.ok(!JSON.stringify(snapshot).includes('never-capacity-secret'));
    const model = snapshot.entries.find(e => e.id === 'openai/friendly')!;
    assert.equal(model.modelCapacity?.context, 1050000);
    assert.deepEqual(Object.keys(model.modelCapacity!).sort(), ['context', 'model', 'provider', 'source']);
    for (const id of ['openai/unlisted', 'custom/gpt-6-sol']) assert.equal(snapshot.entries.find(e => e.id === id)?.modelCapacity, undefined);
    const render = (entry: typeof model) => renderToStaticMarkup(createElement(EntryDetail, { entry, entries: snapshot.entries, choose() {} }));
    for (const entry of [snapshot.entries.find(e => e.id === 'build')!, model]) {
      const html = render(entry);
      assert.match(html, /Configured context<\/th><td role="cell" data-label="Value"><code>272,000<\/code>/);
      assert.match(html, /Model capacity<\/th><td role="cell" data-label="Value"><code>1,050,000<\/code>/);
      assert.match(html, /Capped below model capacity/);
      assert.match(html, /Models.dev.*checked 2026-10-15/);
      assert.match(html, /Configured input<\/th><td role="cell" data-label="Value"><code>272,000<\/code>/);
      assert.match(html, /Configured output<\/th><td role="cell" data-label="Value"><code>128,000<\/code>/);
      assert.doesNotMatch(html, /<details[^>]*\bopen(?:[\s=>])/);
      assert.equal((html.match(/>Configured context<\/th>/g) || []).length, 1);
    }
    assert.match(render(model), /<summary>Context limits<\/summary>/);
    for (const [context, message] of [[1050000, 'equal'], [2000000, 'greater'], [undefined, 'unknown'], ['bad', 'unknown']] as const) {
      model.data.limit.context = context;
      const html = render(model);
      assert.doesNotMatch(html, /Capped below model capacity/);
      assert.equal(html.includes('Configured context exceeds published model capacity'), message === 'greater');
    }
    const unknown = render(snapshot.entries.find(e => e.id === 'openai/unlisted')!);
    assert.match(unknown, /Model capacity<\/th><td role="cell" data-label="Value"><code>Unknown<\/code>/);
    assert.doesNotMatch(unknown, /Capped below model capacity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
