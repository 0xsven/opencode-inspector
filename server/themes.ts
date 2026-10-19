import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse, type ParseError } from 'jsonc-parser';
import { bundledThemes } from './bundled-themes.js';
import { fallbackColors, themeColorKeys } from '../src/theme.js';
import type { ColorMode, ThemeColors, ThemeInfo, ThemePalette } from '../src/theme.js';

const record = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const own = (value: object, key: string) => Object.hasOwn(value, key);
export function ansiColor(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('Invalid ANSI color');
  if (value < 16) return ['#000000','#800000','#008000','#808000','#000080','#800080','#008080','#c0c0c0','#808080','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff'][value];
  const rgb = value < 232 ? [Math.floor((value - 16) / 36), Math.floor((value - 16) / 6) % 6, (value - 16) % 6].map(index => [0,95,135,175,215,255][index]) : Array(3).fill(8 + (value - 232) * 10);
  return '#' + rgb.map(channel => channel.toString(16).padStart(2, '0')).join('');
}

export function parseTheme(document: unknown): Record<ColorMode, ThemeColors> {
  const doc = record(document), theme = record(doc.theme), defs = record(doc.defs);
  if (!themeColorKeys.some(key => own(theme, key))) throw new Error('Unsupported theme format');
  const resolve = (value: unknown, mode: ColorMode, fallback: string, seen: Set<string>): string => {
    if (seen.size > 64) throw new Error('Theme reference too deep');
    if (typeof value === 'number') return ansiColor(value);
    if (typeof value === 'string') {
      if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) {
        let color = value.slice(1);
        if (color.length <= 4) color = [...color].map(char => char + char).join('');
        if (color.length === 8) {
          const alpha = parseInt(color.slice(6), 16) / 255;
          color = [0, 2, 4].map(offset => Math.round(parseInt(color.slice(offset, offset + 2), 16) * alpha + parseInt(fallback.slice(offset + 1, offset + 3), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('');
        }
        return '#' + color.toLowerCase();
      }
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
  if (legacyTheme !== undefined) {
    selection = { name: selectedName(legacyTheme) || null, source: 'configured', detail: 'Configured · legacy opencode theme' };
    if (!selection.name) warnings.push('Unsupported legacy theme selection.');
  }
  for (const file of ['tui.json', 'tui.jsonc']) {
    try {
      const doc = await readJSON(path.join(root, file));
      if (own(doc, 'theme')) {
        selection = { name: selectedName(doc.theme) || null, source: 'configured', detail: `Configured · ${file}` };
        if (!selection.name) warnings.push(`Unsupported theme selection in ${file}.`);
      }
    } catch (error: any) { if (error.code !== 'ENOENT') warnings.push(`Unable to parse ${file} for theme selection.`); }
  }

  const globalRoot = options.globalRoot || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
  let isGlobal = false;
  try { isGlobal = await realpath(root) === await realpath(globalRoot); } catch {}
  if (isGlobal && selection.source === 'fallback') {
    // CLI v2 persists the /theme selection here. If it exists, legacy KV can be stale and is not consulted.
    try {
      const doc = await readJSON(path.join(root, 'cli.json'));
      const selected = selectedName(doc.theme);
      if (selected) selection = { name: selected, source: 'saved', detail: 'Saved · cli.json (CLI v2)' };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        const state = options.stateRoot || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'opencode');
        try {
          const doc = await readJSON(path.join(state, 'kv.json'));
          const selected = name(doc.theme);
          if (selected) selection = { name: selected, source: 'saved', detail: 'Saved · kv.json (legacy TUI)' };
        } catch (error: any) { if (error.code !== 'ENOENT') warnings.push('Unable to read legacy TUI theme selection.'); }
      } else warnings.push('Unable to read saved CLI theme selection.');
    }
  }

  let files: string[] = [];
  try { files = (await readdir(path.join(root, 'themes'))).filter(file => /\.jsonc?$/.test(file)).sort(); }
  catch (error: any) { if (error.code !== 'ENOENT') warnings.push('Unable to list local themes.'); }
  for (const file of files) {
    const themeName = file.replace(/\.jsonc?$/, '');
    try {
      const colors = parseTheme(await readJSON(path.join(root, 'themes', file)));
      const theme: ThemePalette = { id: `custom:${themeName}`, name: themeName, label: `${themeName} (custom)`, kind: 'custom', source: path.join(root, 'themes', file), colors };
      palettes.set(themeName, theme);
    } catch { warnings.push(`Skipped invalid or unsupported theme: ${file}.`); }
  }
  if (selection.name && selection.name !== 'system' && !palettes.has(selection.name)) warnings.push('Selected OpenCode theme is unavailable or unsupported. Inspector default will be used.');
  return { selection, palettes: [...palettes.values()], warnings };
}
