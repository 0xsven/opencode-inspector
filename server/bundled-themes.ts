import { themeColorKeys } from '../src/theme.js';
import type { ThemeColors, ThemePalette } from '../src/theme.js';

// Projected/resolved TUI colors from OpenCode v1.18.34, commit aec0b9a6d8898f68f923aaf08b7306d931fd9d76.
// Columns follow themeColorKeys. See THIRD_PARTY_NOTICES.md for source and MIT license.
const rows: Record<string, [string[], string[]]> = {
  opencode: [
    ['#0a0a0a','#141414','#1e1e1e','#eeeeee','#808080','#fab283','#9d7cd8','#484848','#606060','#3c3c3c','#eeeeee','#9d7cd8','#fab283','#7fd88f','#e5c07b','#e5c07b','#f5a742','#808080','#fab283','#56b6c2','#eeeeee'],
    ['#ffffff','#fafafa','#f5f5f5','#1a1a1a','#8a8a8a','#3b7dd8','#d68c27','#b8b8b8','#a0a0a0','#d4d4d4','#1a1a1a','#d68c27','#3b7dd8','#3d9a57','#b0851f','#b0851f','#d68c27','#8a8a8a','#3b7dd8','#318795','#1a1a1a'],
  ],
  tokyonight: [
    ['#1a1b26','#1e2030','#222436','#c8d3f5','#828bb8','#82aaff','#ff966c','#737aa2','#9099b2','#545c7e','#c8d3f5','#c099ff','#82aaff','#c3e88d','#ffc777','#ffc777','#ff966c','#828bb8','#82aaff','#86e1fc','#c8d3f5'],
    ['#e1e2e7','#d5d6db','#c8c9ce','#3760bf','#8990a3','#2e7de9','#b15c00','#737a8c','#5a607d','#9699a8','#3760bf','#9854f1','#2e7de9','#587539','#8c6c3e','#8c6c3e','#b15c00','#8990a3','#2e7de9','#007197','#3760bf'],
  ],
  catppuccin: [
    ['#1e1e2e','#181825','#11111b','#cdd6f4','#9399b2','#89b4fa','#f5c2e7','#313244','#45475a','#585b70','#cdd6f4','#cba6f7','#89b4fa','#a6e3a1','#f9e2af','#f9e2af','#fab387','#a6adc8','#89b4fa','#89dceb','#cdd6f4'],
    ['#eff1f5','#e6e9ef','#dce0e8','#4c4f69','#7c7f93','#1e66f5','#ea76cb','#ccd0da','#bcc0cc','#acb0be','#4c4f69','#8839ef','#1e66f5','#40a02b','#df8e1d','#df8e1d','#fe640b','#6c6f85','#1e66f5','#04a5e5','#4c4f69'],
  ],
  'catppuccin-macchiato': [
    ['#24273a','#1e2030','#181926','#cad3f5','#939ab7','#8aadf4','#f5bde6','#363a4f','#494d64','#5b6078','#cad3f5','#c6a0f6','#8aadf4','#a6da95','#eed49f','#eed49f','#f5a97f','#a5adcb','#8aadf4','#91d7e3','#cad3f5'],
    ['#24273a','#1e2030','#181926','#cad3f5','#939ab7','#8aadf4','#f5bde6','#363a4f','#494d64','#5b6078','#cad3f5','#c6a0f6','#8aadf4','#a6da95','#eed49f','#eed49f','#f5a97f','#a5adcb','#8aadf4','#91d7e3','#cad3f5'],
  ],
  nord: [
    ['#2E3440','#3B4252','#434C5E','#ECEFF4','#8B95A7','#88C0D0','#8FBCBB','#434C5E','#4C566A','#434C5E','#D8DEE9','#88C0D0','#81A1C1','#A3BE8C','#8B95A7','#D08770','#EBCB8B','#8B95A7','#88C0D0','#8FBCBB','#D8DEE9'],
    ['#ECEFF4','#E5E9F0','#D8DEE9','#2E3440','#3B4252','#5E81AC','#8FBCBB','#4C566A','#434C5E','#4C566A','#2E3440','#5E81AC','#81A1C1','#A3BE8C','#4C566A','#D08770','#EBCB8B','#4C566A','#5E81AC','#8FBCBB','#2E3440'],
  ],
  gruvbox: [
    ['#282828','#3c3836','#504945','#ebdbb2','#928374','#83a598','#8ec07c','#665c54','#ebdbb2','#504945','#ebdbb2','#83a598','#8ec07c','#fabd2f','#928374','#d3869b','#fe8019','#928374','#83a598','#8ec07c','#ebdbb2'],
    ['#fbf1c7','#ebdbb2','#d5c4a1','#3c3836','#7c6f64','#076678','#427b58','#bdae93','#3c3836','#d5c4a1','#3c3836','#076678','#427b58','#b57614','#7c6f64','#8f3f71','#af3a03','#7c6f64','#076678','#427b58','#3c3836'],
  ],
};

export const bundledThemes: ThemePalette[] = Object.entries(rows).map(([name, modes]) => ({
  id: `builtin:${name}`, name, label: name === 'opencode' ? 'OpenCode (classic)' : name,
  kind: 'built-in', source: 'OpenCode v1.18.34 · classic TUI palette',
  colors: Object.fromEntries(['dark', 'light'].map((mode, index) => [mode, Object.fromEntries(themeColorKeys.map((key, column) => [key, modes[index][column]])) as ThemeColors])) as ThemePalette['colors'],
}));
