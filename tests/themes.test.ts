import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ansiColor, discoverThemes, parseTheme } from '../server/themes.js';
import { bundledThemes } from '../server/bundled-themes.js';
import { appliedTheme, appearance, contrast, defaultPreferences, fallbackColors, preferenceKey, readPreferences, savePreferences, themeColorKeys } from '../src/theme.js';
import { redact } from '../server/redact.js';

test('theme color resolution: defs/chains, variants, hex, ANSI, none and allowlisted output', () => {
  const colors = parseTheme({ defs: { a: 'b', b: { dark: '#123', light: '#456789' } }, theme: { background: 'a', primary: 196, text: 'none', accent: 'primary', textMuted: { dark: 232, light: 255 }, markdownText: '#ff000000', unsafe: 'url(https://example.com)' } });
  assert.equal(colors.dark.background, '#112233'); assert.equal(colors.light.background, '#456789');
  assert.equal(colors.dark.primary, '#ff0000'); assert.equal(colors.light.accent, '#ff0000');
  assert.equal(colors.dark.text, fallbackColors('dark').text);
  assert.equal(colors.dark.markdownText, fallbackColors('dark').markdownText);
  assert.equal(colors.dark.textMuted, '#080808'); assert.equal(colors.light.textMuted, '#eeeeee');
  assert.deepEqual(Object.keys(colors.dark), [...themeColorKeys]);
  for (const [index, expected] of [[0, '#000000'], [15, '#ffffff'], [16, '#000000'], [231, '#ffffff']] as const) assert.equal(ansiColor(index), expected);
});

test('cycles, missing refs, unsupported formats and CSS injection never produce a palette', () => {
  for (const document of [
    { defs: { a: 'b', b: 'a' }, theme: { text: 'a' } },
    { theme: { text: 'text' } }, { theme: { text: 'missing' } },
    { theme: { text: 'red; background: url(https://example.com)' } },
    { theme: { text: '#12zzzz' } }, { theme: { text: 256 } }, { theme: { text: -1 } },
    { theme: { text: 2.5 } }, { theme: { text: { dark: '#000000' } } },
    { theme: { unknown: '#fff' } }, { variants: {} },
  ]) assert.throws(() => parseTheme(document));
});

test('discovery precedence, saved selection gating, custom override and sanitized failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inspector-theme-'));
  try {
    const global = path.join(root, 'global'), demo = path.join(root, 'demo'), state = path.join(root, 'state');
    await Promise.all([global, demo, state].map(dir => mkdir(dir)));
    const options = { globalRoot: global, stateRoot: state };
    await writeFile(path.join(state, 'kv.json'), JSON.stringify({ theme: 'gruvbox', unrelatedSecret: 'never-respond' }));
    assert.equal((await discoverThemes(global, undefined, options)).selection.name, 'gruvbox');
    await writeFile(path.join(global, 'cli.json'), JSON.stringify({ theme: { name: 'catppuccin-macchiato' }, privateValue: 'never-respond' }));
    const saved = await discoverThemes(global, undefined, options);
    assert.equal(saved.selection.source, 'saved'); assert.equal(saved.selection.name, 'catppuccin-macchiato');
    assert.ok(!JSON.stringify(saved).includes('never-respond'));
    assert.equal((await discoverThemes(demo, undefined, options)).selection.source, 'fallback');
    assert.equal((await discoverThemes(global, 'nord', options)).selection.name, 'nord');
    await writeFile(path.join(global, 'tui.json'), '{"theme":"tokyonight"}');
    assert.equal((await discoverThemes(global, 'nord', options)).selection.name, 'tokyonight');
    await writeFile(path.join(global, 'tui.jsonc'), '{ // theme\n"theme":{"name":"custom-one"},}');
    await mkdir(path.join(global, 'themes'));
    await writeFile(path.join(global, 'themes/custom-one.json'), JSON.stringify({ defs: { x: '#123456' }, theme: { background: 'x' }, password: 'never-respond' }));
    await writeFile(path.join(global, 'themes/nord.jsonc'), '{"theme":{"text":"#abcdef"}}');
    await writeFile(path.join(global, 'themes/broken.json'), '{"theme":{"text":"never-respond"}}');
    const configured = await discoverThemes(global, 'nord', options);
    assert.equal(configured.selection.name, 'custom-one'); assert.equal(configured.selection.source, 'configured');
    assert.equal(configured.palettes.find(item => item.name === 'nord')?.kind, 'custom');
    assert.equal(configured.palettes.find(item => item.name === 'custom-one')?.colors.dark.background, '#123456');
    assert.equal(configured.warnings.length, 1); assert.ok(!JSON.stringify(configured).includes('never-respond'));
    assert.deepEqual(redact(configured).palettes[0].colors, configured.palettes[0].colors);
    const unavailable = await discoverThemes(demo, '{env:THEME}', options);
    assert.equal(unavailable.selection.name, '{env:THEME}'); assert.equal(unavailable.warnings.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI v2 file without a selected theme does not revive stale legacy KV', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inspector-theme-cli-'));
  try {
    await writeFile(path.join(root, 'cli.json'), '{}');
    await writeFile(path.join(root, 'kv.json'), '{"theme":"nord"}');
    const info = await discoverThemes(root, undefined, { globalRoot: root, stateRoot: root });
    assert.equal(info.selection.source, 'fallback');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bundled palettes retain pinned source values and readable browser mappings', () => {
  assert.equal(bundledThemes.length, 6);
  assert.equal(bundledThemes.find(item => item.name === 'opencode')?.colors.dark.primary, '#fab283');
  assert.equal(bundledThemes.find(item => item.name === 'catppuccin-macchiato')?.colors.dark.background, '#24273a');
  assert.equal(bundledThemes.find(item => item.name === 'nord')?.colors.light.background, '#ECEFF4');
  for (const palette of bundledThemes) for (const mode of ['dark', 'light'] as const) {
    assert.deepEqual(Object.keys(palette.colors[mode]), [...themeColorKeys]);
    assert.ok(Object.values(palette.colors[mode]).every(value => /^#[\da-f]{6}$/i.test(value)));
    const css = appearance(palette, mode);
    assert.ok(contrast(css.secondary, css.background) >= 4.5);
    assert.ok(contrast(css['panel-text'], css.panel) >= 4.5);
    assert.ok(contrast(css['selected-text'], css.selected) >= 4.5);
  }
  assert.equal(appearance(undefined, 'dark').background, '#191c1f');
});

test('Tokyo Night uses subtle resting borders and active borders only for focus', () => {
  const palette = bundledThemes.find(item => item.name === 'tokyonight')!;
  for (const mode of ['dark', 'light'] as const) {
    const css = appearance(palette, mode);
    for (const key of ['line', 'panel-line', 'control-line', 'quote-border']) {
      assert.equal(css[key], palette.colors[mode].borderSubtle, key);
    }
    assert.equal(css['focus-line'], palette.colors[mode].borderActive);
    assert.equal(css['markdown-rule'], palette.colors[mode].markdownHorizontalRule);
  }
});

test('preferences are Inspector-only, validated, storage-safe and follow refreshed OpenCode metadata', () => {
  assert.deepEqual(readPreferences(), defaultPreferences);
  assert.deepEqual(readPreferences({ getItem: () => '{bad' }), defaultPreferences);
  assert.deepEqual(readPreferences({ getItem: () => '{"theme":42,"mode":"sepia"}' }), defaultPreferences);
  assert.deepEqual(readPreferences({ getItem: () => { throw new Error(); } }), defaultPreferences);
  assert.equal(savePreferences({ setItem: () => { throw new Error(); } }, defaultPreferences), false);
  assert.equal(savePreferences({ setItem: (key) => assert.equal(key, preferenceKey) }, defaultPreferences), true);
  const info = { selection: { name: 'nord', source: 'configured' as const, detail: 'Configured · tui.json' }, palettes: bundledThemes, warnings: [] };
  assert.equal(appliedTheme(info, defaultPreferences, true).palette?.name, 'nord');
  assert.equal(appliedTheme({ ...info, selection: { ...info.selection, name: 'gruvbox' } }, defaultPreferences, false).palette?.name, 'gruvbox');
  assert.equal(appliedTheme(info, { theme: 'builtin:tokyonight', mode: 'light' }, true).mode, 'light');
  assert.equal(appliedTheme(info, { theme: 'builtin:tokyonight', mode: 'auto' }, false).mode, 'light');
  assert.equal(appliedTheme(info, { theme: 'builtin:system', mode: 'auto' }, true).palette, undefined);
  assert.match(appliedTheme(info, { theme: 'builtin:system', mode: 'auto' }, true).note, /terminal/i);
  assert.match(appliedTheme(info, { theme: 'builtin:unavailable', mode: 'auto' }, true).note, /unsupported/);
});
