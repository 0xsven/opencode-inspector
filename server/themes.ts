import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse, type ParseError } from 'jsonc-parser';
import { bundledThemes } from './bundled-themes.js';
import { globalConfigRoot } from './config-root.js';
import { fallbackColors, themeColorKeys } from '../src/theme.js';
import type { ColorMode, ThemeColorKey, ThemeColors, ThemeInfo, ThemePalette } from '../src/theme.js';

const record = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const own = (value: object, key: string) => Object.hasOwn(value, key);
export function ansiColor(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('Invalid ANSI color');
  if (value < 16) return ['#000000','#800000','#008000','#808000','#000080','#800080','#008080','#c0c0c0','#808080','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff'][value];
  const rgb = value < 232 ? [Math.floor((value - 16) / 36), Math.floor((value - 16) / 6) % 6, (value - 16) % 6].map(index => [0,95,135,175,215,255][index]) : Array(3).fill(8 + (value - 232) * 10);
  return '#' + rgb.map(channel => channel.toString(16).padStart(2, '0')).join('');
}

function hexColor(value: unknown, fallback: string): string | undefined {
  if (typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) {
    let color = value.slice(1);
    if (color.length <= 4) color = [...color].map(char => char + char).join('');
    if (color.length === 8) {
      const alpha = parseInt(color.slice(6), 16) / 255;
      color = [0, 2, 4].map(offset => Math.round(parseInt(color.slice(offset, offset + 2), 16) * alpha + parseInt(fallback.slice(offset + 1, offset + 3), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('');
    }
    return '#' + color.toLowerCase();
  }
}

// Project documented semantic colors into the browser's existing roles.
// This is not the TUI renderer: contextual/state overrides are not rendered.
const nativePaths: Partial<Record<ThemeColorKey, string>> = {
  background: 'background.base', backgroundPanel: 'background.raised.base', backgroundElement: 'background.raised.high',
  text: 'text.base', textMuted: 'text.muted', primary: 'text.action.primary.base', accent: 'text.action.secondary.base',
  border: 'border.base', borderSubtle: 'border.muted', borderActive: 'border.action.primary.base',
  markdownText: 'markdown.text', markdownHeading: 'markdown.heading', markdownLink: 'markdown.link',
  markdownCode: 'markdown.code', markdownBlockQuote: 'markdown.blockQuote', markdownEmph: 'markdown.emphasis',
  markdownStrong: 'markdown.strong', markdownHorizontalRule: 'markdown.horizontalRule', markdownListItem: 'markdown.listItem',
  markdownListEnumeration: 'markdown.listEnumeration', markdownCodeBlock: 'markdown.codeBlock',
};

function nativeTheme(doc: Record<string, any>): Record<ColorMode, ThemeColors> {
  const base = record(doc.base);
  const modes = (['dark', 'light'] as const).filter(mode => Object.keys(record(doc[mode])).length > 0);
  if (!Object.keys(base).length || !modes.length) throw new Error('Unsupported native theme format');
  const palettes = new Map(modes.map(mode => {
    const override = record(doc[mode]);
    // When looking up $hue.accent.100, an intermediate reference such as
    // accent: "$hue.purple" forwards the remaining path to the aliased hue.
    function resolve(parts: string[], seen: Set<string>): unknown {
      const key = parts.join('.');
      if (seen.has(key) || seen.size >= 64 || parts.length > 64) throw new Error('Invalid theme reference');
      seen = new Set([...seen, key]);
      let common: unknown = base, specific: unknown = override;
      for (let i = 0; i <= parts.length; i++) {
        const value = specific === undefined ? common : specific;
        if (typeof value === 'string' && /^\$[\w-]+(?:\.[\w-]+)*$/.test(value)) {
          const resolved = resolve([...value.slice(1).split('.'), ...parts.slice(i)], seen);
          if (resolved === undefined) throw new Error('Missing theme reference');
          return resolved;
        }
        if (i === parts.length) return value;
        const part = parts[i];
        common = own(record(common), part) ? record(common)[part] : undefined;
        specific = own(record(specific), part) ? record(specific)[part] : undefined;
      }
    }
    const colors = fallbackColors(mode);
    let projected = 0;
    for (const key of themeColorKeys) {
      const field = nativePaths[key];
      if (!field) continue;
      const value = resolve(field.split('.'), new Set());
      if (value === undefined || (key === 'border' && Object.keys(record(value)).length)) continue;
      const hex = value === 'transparent' ? colors[key] : hexColor(value, colors[key]);
      if (!hex) throw new Error('Invalid native theme color');
      colors[key] = hex;
      projected++;
    }
    if (!projected) throw new Error('No recognized native theme colors');
    return [mode, colors] as const;
  }));
  return { dark: palettes.get('dark') || palettes.get('light')!, light: palettes.get('light') || palettes.get('dark')! };
}

export function parseTheme(document: unknown): Record<ColorMode, ThemeColors> {
  const doc = record(document), theme = record(doc.theme), defs = record(doc.defs);
  if (own(doc, 'base')) return nativeTheme(doc);
  if (!themeColorKeys.some(key => own(theme, key))) throw new Error('Unsupported theme format');
  const resolve = (value: unknown, mode: ColorMode, fallback: string, seen: Set<string>): string => {
    if (seen.size > 64) throw new Error('Theme reference too deep');
    if (typeof value === 'number') return ansiColor(value);
    if (typeof value === 'string') {
      const hex = hexColor(value, fallback);
      if (hex) return hex;
      if (value === 'none') return fallback;
      const scope = own(defs, value) ? 'defs' : 'theme';
      const key = `${scope}:${value}`;
      if (seen.has(key) || !own(scope === 'defs' ? defs : theme, value)) throw new Error('Invalid theme reference');
      return resolve((scope === 'defs' ? defs : theme)[value], mode, fallback, new Set([...seen, key]));
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && own(value, mode)) return resolve(record(value)[mode], mode, fallback, seen);
    throw new Error('Invalid theme color');
  };
  return Object.fromEntries((['dark', 'light'] as const).map(mode => {
    const colors = fallbackColors(mode);
    for (const key of themeColorKeys) if (own(theme, key)) colors[key] = resolve(theme[key], mode, colors[key], new Set([`theme:${key}`]));
    return [mode, colors];
  })) as Record<ColorMode, ThemeColors>;
}

async function readJSON(file: string): Promise<Record<string, any>> {
  if ((await stat(file)).size > 2_000_000) throw new Error('File too large');
  const errors: ParseError[] = [];
  const value = parse(await readFile(file, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON');
  return value;
}

export async function discoverThemes(root: string, legacyTheme: unknown, options: { globalRoot?: string; stateRoot?: string } = {}): Promise<ThemeInfo> {
  const warnings: string[] = [];
  const palettes = new Map(bundledThemes.map(theme => [theme.name, theme]));
  let selection: ThemeInfo['selection'] = { name: null, source: 'fallback', detail: 'Fallback · no selected theme detected' };
  const name = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
  const selectedName = (value: unknown) => name(typeof value === 'string' ? value : record(value).name);
  const globalRoot = options.globalRoot || globalConfigRoot();
  let isGlobal = false;
  try { isGlobal = await realpath(root) === await realpath(globalRoot); } catch {}
  let hasCliConfig = false;
  if (isGlobal) {
    let cli = {};
    try {
      cli = record((await readJSON(path.join(root, 'cli.json'))).theme);
      hasCliConfig = true;
    } catch (error: any) {
      if (error.code !== 'ENOENT') { hasCliConfig = true; warnings.push('Unable to read saved CLI theme selection.'); }
    }
    const inline = process.env.OPENCODE_CLI_CONFIG_CONTENT;
    let inlineTheme = false;
    if (inline) try {
      const parsed = JSON.parse(inline);
      if (own(record(parsed), 'theme')) {
        inlineTheme = true;
        hasCliConfig = true;
        cli = { ...cli, ...record(parsed.theme) };
      }
    } catch { warnings.push('Unable to read inline CLI theme settings.'); }
    if (hasCliConfig) {
      const theme = record(cli);
      const selected = name(theme.name);
      const mode = ['dark', 'light', 'system'].includes(theme.mode) ? theme.mode as ColorMode | 'system' : undefined;
      if (selected || mode) selection = { name: selected || null, ...(mode ? { mode } : {}), source: inlineTheme ? 'configured' : 'saved',
        detail: inlineTheme ? 'Configured · inline CLI settings over cli.json' : 'Saved · cli.json (CLI v2)' };
    }
  }
  if (!hasCliConfig && legacyTheme !== undefined) {
    selection = { name: selectedName(legacyTheme) || null, source: 'configured', detail: 'Configured · legacy opencode theme' };
    if (!selection.name) warnings.push('Unsupported legacy theme selection.');
  }
  for (const file of hasCliConfig ? [] : ['tui.json', 'tui.jsonc']) {
    try {
      const doc = await readJSON(path.join(root, file));
      if (own(doc, 'theme')) {
        selection = { name: selectedName(doc.theme) || null, source: 'configured', detail: `Configured · ${file}` };
        if (!selection.name) warnings.push(`Unsupported theme selection in ${file}.`);
      }
    } catch (error: any) { if (error.code !== 'ENOENT') warnings.push(`Unable to parse ${file} for theme selection.`); }
  }

  if (isGlobal && !hasCliConfig && selection.source === 'fallback') {
    const state = options.stateRoot || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'opencode');
    try {
      const selected = name((await readJSON(path.join(state, 'kv.json'))).theme);
      if (selected) selection = { name: selected, source: 'saved', detail: 'Saved · kv.json (legacy TUI)' };
    } catch (error: any) { if (error.code !== 'ENOENT') warnings.push('Unable to read legacy TUI theme selection.'); }
  }

  let files: string[] = [];
  try { files = (await readdir(path.join(root, 'themes'))).filter(file => (hasCliConfig ? /\.json$/ : /\.jsonc?$/).test(file)).sort(); }
  catch (error: any) { if (error.code !== 'ENOENT') warnings.push('Unable to list local themes.'); }
  for (const file of files) {
    const themeName = file.replace(/\.jsonc?$/, '');
    try {
      const document = await readJSON(path.join(root, 'themes', file));
      if (file.endsWith('.jsonc') && own(document, 'base')) continue;
      const colors = parseTheme(document);
      const theme: ThemePalette = { id: `custom:${themeName}`, name: themeName, label: `${themeName} (custom)`, kind: 'custom', source: path.join(root, 'themes', file), colors };
      palettes.set(themeName, theme);
    } catch { warnings.push(`Skipped invalid or unsupported theme: ${file}.`); }
  }
  if (selection.name && selection.name !== 'system' && !palettes.has(selection.name)) warnings.push('Selected OpenCode theme is unavailable or unsupported. Inspector default will be used.');
  return { selection, palettes: [...palettes.values()], warnings };
}
