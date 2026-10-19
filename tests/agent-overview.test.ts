import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EntryDetail } from '../src/App.js';
import { resolveAgentSettings } from '../src/agent-settings.js';
import type { Entry } from '../src/types.js';
import { estimatePromptSize } from '../server/prompt-size.js';
import { inspect } from '../server/parser.js';
import { redactText } from '../server/redact.js';

const agent = (data = {}): Entry => ({ id: 'build', name: 'build', category: 'Agents', description: 'A short local description.', data, sources: [], provenance: {} });
const model: Entry = { ...agent(), category: 'Models', id: 'openai/gpt-6.1-sol', data: { limit: { context: 272000 }, variants: { careful: { reasoningEffort: 'high' } }, options: { reasoningEffort: 'low' }, providerOptions: { reasoningEffort: 'minimal' } }, modelCapacity: { provider: 'openai', model: 'gpt-6.1-sol', context: 1050000, source: { url: 'https://models.dev/api.json', checked: '2026-10-15', sha256: 'test' } } };
function render(entry: Entry, entries: Entry[] = [entry, model]) {
  return renderToStaticMarkup(createElement(EntryDetail, { entry, entries, choose() {} }));
}
const overview = (entry: Entry, entries?: Entry[]) => render(entry, entries).match(/<section class="agent-overview"[\s\S]*?<\/section>/)?.[0] || '';

test('agent overview presents all six requested values, configured cap and accessible subagent links', () => {
  const build = { ...agent({ model: model.id, reasoningEffort: 'medium', effectivePermission: { task: { '*': 'deny', quick: 'allow', visual: 'ask' } } }), prompt: 'Local prompt', promptSize: { count: 1234, approximate: true as const, encoding: 'o200k_base' as const } };
  const quick = { ...agent({ mode: 'subagent' }), id: 'quick', name: 'quick' };
  const visual = { ...quick, id: 'visual', name: 'visual' };
  const denied = { ...quick, id: 'denied', name: 'denied' };
  const html = overview(build, [build, model, quick, visual, denied]);
  const textContent = html.replace(/<[^>]*>/g, '');
  for (const text of ['Model', 'openai/gpt-6.1-sol', 'Reasoning variant', 'medium', 'Context limit', '272,000', 'Configured · Capped', 'A short local description.', 'Prompt length', '~1,234 tokens', 'Estimated · local prompt', 'Subagents (2)']) assert.ok(textContent.includes(text), text);
  assert.match(html, /href="\/models\/openai%2Fgpt-6.1-sol"/);
  assert.match(html, /href="\/agents\/quick"/);
  assert.match(html, /aria-label="Visual — requires approval"/);
  assert.doesNotMatch(html, /href="\/agents\/denied"/);
  assert.doesNotMatch(html, /<dd>1,050,000/);
  assert.doesNotMatch(html, /Read more|Read full About/);
  assert.doesNotMatch(render(build), /<details[^>]*\bopen[\s=>]/);
});

test('overview includes the complete About description without a read-more control', () => {
  const description = 'A longer explanation of this agent. '.repeat(30) + 'The final sentence is visible too.';
  const html = overview({ ...agent(), description });
  assert.ok(html.includes(description));
  assert.doesNotMatch(html, /Read more|Read full About/);
});

test('missing local prompt/model remains unknown and other categories have no overview', () => {
  const html = overview(agent());
  assert.match(html, /Model<\/dt><dd>Unknown/);
  assert.match(html, /Context limit<\/dt><dd><span[^>]*>Unknown/);
  assert.match(html, /Reasoning variant<\/dt><dd[^>]*><span[^>]*>Unknown/);
  assert.match(html, /Not available/);
  assert.match(html, /Built-in prompt unknown/);
  assert.doesNotMatch(html, /~0 tokens|Configured · Capped/);
  assert.doesNotMatch(render(model), /agent-overview/);
  const nativeOnly = { ...model, data: { ...model.data, limit: {} } };
  assert.match(overview(agent({ model: model.id }), [nativeOnly]), /Context limit<\/dt><dd><span[^>]*>Unknown/);
  assert.doesNotMatch(overview(agent({ model: model.id }), [nativeOnly]), /<dd>1,050,000|Configured · Capped/);
});

test('shared reasoning resolver retains priority and distinguishes named variant from effort', () => {
  const resolve = (data: Entry['data']) => resolveAgentSettings(agent({ model: model.id, ...data }), [model]);
  assert.equal(resolve({ reasoningEffort: 'medium', options: { reasoningEffort: 'high' }, variant: 'careful' }).reasoningLabel, 'careful · medium effort');
  assert.equal(resolve({ options: { reasoningEffort: 'medium' }, variant: 'careful' }).reasoning, 'medium');
  assert.equal(resolve({ variant: 'careful' }).reasoning, 'high');
  assert.equal(resolve({ variant: 'careful' }).reasoningSource, 'Inherited · variant careful');
  assert.equal(resolve({}).reasoningLabel, 'low');
  assert.equal(resolveAgentSettings(agent({ model: model.id }), [{ ...model, data: { providerOptions: { reasoningEffort: 'minimal' } } }]).reasoning, 'minimal');
  assert.equal(resolveAgentSettings(agent({ variant: 'high', reasoningEffort: 'high' }), []).reasoningLabel, 'high');
  assert.equal(resolveAgentSettings(agent({ reasoningEffort: 'medium' }), []).reasoningLabel, 'medium');
  const html = render(agent({ model: model.id, variant: 'careful', reasoningEffort: 'medium' }));
  assert.match(html, /careful · medium effort/);
  assert.match(html, /Reasoning<\/th><td role="cell" data-label="Value"><code>medium<\/code>/);
});

test('server tokenizer handles Unicode and literal special-token text; missing/oversize prompts are unknown', () => {
  assert.deepEqual(estimatePromptSize('hello world'), { count: 2, approximate: true, encoding: 'o200k_base' });
  assert.ok(estimatePromptSize('日本語 👩‍💻 <|endoftext|>')!.count > 0);
  for (const value of [undefined, null, {}, '', '   ', 'x'.repeat(2_000_001)]) assert.equal(estimatePromptSize(value), undefined);
  assert.ok(estimatePromptSize(('hello world\n').repeat(1000))!.count > 0);
});

test('parser counts the final local body before redaction and exposes only allowlisted metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inspector-prompt-'));
  const body = 'Read this local body.\npassword: ' + 'never-expose-'.repeat(30);
  try {
    await mkdir(path.join(root, 'agents'));
    await writeFile(path.join(root, 'opencode.json'), JSON.stringify({ agent: { build: { prompt: 'Inline body replaced by Markdown', promptSize: { count: 999999, encoding: 'untrusted', secret: 'never-metadata' } }, empty: {}, inline: { prompt: 'hello world' } } }));
    await writeFile(path.join(root, 'agents/build.md'), `---\nmode: primary\n---\n${body}`);
    await writeFile(path.join(root, 'AGENTS.md'), 'Global instructions excluded from estimate');
    const snapshot = await inspect(root);
    const build = snapshot.entries.find(entry => entry.id === 'build')!;
    assert.deepEqual(build.promptSize, estimatePromptSize(body));
    assert.notEqual(build.promptSize?.count, estimatePromptSize(redactText(body))?.count);
    assert.deepEqual(Object.keys(build.promptSize!).sort(), ['approximate', 'count', 'encoding']);
    assert.equal(typeof build.promptSize?.count, 'number');
    assert.equal(snapshot.entries.find(entry => entry.id === 'empty')?.promptSize, undefined);
    assert.equal(snapshot.entries.find(entry => entry.id === 'inline')?.promptSize?.count, 2);
    assert.doesNotMatch(JSON.stringify(snapshot), /never-expose-|never-metadata/);
    assert.match(build.prompt!, /\[REDACTED\]/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
