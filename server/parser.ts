import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJSON, type ParseError } from 'jsonc-parser';
import { parse as parseYAML } from 'yaml';
import type { Entry, Snapshot, Source, Value, Category } from '../src/types.js';
import { redact } from './redact.js';
import { discoverThemes } from './themes.js';
import { lookupModelCapacity } from './model-capacities.js';
import { estimatePromptSize } from './prompt-size.js';
import { permissionRules, subagentRules, type PermissionRule } from '../src/permissions.js';
export { taskPermission } from '../src/permissions.js';

const object = (v: any): Value => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const isObject = (v: unknown): v is Value => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeKey = (key: string) => !['__proto__', 'constructor', 'prototype'].includes(key);
const definitionsOf = (value: unknown) => Object.entries(object(value)).filter(([key, data]) => safeKey(key) && isObject(data));
export function merge(a: Value, b: Value): Value {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (!safeKey(k)) continue;
    delete out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(object(a[k]), v) : v;
  }
  return out;
}

// Native arrays are ordered and append across sources. Keep the legacy merge for
// an entirely V1 configuration; translate only the task rules needed for a mixed view.
function legacyTaskRules(permission: unknown): PermissionRule[] {
  const rules = typeof permission === 'string' ? { '*': permission } : object(permission);
  return subagentRules(Object.entries(rules).flatMap(([tool, rule]) =>
    Object.entries(typeof rule === 'string' ? { '*': rule } : object(rule))
      .map(([resource, effect]) => ({ action: tool === 'task' ? 'subagent' : tool, resource, effect }))));
}

function combinePermission(global: any, local: any) {
  if (!Array.isArray(global) && !Array.isArray(local)) return mergePermission(global, local);
  return [global, local].flatMap(value => Array.isArray(value) ? subagentRules(value) : legacyTaskRules(value));
}

function mergeDefinition(a: Value, b: Value, aliases: readonly (readonly [string, string, string])[]) {
  const result = merge(a, b);
  // A later spelling of a renamed field overrides the earlier spelling. Raw
  // configuration still uses the spelling of the contributing file.
  for (const [native, legacy, matches] of aliases) {
    if (typeof b[native] === matches) delete result[legacy];
    else if (typeof b[legacy] === matches) delete result[native];
  }
  return result;
}

const mergeAgent = (a: Value, b: Value, native: boolean) => {
  const result = mergeDefinition(a, b, [['system', 'prompt', 'string'], ['disabled', 'disable', 'boolean']]);
  if (Object.hasOwn(b, 'model')) {
    result.model = isObject(b.model) ? merge({}, b.model) : b.model;
    const selector = (value: unknown) => isObject(value) || typeof value === 'string' && value.includes('#');
    if (!Object.hasOwn(b, 'variant') && (native || selector(a.model) || selector(b.model))) delete result.variant;
  }
  if (Array.isArray(a.permissions) && Array.isArray(b.permissions)) result.permissions = [...a.permissions, ...b.permissions];
  return result;
};
const mergeCommand = (a: Value, b: Value) => mergeDefinition(a, b, [['subagent', 'subtask', 'boolean']]);
function mergeProvider(a: Value, b: Value): Value {
  const result = merge(a, b);
  for (const [id, model] of definitionsOf(b.models)) {
    const earlier = object(a.models)[id]?.variants;
    if (!Array.isArray(model.variants)) continue;
    const variants = new Map<string, Value>();
    for (const option of [...(Array.isArray(earlier) ? earlier : []), ...model.variants]) if (isObject(option) && typeof option.id === 'string' && option.id) {
      variants.set(option.id, merge(variants.get(option.id) || {}, option));
    }
    result.models[id].variants = [...variants.values()];
  }
  return result;
}

const configuredPermission = (data: Value) => {
  const native = permissionRules(data.permissions);
  const toolsDeny = data.tools?.task === false;
  const legacy = legacyTaskRules(data.permission);
  const ordered = native.length || Array.isArray(data.permissions) && !data.permissions.length
    || toolsDeny || typeof data.permission !== 'string' && legacy.some(rule => rule.action !== 'subagent');
  if (!ordered) return data.permission;
  return [
    ...(toolsDeny ? [{ action: 'subagent', resource: '*', effect: 'deny' }] : []),
    ...legacy,
    ...native,
  ];
};

// Request header values can be credentials even when their names don't look
// sensitive. Do not expose them in newly supported request settings.
function maskHeaders(value: Value): Value {
  return !Object.hasOwn(value, 'headers') ? value : { ...value, headers: isObject(value.headers)
    ? Object.fromEntries(Object.keys(value.headers).map(key => [key, '[REDACTED]'])) : '[REDACTED]' };
}

function requestProjection(value: Value, includeSettings = false): Value {
  return {
    ...(Object.hasOwn(value, 'headers') ? { headers: maskHeaders(value).headers } : {}),
    ...(Object.hasOwn(value, 'body') ? { body: '[REDACTED]' } : {}),
    ...(includeSettings && Object.hasOwn(value, 'settings') ? { settings: isObject(value.settings)
      ? typeof value.settings.reasoningEffort === 'string' ? { reasoningEffort: value.settings.reasoningEffort } : {}
      : '[REDACTED]' } : {}),
  };
}

// Additional signed/credential URL parameters not covered by the general
// redactor. Apply before it, without following URLs or resolving substitutions.
function maskSignedURLs(value: any): any {
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s<>"')]+/gi, raw => {
    try {
      const url = new URL(raw);
      const keys = [...url.searchParams.keys()].filter(key => /^(?:sig|signature|x-amz-signature|x-goog-signature|access[-_]?key(?:id)?|key|auth|jwt|code|client[-_]?assertion)$/i.test(key));
      for (const key of keys) url.searchParams.set(key, 'REDACTED');
      return keys.length ? url.toString() : raw;
    } catch { return raw; }
  });
  if (Array.isArray(value)) return value.map(maskSignedURLs);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, content]) => [key, maskSignedURLs(content)]));
  return value;
}

const timeoutKeys = ['startup', 'catalog', 'execution'] as const;
function timeouts(value: unknown, legacy = true): Value {
  const valid = (ms: unknown): ms is number => typeof ms === 'number' && Number.isSafeInteger(ms) && ms > 0;
  if (legacy && valid(value)) return { catalog: value, execution: value };
  const fields = object(value);
  return Object.fromEntries(timeoutKeys.filter(key => valid(fields[key])).map(key => [key, fields[key]]));
}
export function markdown(text: string): { data: Value; prompt: string } {
  const m = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  return m ? { data: object(parseYAML(m[1], { maxAliasCount: 50 })), prompt: m[2].trim() } : { data: {}, prompt: text.trim() };
}
export async function inspect(root: string): Promise<Snapshot> {
  root = path.resolve(root);
  const rootReal = await realpath(root);
  if (!(await stat(root)).isDirectory()) throw new Error('Invalid root');
  const warnings: string[] = [], entries: Entry[] = [];
  const source = async (p: string, kind: string): Promise<Source> => ({ path: p, realpath: await realpath(p), kind });
  async function text(p: string) { if ((await stat(p)).size > 2_000_000) throw new Error('File too large'); return readFile(p, 'utf8'); }
  async function list(p: string): Promise<string[]> { try { return (await readdir(p)).sort(); } catch (e: any) { if (e.code !== 'ENOENT') warnings.push(`Unable to list ${p}`); return []; } }
  let config: Value = {}, configSources: Source[] = [], globalPermission: any, mcpTimeout: Value = {};
  const settings = { Agents: new Map<string, Value>(), Commands: new Map<string, Value>(), Models: new Map<string, Value>(), 'MCP Servers': new Map<string, Value>() };
  const agentPermissions = new Map<string, any>();
  const agentSources = new Map<string, Source[]>();
  const plugins = new Map<string, Source | undefined>();
  function addPlugin(reference: unknown) {
    if (typeof reference !== 'string' || !reference) return;
    // HTTP(S) credentials are handled by snapshot redaction. Also mask userinfo
    // in Git package URLs using other schemes before using the string as an ID.
    plugins.set(reference.replace(/(\/\/)[^/\s@]*:[^/\s@]*@/g, '$1REDACTED@'), undefined);
  }
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const p = path.join(root, name);
    try {
      const errors: ParseError[] = [];
      const parsed = parseJSON(await text(p), errors, { allowTrailingComma: true });
      if (errors.length || !isObject(parsed)) throw new Error('Invalid config');
      const configSource = await source(p, 'config');
      configSources.push(configSource);
      config = merge(config, parsed);
      globalPermission = combinePermission(globalPermission, configuredPermission(parsed));
      for (const [category, legacy, native] of [['Agents', 'agent', 'agents'], ['Commands', 'command', 'commands'], ['Models', 'provider', 'providers']] as const) {
        // Native entries in a document win over the corresponding legacy
        // entry regardless of key order; distinct entries are kept.
        const legacyEntries = new Map(definitionsOf(parsed[legacy]));
        const nativeEntries = new Map(definitionsOf(parsed[native]));
        const doc = new Map([...legacyEntries, ...nativeEntries]);
        for (const [id, data] of doc) {
          if (category === 'Agents' && data.disabled === true) {
            settings.Agents.delete(id);
            agentPermissions.delete(id);
            agentSources.delete(id);
            continue;
          }
          const old = settings[category].get(id) || {};
          settings[category].set(id, category === 'Agents' ? mergeAgent(old, data, nativeEntries.has(id))
            : category === 'Commands' ? mergeCommand(old, data) : mergeProvider(old, data));
          if (category === 'Agents') {
            agentSources.set(id, [...agentSources.get(id) || [], configSource]);
            const earlier = nativeEntries.has(id) ? legacyEntries.get(id) : undefined;
            const paired = earlier ? combinePermission(configuredPermission(earlier), configuredPermission(data)) : configuredPermission(data);
            agentPermissions.set(id, combinePermission(agentPermissions.get(id), paired));
          }
        }
      }
      const mcp = object(parsed.mcp);
      // A legacy MCP server literally called "timeout" or "servers" still
      // has its own transport. Otherwise those keys are native containers.
      const hasTransport = (data: Value) => data.type === 'local' || data.type === 'remote';
      const legacyMcp = definitionsOf(mcp).filter(([id, data]) => hasTransport(data)
        || !['servers', 'timeout'].includes(id) && !(data.type === undefined && typeof data.enabled === 'boolean'));
      const nativeMcp = hasTransport(object(mcp.servers)) ? [] : definitionsOf(mcp.servers).filter(([, data]) => hasTransport(data));
      const legacyTimeout = parsed.experimental?.mcp_timeout;
      mcpTimeout = { ...mcpTimeout, ...(typeof legacyTimeout === 'number' ? timeouts(legacyTimeout) : {}),
        ...(!hasTransport(object(mcp.timeout)) ? timeouts(mcp.timeout, false) : {}) };
      for (const [id, data] of [...legacyMcp, ...nativeMcp]) settings['MCP Servers'].set(id, data);
      if (Array.isArray(parsed.plugin)) for (const item of parsed.plugin) addPlugin(Array.isArray(item) ? item[0] : item);
      if (Array.isArray(parsed.plugins)) for (const item of parsed.plugins) addPlugin(isObject(item) ? item.package : item);
    }
    catch (e: any) { if (e.code !== 'ENOENT') warnings.push(`Unable to parse ${name}; its values were skipped.`); }
  }
  const make = (category: Category, id: string, data: Value, sources: Source[], prompt?: unknown): Entry => ({ category, id, name: typeof data.name === 'string' && data.name ? data.name : id, description: typeof data.description === 'string' ? data.description : '', data, prompt: typeof prompt === 'string' ? prompt : typeof data.prompt === 'string' ? data.prompt : undefined, sources, provenance: {} });
  const definitions: Record<string, Entry> = Object.create(null);
  const commands: Record<string, Entry> = Object.create(null);
  for (const [id, data] of settings.Commands) commands[id] = make('Commands', id, data, configSources, data.template);
  for (const [id, data] of settings.Agents) {
    const e = make('Agents', id, data, agentSources.get(id) || [], data.system);
    for (const k of Object.keys(e.data)) e.provenance[k] = 'Configured · inline config'; definitions[id] = e;
  }
  for (const [folder, category] of [['agent', 'Agents'], ['agents', 'Agents'], ['mode', 'Agents'], ['modes', 'Agents'], ['command', 'Commands'], ['commands', 'Commands']] as const) {
    async function walk(dir: string, prefix = '', depth = 0) {
      if (depth > 8) return;
      for (const name of await list(dir)) {
        const p = path.join(dir, name);
        try {
          if ((await stat(p)).isDirectory()) { await walk(p, prefix + name + '/', depth + 1); continue; }
          if (!name.endsWith('.md')) continue;
          const id = prefix + name.slice(0, -3), doc = markdown(await text(p));
          if (category === 'Agents') {
            if (doc.data.disabled === true) {
              delete definitions[id];
              agentPermissions.delete(id);
              continue;
            }
            const native = ['permissions', 'request', 'system', 'disabled'].some(key => Object.hasOwn(doc.data, key));
            const data = native ? Object.fromEntries(Object.entries(doc.data).filter(([key]) =>
              !['name', 'tools', 'permission', 'prompt', 'disable', 'variant', 'temperature', 'top_p', 'options', 'reasoningEffort', 'maxSteps'].includes(key))) : doc.data;
            if (folder === 'mode' || folder === 'modes') data.mode = 'primary';
            const old = definitions[id]; const e = make(category, id, mergeAgent(old?.data || {}, data, native), [...old?.sources || [], await source(p, 'markdown')], doc.prompt);
            agentPermissions.set(id, combinePermission(agentPermissions.get(id), configuredPermission(data)));
            e.provenance = { ...old?.provenance };
            for (const k of Object.keys(e.provenance)) if (!Object.hasOwn(e.data, k)) delete e.provenance[k];
            for (const k of Object.keys(data)) if (Object.hasOwn(e.data, k)) e.provenance[k] = 'Configured · Markdown frontmatter';
            e.provenance.prompt = 'Configured · Markdown body'; definitions[id] = e;
          } else {
            const old = commands[id];
            commands[id] = make(category, id, mergeCommand(old?.data || {}, doc.data), [...old?.sources || [], await source(p, 'markdown')], doc.prompt);
          }
        } catch { warnings.push(`Unable to parse ${p}; definition skipped.`); }
      }
    }
    await walk(path.join(root, folder));
  }
  for (const e of Object.values(definitions)) {
    if (e.data.model === undefined && config.model !== undefined) { e.data.model = config.model; e.provenance.model = 'Inherited · global model'; }
    const local = agentPermissions.get(e.id);
    e.data.effectivePermission = combinePermission(globalPermission, local);
    e.provenance.effectivePermission = local !== undefined ? 'Configured agent rules over configured global rules' : globalPermission !== undefined ? 'Inherited · global configuration' : 'Unknown · runtime defaults not inferred';
    if (Object.hasOwn(e.data, 'request')) e.data.request = isObject(e.data.request) ? requestProjection(e.data.request) : '[REDACTED]';
    entries.push(e);
  }
  for (const name of await list(path.join(root, 'skills'))) {
    const p = path.join(root, 'skills', name, 'SKILL.md');
    try { const doc = markdown(await text(p)); entries.push(make('Skills', name, doc.data, [await source(p, 'skill')], doc.prompt)); } catch (e: any) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') warnings.push(`Unable to parse skill ${name}.`); }
  }
  entries.push(...Object.values(commands));
  for (const [provider, data] of settings.Models) for (const [id, model] of definitionsOf(data.models)) {
    const visible = { ...model, ...requestProjection(model, true) };
    if (Array.isArray(model.variants)) visible.variants = model.variants.flatMap((variant: unknown) =>
      isObject(variant) && typeof variant.id === 'string' ? [{ id: variant.id, ...requestProjection(variant, true) }] : []);
    const entry = make('Models', `${provider}/${id}`, { ...visible, provider, providerOptions: data.options,
      // Provider settings may contain package-specific secrets. Project only the field consumed by the UI.
      ...(typeof data.settings?.reasoningEffort === 'string' ? { providerSettings: { reasoningEffort: data.settings.reasoningEffort } } : {}),
    }, configSources);
    entry.modelCapacity = lookupModelCapacity(provider, id, model, data);
    entries.push(entry);
  }
  for (const [id, data] of settings['MCP Servers']) {
    const configuredTimeout = { ...mcpTimeout, ...timeouts(data.timeout) };
    entries.push(make('MCP Servers', id, { ...maskHeaders(data), configuredTimeout }, configSources));
  }
  const pluginSource = (p: string) => source(p, 'plugin reference (not loaded)');
  for (const folder of ['plugin', 'plugins']) for (const name of await list(path.join(root, folder))) {
    const p = path.join(root, folder, name);
    try {
      const info = await stat(p);
      if ((info.isFile() && /\.(?:[cm]?[jt]s)$/.test(name)) || (info.isDirectory() && !name.startsWith('.') && name !== 'node_modules' && !(await lstat(p)).isSymbolicLink()
        && (await list(p)).some(file => /^(?:package\.json|(?:server|index|tui|rpc)\.(?:tsx?|js)|gui-experimental\.(?:cjs|js))$/.test(file)))) {
        plugins.set(`./${folder}/${name}`, await pluginSource(p));
      }
    } catch {}
  }
  for (const [id, discovered] of plugins) {
    let local = discovered;
    if (!local && !/\{(?:env|file):/.test(id)) try {
      const p = id.startsWith('file:') ? fileURLToPath(id)
        : id.startsWith('./') || id.startsWith('../') || path.isAbsolute(id) ? path.resolve(root, id) : undefined;
      if (p) {
        const relative = path.relative(root, p);
        if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) local = await pluginSource(p);
      }
    } catch {}
    entries.push(make('Plugins', id, { reference: id, status: 'Reference only · never imported' }, local ? [...configSources, local] : configSources));
  }
  const instructions = new Set<string>(['AGENTS.md', ...(Array.isArray(config.instructions) ? config.instructions.filter((v: any) => typeof v === 'string') : [])]);
  for (const id of instructions) {
    if (/https?:|\{(?:env|file):|[*?\[\]]/.test(id)) { entries.push(make('Instructions', id, { status: 'Reference only · URLs, substitutions and globs are not resolved' }, configSources)); continue; }
    const p = path.isAbsolute(id) ? id : path.resolve(root, id);
    try { entries.push(make('Instructions', id, {}, [await source(p, 'instruction')], await text(p))); } catch (e: any) { if (id !== 'AGENTS.md' || e.code !== 'ENOENT') warnings.push(`Unable to read instruction ${id}.`); }
  }
  if (!configSources.length) warnings.push('No readable opencode.json or opencode.jsonc found.');
  for (const entry of entries) {
    if (['Agents', 'Commands', 'Skills', 'Instructions'].includes(entry.category)) entry.promptSize = estimatePromptSize(entry.prompt);
  }
  const theme = await discoverThemes(root, config.theme);
  return redact(maskSignedURLs({ root, realpath: rootReal, loadedAt: new Date().toISOString(), entries, warnings, theme }));
}
export function mergePermission(global: any, local: any): any {
  if (local === undefined) return global;
  if (typeof local === 'string') return local;
  const base = typeof global === 'string' ? { task: global } : object(global);
  const result = merge(base, object(local));
  // Reinsert overridden task patterns so the local declaration order wins.
  if (base.task && typeof base.task === 'object' && local?.task && typeof local.task === 'object') {
    result.task = { ...base.task }; for (const [k, v] of Object.entries(local.task)) if (safeKey(k)) { delete result.task[k]; result.task[k] = v; }
  }
  return result;
}
