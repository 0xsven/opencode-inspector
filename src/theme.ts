export const themeColorKeys = [
  'background', 'backgroundPanel', 'backgroundElement', 'text', 'textMuted', 'primary', 'accent',
  'border', 'borderActive', 'borderSubtle', 'markdownText', 'markdownHeading', 'markdownLink',
  'markdownCode', 'markdownBlockQuote', 'markdownEmph', 'markdownStrong', 'markdownHorizontalRule',
  'markdownListItem', 'markdownListEnumeration', 'markdownCodeBlock',
] as const;
export type ThemeColorKey = typeof themeColorKeys[number];
export type ColorMode = 'dark' | 'light';
export type ThemeColors = Record<ThemeColorKey, string>;
export interface ThemePalette {
  id: string;
  name: string;
  label: string;
  kind: 'built-in' | 'custom';
  source: string;
  colors: Record<ColorMode, ThemeColors>;
}
export interface ThemeInfo {
  selection: { name: string | null; mode?: 'system' | ColorMode; source: 'configured' | 'saved' | 'fallback'; detail: string };
  palettes: ThemePalette[];
  warnings: string[];
}
export interface ThemePreferences { theme: string; mode: 'auto' | ColorMode }
export const preferenceKey = 'opencode-inspector.appearance.v1';
export const defaultPreferences: ThemePreferences = { theme: 'follow', mode: 'auto' };

// Deliberately scoped to the bundled identity: a custom theme named tokyonight
// still supplies explicit TUI roles, never GUI seeds. Source palettes stay intact.
function guiTokyoNight(palette: ThemePalette | undefined, mode: ColorMode): boolean {
  return mode === 'dark' && palette?.kind === 'built-in' && palette.id === 'builtin:tokyonight';
}

export function readPreferences(storage?: Pick<Storage, 'getItem'>): ThemePreferences {
  try {
    const value = JSON.parse(storage?.getItem(preferenceKey) || '{}');
    return {
      theme: typeof value?.theme === 'string' && value.theme.length <= 256 ? value.theme : 'follow',
      mode: ['auto', 'light', 'dark'].includes(value?.mode) ? value.mode : 'auto',
    };
  } catch { return { ...defaultPreferences }; }
}
export function savePreferences(storage: Pick<Storage, 'setItem'> | undefined, value: ThemePreferences): boolean {
  try { if (!storage) return false; storage.setItem(preferenceKey, JSON.stringify(value)); return true; }
  catch { return false; }
}

const coreFallback = {
  dark: ['#191c1f', '#202528', '#263a3e', '#e0e3e5', '#adb5bc', '#9dcbd0', '#9dcbd0', '#363c41', '#59646b', '#363c41'],
  light: ['#f8f9fa', '#ffffff', '#e2eef0', '#20272b', '#526068', '#236570', '#236570', '#ccd3d7', '#75868f', '#dce1e4'],
};
export function fallbackColors(mode: ColorMode): ThemeColors {
  const core = Object.fromEntries(themeColorKeys.slice(0, 10).map((key, index) => [key, coreFallback[mode][index]])) as ThemeColors;
  for (const key of themeColorKeys.slice(10)) core[key] = key === 'markdownBlockQuote' ? core.textMuted : core.text;
  return core;
}

export function appliedTheme(info: ThemeInfo | undefined, preferences: ThemePreferences, prefersDark: boolean) {
  const follow = preferences.theme === 'follow';
  const cliMode = follow ? info?.selection.mode : undefined;
  const mode: ColorMode = preferences.mode !== 'auto' ? preferences.mode
    : cliMode === 'dark' || cliMode === 'light' ? cliMode : prefersDark ? 'dark' : 'light';
  const name = follow ? info?.selection.name : preferences.theme === 'inspector:default' ? null : undefined;
  const palette = follow ? info?.palettes.find(item => item.name === name) : info?.palettes.find(item => item.id === preferences.theme);
  const system = follow ? name === 'system' : preferences.theme === 'builtin:system';
  const missing = !palette && !system && (follow ? !!name : preferences.theme !== 'inspector:default');
  return {
    mode, palette,
    label: system ? 'System (browser approximation)' : palette?.label || 'Inspector default',
    source: follow ? info?.selection.detail || 'Fallback · no selected theme detected' : 'Manual · this browser only',
    note: system ? 'The terminal palette is unavailable in a browser. Uses the browser color scheme and Inspector colors.'
      : missing ? 'Selected theme is unavailable or unsupported. Using Inspector default; no different OpenCode theme was substituted.'
        : guiTokyoNight(palette, mode) ? 'Appearance: GUI-derived Tokyo Night dark surfaces and text · OpenCode 1.19.5. Markdown accents retain the classic palette; this is not an exact Desktop reproduction.'
        : palette && JSON.stringify(palette.colors.dark) === JSON.stringify(palette.colors.light) ? 'This upstream palette uses the same colors for light and dark modes.' : '',
  };
}

// A small contrast adjustment preserves the hue while making terminal palettes readable on browser surfaces.
function rgb(hex: string): number[] {
  const h = hex.slice(1);
  const expanded = h.length <= 4 ? [...h].map(char => char + char).join('') : h;
  return [0, 2, 4].map(offset => parseInt(expanded.slice(offset, offset + 2), 16));
}
function hex(color: number[]): string { return '#' + color.map(value => Math.round(value).toString(16).padStart(2, '0')).join(''); }
function luminance(color: number[]): number {
  return color.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
}
export function contrast(a: string, b: string): number {
  const values = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
  return (values[0] + .05) / (values[1] + .05);
}
function mix(foreground: string, background: string, amount: number): string {
  const base = rgb(background);
  return hex(rgb(foreground).map((value, index) => base[index] + (value - base[index]) * amount));
}
function readable(foreground: string, background: string, minimum = 4.5): string {
  const target = contrast('#ffffff', background) > contrast('#000000', background) ? [255, 255, 255] : [0, 0, 0];
  const start = rgb(foreground);
  for (let step = 0; step <= 20; step++) {
    const result = hex(start.map((value, index) => value + (target[index] - value) * step / 20));
    if (contrast(result, background) >= minimum) return result;
  }
  return hex(target);
}

export function appearance(palette: ThemePalette | undefined, mode: ColorMode): Record<string, string> {
  const gui = guiTokyoNight(palette, mode);
  const source = palette?.colors[mode] || fallbackColors(mode);
  // Pinned GUI v1.19.5 V2 base/layer-01, ink and primary. See
  // THIRD_PARTY_NOTICES.md for the derivation and MIT source attribution.
  // This is a small appearance snapshot, not a theme-generation engine.
  const colors = gui ? { ...source, background: '#13141e', backgroundPanel: '#1b1d28',
    backgroundElement: '#1b1d28', text: '#c0caf5', textMuted: '#a3abd2', primary: '#7aa2f7',
    markdownText: '#c0caf5', markdownCodeBlock: '#c0caf5' } : source;
  const text = readable(colors.text, colors.background);
  const panelText = readable(colors.text, colors.backgroundPanel);
  let refreshIdleOpacity = .65;
  while (refreshIdleOpacity < 1 && contrast(mix(text, colors.background, refreshIdleOpacity), colors.background) < 4.5) {
    refreshIdleOpacity = Math.min(1, refreshIdleOpacity + .05);
  }
  // Terminal element colors become quiet browser overlays. Keep the source
  // palette intact, and check foregrounds against the actual resulting surfaces.
  const selected = mix(text, mix(colors.backgroundElement, colors.background, .4), .06);
  const hover = mix(gui ? '#ffffff' : text, colors.background, gui ? .06 : .05);
  const line = mix(colors.borderSubtle, colors.background, .55);
  const values: Record<string, string> = {
    background: colors.background, chrome: gui ? '#10111a' : colors.background, 'refresh-idle-opacity': String(Number(refreshIdleOpacity.toFixed(2))),
    text, secondary: readable(colors.textMuted, colors.background),
    line, 'focus-line': readable(colors.borderActive, colors.background, 3), accent: readable(colors.primary, colors.background), selected,
    'selected-text': readable(text, selected), 'selected-secondary': readable(colors.textMuted, selected),
    hover, 'hover-text': readable(text, hover),
    panel: colors.backgroundPanel, 'panel-text': panelText, 'panel-secondary': readable(colors.textMuted, colors.backgroundPanel), 'panel-line': mix(colors.borderSubtle, colors.backgroundPanel, .25),
    'control-bg': colors.backgroundPanel, 'control-text': panelText, 'control-line': readable(colors.borderSubtle, colors.backgroundPanel, 3),
    'quote-border': colors.borderSubtle,
    'code-bg': colors.backgroundPanel, 'code-text': readable(colors.markdownCodeBlock, colors.backgroundPanel),
    'inline-bg': colors.backgroundElement, 'inline-text': readable(colors.markdownCode, colors.backgroundElement),
    shadow: mode === 'dark' ? '#00000088' : '#18252d33',
    'markdown-rule': colors.markdownHorizontalRule,
  };
  for (const [css, key] of Object.entries({ 'markdown-text': 'markdownText', 'markdown-heading': 'markdownHeading', 'markdown-link': 'markdownLink', 'markdown-quote': 'markdownBlockQuote', 'markdown-emph': 'markdownEmph', 'markdown-strong': 'markdownStrong', 'markdown-list': 'markdownListItem' } as const)) {
    values[css] = readable(colors[key], colors.background);
  }
  return values;
}
