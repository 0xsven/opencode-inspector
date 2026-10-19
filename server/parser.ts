import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseJSON, type ParseError } from 'jsonc-parser';
import { parse as parseYAML } from 'yaml';
import type { Entry, Snapshot, Source, Value, Category } from '../src/types.js';
import { redact } from './redact.js';
import { discoverThemes } from './themes.js';
import { lookupModelCapacity } from './model-capacities.js';
import { estimatePromptSize } from './prompt-size.js';
export { taskPermission } from '../src/permissions.js';

const object = (v: any): Value => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
export function merge(a: Value, b: Value): Value {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
    delete out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(object(a[k]), v) : v;
  }
  return out;
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
  let config: Value = {}, configSources: Source[] = [];
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const p = path.join(root, name);
    try { const errors: ParseError[] = []; const parsed = parseJSON(await text(p), errors, { allowTrailingComma: true }); if (errors.length || !parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Invalid config'); config = merge(config, parsed); configSources.push(await source(p, 'config')); }
    catch (e: any) { if (e.code !== 'ENOENT') warnings.push(`Unable to parse ${name}; its values were skipped.`); }
  }
  const make = (category: Category, id: string, data: Value, sources: Source[], prompt?: unknown): Entry => ({ category, id, name: typeof data.name === 'string' && data.name ? data.name : id, description: typeof data.description === 'string' ? data.description : '', data, prompt: typeof prompt === 'string' ? prompt : typeof data.prompt === 'string' ? data.prompt : undefined, sources, provenance: {} });
  const definitions: Record<string, Entry> = Object.create(null);
  const commands: Record<string, Entry> = Object.create(null);
  for (const [id, data] of Object.entries(object(config.command))) commands[id] = make('Commands', id, object(data), configSources, object(data).template);
  for (const [id, data] of Object.entries(object(config.agent))) {
    const e = make('Agents', id, object(data), [...configSources]);
    for (const k of Object.keys(e.data)) e.provenance[k] = 'Configured · inline config'; definitions[id] = e;
  }
  for (const [folder, category] of [['agents', 'Agents'], ['commands', 'Commands']] as const) {
    async function walk(dir: string, prefix = '', depth = 0) {
      if (depth > 8) return;
      for (const name of await list(dir)) {
        const p = path.join(dir, name);
        try {
          if ((await stat(p)).isDirectory()) { await walk(p, prefix + name + '/', depth + 1); continue; }
          if (!name.endsWith('.md')) continue;
          const id = prefix + name.slice(0, -3), doc = markdown(await text(p));
          if (category === 'Agents') {
            const old = definitions[id]; const e = make(category, id, merge(old?.data || {}, doc.data), [...old?.sources || [], await source(p, 'markdown')], doc.prompt);
            e.provenance = { ...old?.provenance }; for (const k of Object.keys(doc.data)) e.provenance[k] = 'Configured · Markdown frontmatter'; e.provenance.prompt = 'Configured · Markdown body'; definitions[id] = e;
          } else {
            const old = commands[id];
            commands[id] = make(category, id, merge(old?.data || {}, doc.data), [...old?.sources || [], await source(p, 'markdown')], doc.prompt);
          }
        } catch { warnings.push(`Unable to parse ${p}; definition skipped.`); }
      }
    }
    await walk(path.join(root, folder));
  }
  for (const e of Object.values(definitions)) {
    e.promptSize = estimatePromptSize(e.prompt);
    if (e.data.model === undefined && config.model !== undefined) { e.data.model = config.model; e.provenance.model = 'Inherited · global model'; }
    e.data.effectivePermission = mergePermission(config.permission, e.data.permission);
    e.provenance.effectivePermission = e.data.permission !== undefined ? 'Configured agent rules over global rules' : config.permission !== undefined ? 'Inherited · global permission' : 'Unknown · runtime defaults not inferred';
    entries.push(e);
  }
  for (const name of await list(path.join(root, 'skills'))) {
    const p = path.join(root, 'skills', name, 'SKILL.md');
    try { const doc = markdown(await text(p)); entries.push(make('Skills', name, doc.data, [await source(p, 'skill')], doc.prompt)); } catch (e: any) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') warnings.push(`Unable to parse skill ${name}.`); }
  }
  entries.push(...Object.values(commands));
  for (const [provider, data] of Object.entries(object(config.provider))) for (const [id, model] of Object.entries(object(object(data).models))) {
    const entry = make('Models', `${provider}/${id}`, { ...object(model), provider, providerOptions: object(data).options }, configSources);
    entry.modelCapacity = lookupModelCapacity(provider, id, object(model), object(data));
    entries.push(entry);
  }
  for (const [id, data] of Object.entries(object(config.mcp))) entries.push(make('MCP Servers', id, object(data), configSources));
  const plugins = new Set<string>();
  for (const key of ['plugin', 'plugins']) if (Array.isArray(config[key])) for (const p of config[key]) if (typeof p === 'string') plugins.add(p);
  for (const name of await list(path.join(root, 'plugins'))) if (/\.(?:[cm]?[jt]s)$/.test(name)) plugins.add('./plugins/' + name);
  for (const id of plugins) { let sources = configSources; if (id.startsWith('.')) try { sources = [...configSources, await source(path.resolve(root, id), 'plugin reference (not loaded)')]; } catch {} entries.push(make('Plugins', id, { reference: id, status: 'Reference only · never imported' }, sources)); }
  const instructions = new Set<string>(['AGENTS.md', ...(Array.isArray(config.instructions) ? config.instructions.filter((v: any) => typeof v === 'string') : [])]);
  for (const id of instructions) {
    if (/https?:|\{(?:env|file):|[*?\[\]]/.test(id)) { entries.push(make('Instructions', id, { status: 'Reference only · URLs, substitutions and globs are not resolved' }, configSources)); continue; }
    const p = path.isAbsolute(id) ? id : path.resolve(root, id);
    try { entries.push(make('Instructions', id, {}, [await source(p, 'instruction')], await text(p))); } catch (e: any) { if (id !== 'AGENTS.md' || e.code !== 'ENOENT') warnings.push(`Unable to read instruction ${id}.`); }
  }
  if (!configSources.length) warnings.push('No readable opencode.json or opencode.jsonc found.');
  const theme = await discoverThemes(root, config.theme);
  return redact({ root, realpath: rootReal, loadedAt: new Date().toISOString(), entries, warnings, theme });
}
export function mergePermission(global: any, local: any): any {
  if (local === undefined) return global;
  if (typeof local === 'string') return local;
  const base = typeof global === 'string' ? { task: global } : object(global);
  const result = merge(base, object(local));
  // Reinsert overridden task patterns so the local declaration order wins.
  if (base.task && typeof base.task === 'object' && local?.task && typeof local.task === 'object') {
    result.task = { ...base.task }; for (const [k, v] of Object.entries(local.task)) { delete result.task[k]; result.task[k] = v; }
  }
  return result;
}
