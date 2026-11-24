import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { inspect, markdown, mergePermission, taskPermission } from '../server/parser.js';
import { redact, redactText } from '../server/redact.js';
import { EntryDetail } from '../src/App.js';

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

test('native definitions, mixed precedence, ordered subagent rules and redacted references', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inspector-v2-'));
  try {
    await mkdir(path.join(root, 'agents'));
    await mkdir(path.join(root, 'plugins', 'local'), { recursive: true });
    await mkdir(path.join(root, 'plugins', 'discovered'));
    await writeFile(path.join(root, 'plugins/local/index.ts'), 'throw new Error("must not run")');
    await writeFile(path.join(root, 'plugins/discovered/server.ts'), 'throw new Error("must not run either")');
    await writeFile(path.join(root, 'opencode.json'), JSON.stringify({
      agents: {
        build: {
          system: 'Use the native prompt.',
          model: 'openai/friendly#careful',
          request: { headers: { 'X-Custom': 'never-agent-header' }, body: { nested: { sig: 'never-agent-body' } } },
          permissions: [{ action: 'subagent', resource: 'team/*', effect: 'allow' }],
        },
        'team/reviewer': { mode: 'subagent', disable: true, disabled: false },
        'team/disabled': { mode: 'subagent', disabled: true },
      },
      agent: { build: { prompt: 'Outdated V1 prompt.' }, legacy: { prompt: 'Still visible' } },
      commands: { review: { template: 'Native command', model: 'openai/friendly#careful', subagent: false } },
      command: { review: { template: 'Legacy command', subtask: true } },
      providers: { openai: { settings: { apiKey: 'never-provider-key', reasoningEffort: 'medium', arbitraryPackageOption: 'never-provider-option' }, models: {
        friendly: { modelID: 'gpt-6.1-sol', limit: { context: 272000 }, settings: { sig: 'never-model-setting' },
          body: { sig: 'never-model-body' }, variants: [
          { id: 'careful', settings: { reasoningEffort: 'high', sig: 'never-variant-setting' }, body: { sig: 'never-variant-body' }, headers: { 'X-Custom': 'never-variant-header' } },
        ] },
      } } },
      provider: { openai: { api: 'https://old-endpoint.test', models: { friendly: { id: 'bad-id' } } } },
      permissions: [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'subagen?', resource: 'team/*', effect: 'ask' },
        { action: 'read', resource: '*', effect: 'allow' },
      ],
      permission: { task: 'allow' },
      mcp: {
        servers: {
          shared: { type: 'remote', url: 'https://example.test?sig=never-mcp-sig&X-Amz-Signature=never-mcp-aws&view=1', disabled: true,
            headers: { 'X-Custom': 'never-mcp-header' }, timeout: { execution: 45000 } },
        },
        timeout: { catalog: 30000, startup: 10000 },
        shared: { type: 'local', command: ['outdated'] },
        legacy: { type: 'local', command: ['kept'], timeout: 60000 },
        ignored: { enabled: false },
      },
      plugin: [['legacy-plugin', { secret: 'never-plugin-option' }]],
      plugins: [{ package: './plugins/local', options: { custom: 'never-plugin-option' } }, { package: '@team/plugin' }],
    }));
    await writeFile(path.join(root, 'opencode.jsonc'), '{"permissions":[{"action":"subagent","resource":"team/*","effect":"deny"}]}');
    await writeFile(path.join(root, 'agents/build.md'), '---\npermissions:\n  - { action: "sub*", resource: "team/reviewer", effect: ask }\npermission:\n  task: deny\n---\nNative Markdown wins.');
    const snapshot = await inspect(root);
    const get = (category: string, id: string) => snapshot.entries.find(e => e.category === category && e.id === id)!;
    const build = get('Agents', 'build');
    assert.equal(build.prompt, 'Native Markdown wins.');
    assert.equal(build.data.system, 'Use the native prompt.');
    assert.equal(build.data.request.body, '[REDACTED]');
    assert.equal(get('Agents', 'legacy').prompt, 'Still visible');
    assert.equal(get('Commands', 'review').prompt, 'Native command');
    assert.equal(get('Commands', 'review').data.subagent, false);
    assert.equal(get('Models', 'openai/friendly').modelCapacity?.model, 'gpt-6.1-sol');
    assert.deepEqual(snapshot.entries.filter(e => e.category === 'MCP Servers').map(e => e.id).sort(), ['legacy', 'shared']);
    assert.equal(get('MCP Servers', 'shared').data.type, 'remote');
    assert.equal(get('MCP Servers', 'shared').data.disabled, true);
    assert.deepEqual(get('MCP Servers', 'shared').data.configuredTimeout, { startup: 10000, catalog: 30000, execution: 45000 });
    assert.deepEqual(get('MCP Servers', 'legacy').data.configuredTimeout, { startup: 10000, catalog: 60000, execution: 60000 });
    assert.equal(new URL(get('MCP Servers', 'shared').data.url).searchParams.get('view'), '1');
    assert.deepEqual(snapshot.entries.filter(e => e.category === 'Plugins').map(e => e.id), ['legacy-plugin', './plugins/local', '@team/plugin', './plugins/discovered']);
    assert.match(get('Plugins', './plugins/local').sources.at(-1)!.kind, /not loaded/);
    assert.ok(!JSON.stringify(snapshot).includes('never-'));
    assert.deepEqual(build.data.effectivePermission.map((rule: { effect: string }) => rule.effect), ['allow', 'deny', 'ask', 'deny', 'allow', 'ask']);
    assert.equal(taskPermission(build.data.effectivePermission, 'team/reviewer').action, 'ask');
    assert.equal(taskPermission(build.data.effectivePermission, 'team/other').action, 'allow');
    assert.equal(taskPermission(build.data.effectivePermission, 'other').action, 'deny');
    const html = renderToStaticMarkup(createElement(EntryDetail, { entry: build, entries: snapshot.entries, choose() {} }));
    assert.match(html, /href="\/models\/openai%2Ffriendly">openai\/friendly#careful/);
    assert.match(html, /careful · high effort/);
    assert.match(html, /sub\*: team\/reviewer/);
    assert.doesNotMatch(html, /href="[^"]*team%2Fdisabled"/);
    const mcpHtml = renderToStaticMarkup(createElement(EntryDetail, { entry: get('MCP Servers', 'shared'), entries: snapshot.entries, choose() {} }));
    assert.match(mcpHtml, /Configured MCP timeouts/);
    assert.match(mcpHtml, /45,000/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('V2 layers reset disabled agents, follow agent directory order, and replace model selections', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inspector-v2-layers-'));
  try {
    for (const folder of ['agent', 'agents', 'mode', 'modes']) await mkdir(path.join(root, folder));
    const deny = { action: 'subagent', resource: 'probe', effect: 'deny' };
    await writeFile(path.join(root, 'opencode.json'), JSON.stringify({
      agents: {
        order: { description: 'inline' },
        selector: { model: { providerID: 'openai', model: 'example', variant: 'shared' } },
        recreateInline: { description: 'stale inline', system: 'old inline body', permissions: [deny] },
        recreateFile: { description: 'stale file', permissions: [deny] },
      },
      providers: { openai: { models: { example: { variants: [
        { id: 'shared', settings: { reasoningEffort: 'high' } }, { id: 'retained', settings: { reasoningEffort: 'low' } },
      ] } } } },
    }));
    await writeFile(path.join(root, 'opencode.jsonc'), JSON.stringify({
      agents: {
        selector: { model: { providerID: 'openai', model: 'example' } },
        recreateInline: { disabled: true },
        absent: { disabled: true },
      },
      providers: { openai: { models: { example: { variants: [
        { id: 'shared', body: { temperature: 0.5 } }, { id: 'added', settings: { reasoningEffort: 'medium' } },
      ] } } } },
    }));
    for (const folder of ['agent', 'agents', 'mode', 'modes']) {
      await writeFile(path.join(root, folder, 'order.md'), `---\ndescription: ${folder}\n---\n${folder} body`);
    }
    await writeFile(path.join(root, 'agent/recreateInline.md'), 'Fresh after inline removal');
    await writeFile(path.join(root, 'agents/recreateFile.md'), '---\ndisabled: true\n---\nThis definition is removed');
    await writeFile(path.join(root, 'mode/recreateFile.md'), 'Fresh after file removal');
    const { entries } = await inspect(root);
    const get = (id: string) => entries.find(entry => entry.id === id)!;
    const order = get('order');
    assert.equal(order.prompt, 'modes body');
    assert.equal(order.description, 'modes');
    assert.equal(order.data.mode, 'primary');
    assert.deepEqual(order.sources.slice(1).map(source => path.basename(path.dirname(source.path))), ['agent', 'agents', 'mode', 'modes']);
    assert.equal(get('absent'), undefined);
    for (const id of ['recreateInline', 'recreateFile']) {
      const entry = get(id);
      assert.match(entry.prompt!, /^Fresh/);
      assert.equal(entry.description, '');
      assert.equal(entry.data.system, undefined);
      assert.equal(entry.data.permissions, undefined);
      assert.equal(taskPermission(entry.data.effectivePermission, 'probe').action, 'unknown');
      assert.equal(entry.sources.length, 1);
    }
    assert.deepEqual(get('selector').data.model, { providerID: 'openai', model: 'example' });
    const variants = get('openai/example').data.variants;
    assert.deepEqual(variants.map((variant: { id: string }) => variant.id), ['shared', 'retained', 'added']);
    assert.equal(variants[0].settings.reasoningEffort, 'high');
    assert.equal(variants[0].body, '[REDACTED]');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mixed permissions keep legacy wildcard and tools denies before native exceptions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inspector-v2-permissions-'));
  try {
    await writeFile(path.join(root, 'opencode.json'), JSON.stringify({
      permission: { '*': { 'team/*': 'deny' } },
      permissions: [{ action: 'subagent', resource: 'team/allowed', effect: 'allow' }],
      agent: { mixed: { permission: { task: { 'legacy/*': 'deny' } } } },
      agents: {
        build: { tools: { task: false }, permissions: [{ action: 'sub*', resource: 'local', effect: 'ask' }] },
        mixed: { permissions: [{ action: 'subagent', resource: 'legacy/allowed', effect: 'allow' }] },
      },
    }));
    const { entries } = await inspect(root);
    const permission = (agent: string, id: string) => taskPermission(entries.find(entry => entry.id === agent)?.data.effectivePermission, id).action;
    assert.equal(permission('mixed', 'team/other'), 'deny');
    assert.equal(permission('mixed', 'team/allowed'), 'allow');
    assert.equal(permission('mixed', 'legacy/other'), 'deny');
    assert.equal(permission('mixed', 'legacy/allowed'), 'allow');
    assert.equal(permission('build', 'other'), 'deny');
    assert.equal(permission('build', 'local'), 'ask');
  } finally { await rm(root, { recursive: true, force: true }); }
});
