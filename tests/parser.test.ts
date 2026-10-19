import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspect, markdown, mergePermission, taskPermission } from '../server/parser.js';
import { redact, redactText } from '../server/redact.js';

test('ordered wildcard task rules, shorthand, literal punctuation, and unknowns', () => {
  const permission = { task: { '*': 'deny', 'review*': 'allow', 'review-private': 'ask' } };
  assert.equal(taskPermission(permission, 'quick').action, 'deny');
  assert.equal(taskPermission(permission, 'review-code').action, 'allow');
  assert.equal(taskPermission(permission, 'review-private').action, 'ask');
  assert.equal(taskPermission('deny', 'quick').action, 'deny');
  assert.equal(taskPermission({ task: 'allow' }, 'quick').action, 'allow');
  assert.equal(taskPermission(undefined, 'quick').action, 'unknown');
  assert.equal(taskPermission({ task: { 'a.b': 'allow' } }, 'axb').action, 'unknown');
  assert.equal(taskPermission({ task: { 'agent-?': 'allow' } }, 'agent-a').action, 'allow');
  assert.equal(taskPermission({ task: { 'agent-?': 'allow' } }, 'agent-aa').action, 'unknown');
  assert.equal(taskPermission(mergePermission({ task: { quick: 'deny', '*': 'deny' } }, { task: { quick: 'allow' } }), 'quick').action, 'allow');
});

test('YAML frontmatter preserves a Markdown prompt', () => {
  const result = markdown('---\r\nmode: subagent\r\npermission:\r\n  task: deny\r\n---\r\n# Hello\nWorld');
  assert.equal(result.data.permission.task, 'deny'); assert.equal(result.prompt, '# Hello\nWorld');
  assert.deepEqual(markdown('plain text'), { data: {}, prompt: 'plain text' });
});

test('server redaction covers nested objects, environment, URL and prompt credentials', () => {
  const result = redact({ nested: { apiKey: 'hide-api', password: 'hide-password', authorization: 'hide-auth' }, environment: { CUSTOM_VALUE: 'hide-env' }, command: ['x', '--token', 'hide-flag'], url: 'https://person:hide-url@host/path?token=hide-query&view=1', prompt: 'api_key: hide-prompt\nBearer hide-bearer\nsk-abcdefghijklmn' });
  const serialized = JSON.stringify(result);
  for (const value of ['hide-api', 'hide-password', 'hide-auth', 'hide-env', 'hide-flag', 'hide-url', 'hide-query', 'hide-prompt', 'hide-bearer', 'sk-abcdefghijklmn']) assert.ok(!serialized.includes(value), value);
  assert.equal(result.environment.CUSTOM_VALUE, '[REDACTED]');
  assert.ok(redactText('--password hide-cli').includes('[REDACTED]'));
});

test('JSONC, symlink realpaths, merge priority and redaction in a complete snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inspector-test-'));
  try {
    await mkdir(path.join(root, 'real')); await mkdir(path.join(root, 'agents'));
    await writeFile(path.join(root, 'real/config.json'), '{"model":"demo/model","agent":{"build":{"variant":"inline","permission":{"task":{"*":"deny"}}}},"mcp":{"demo":{"env":{"CUSTOM":"never-send"}}}}');
    await symlink(path.join(root, 'real/config.json'), path.join(root, 'opencode.json'));
    await writeFile(path.join(root, 'opencode.jsonc'), '{ // comment\n"agent":{"build":{"variant":"jsonc",}},"command":{"review":{"agent":"general","description":"inline","template":"inline body"}},}');
    await mkdir(path.join(root, 'commands'));
    await writeFile(path.join(root, 'commands/review.md'), '---\ndescription: file wins\n---\nFile command body');
    await writeFile(path.join(root, 'real/build.md'), '---\nvariant: file\npermission:\n  task:\n    quick: allow\n---\nPassword: never-prompt');
    await symlink(path.join(root, 'real/build.md'), path.join(root, 'agents/build.md'));
    const snapshot = await inspect(root), build = snapshot.entries.find(e => e.id === 'build')!;
    assert.equal(build.data.variant, 'file'); assert.equal(build.data.model, 'demo/model');
    assert.equal(taskPermission(build.data.effectivePermission, 'quick').action, 'allow');
    assert.equal(build.sources[0].realpath, await realpath(path.join(root, 'real/config.json')));
    assert.equal(build.sources.at(-1)?.realpath, await realpath(path.join(root, 'real/build.md')));
    assert.ok(!JSON.stringify(snapshot).includes('never-send')); assert.ok(!JSON.stringify(snapshot).includes('never-prompt'));
    assert.match(build.provenance.model, /Inherited/);
    const commands = snapshot.entries.filter(e => e.category === 'Commands' && e.id === 'review');
    assert.equal(commands.length, 1); assert.equal(commands[0].description, 'file wins');
    assert.equal(commands[0].data.agent, 'general'); assert.equal(commands[0].prompt, 'File command body');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('representative demo includes all seven categories and Build delegation', async () => {
  const snapshot = await inspect(path.resolve('examples/demo'));
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(new Set(snapshot.entries.map(e => e.category)).size, 7);
  const build = snapshot.entries.find(e => e.category === 'Agents' && e.id === 'build')!;
  assert.equal(taskPermission(build.data.effectivePermission, 'quick').action, 'allow');
  assert.equal(taskPermission(build.data.effectivePermission, 'visual').action, 'ask');
  assert.equal(snapshot.entries.filter(e => e.category === 'Plugins').length, 2);
  assert.ok(build.prompt?.includes('Delegate deliberately'));
});

test('malformed config produces sanitized warnings without parser content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inspector-bad-'));
  try { await writeFile(path.join(root, 'opencode.json'), '{"password":"never-error", broken'); const snapshot = await inspect(root); assert.ok(snapshot.warnings.length); assert.ok(!JSON.stringify(snapshot).includes('never-error')); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('unsupported field types preserve raw data but cannot become names or prompt bodies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inspector-types-'));
  try {
    await writeFile(path.join(root, 'opencode.json'), JSON.stringify({
      permission: { task: null },
      agent: { build: { name: { toString: null }, model: 42, mode: {}, variant: [], description: false, prompt: {}, permission: { task: null } } },
      command: { review: { name: [], template: { body: 'unsupported' } } },
    }));
    const snapshot = await inspect(root);
    const build = snapshot.entries.find(e => e.category === 'Agents')!;
    const command = snapshot.entries.find(e => e.category === 'Commands')!;
    assert.equal(build.name, 'build'); assert.equal(build.description, ''); assert.equal(build.prompt, undefined);
    assert.equal(build.data.model, 42); assert.deepEqual(build.data.variant, []);
    assert.equal(command.name, 'review'); assert.equal(command.prompt, undefined);
    assert.equal(taskPermission(build.data.effectivePermission, 'quick').action, 'unknown');
    assert.equal(taskPermission({ task: { '*': { toString: null } } }, 'quick').action, 'unknown');
  } finally { await rm(root, { recursive: true, force: true }); }
});
