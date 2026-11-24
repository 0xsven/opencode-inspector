# Bundled OpenCode theme data

`server/bundled-themes.ts` contains an allowlisted, reference-resolved projection of the classic TUI JSON palettes in:

https://github.com/anomalyco/opencode/tree/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/tui/src/theme/assets

Pinned release: **v1.18.34**, commit `aec0b9a6d8898f68f923aaf08b7306d931fd9d76`.
Files: `opencode.json`, `tokyonight.json`, `catppuccin.json`, `catppuccin-macchiato.json`, `nord.json`, `gruvbox.json`.
Only the browser-used color fields are included; references are resolved without changing the source colors.
The browser applies its own semantic surface mapping and contrast adjustment. These are classic TUI palettes, not a reproduction of newer v2 or desktop theme rendering.

## Tokyo Night dark browser appearance

`src/theme.ts` additionally uses a small GUI-derived appearance snapshot **only for
built-in Tokyo Night in dark mode**. Custom palettes, including custom Tokyo Night
overrides, and light mode retain their explicit TUI surface mapping. The bundled
source palette data above is unchanged.

Source: OpenCode **v1.19.5**, commit `810c0eba1a7348036f8bdf61e6632d0c36c6876c`:

- [`packages/ui/src/theme/themes/tokyonight.json`](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/ui/src/theme/themes/tokyonight.json): ink `#c0caf5`, primary `#7aa2f7`.
- `packages/ui/src/theme/color.ts`, `v2/resolve.ts`, and `v2/mapping.ts`: calculated V2 dark base `#13141e`, deep `#10111a`, layer-01 `#1b1d28`, muted ink `#a3abd2`.
- V2 hover overlay: white at 6%, composited onto Inspector's base surface.

Inspector maps base to the content canvas, deep to toolbar/sidebar/drawer, and
layer-01 to panels/controls/code backgrounds. It retains classic markdown accent
colors, Inspector selection/divider mapping, and contrast safeguards. This is a
bounded adaptation, not a port of the GUI engine or an exact Desktop rendering.
There are no runtime upstream requests. These upstream data/derived values are
covered by the OpenCode MIT license below; the pinned GUI release has the same
copyright and license text ([source](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/LICENSE)).

Upstream OpenCode's theme documentation credits [Tokyonight](https://github.com/folke/tokyonight.nvim), [Catppuccin](https://github.com/catppuccin), [Nord](https://github.com/nordtheme/nord), and [Gruvbox](https://github.com/morhetz/gruvbox).

## OpenCode license

Source: https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/LICENSE

MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# Bundled Models.dev context data

`server/model-capacities.ts` contains only provider ID, exact model ID and context capacity for 11 OpenAI records from https://models.dev/api.json (https://github.com/anomalyco/models.dev).

Checked/extracted: **2026-10-15**. Snapshot version: full API response SHA-256 **`d89d121bb5511e41bd5e9ddf00873aab132849fd96df549f0d39f6e80d64a4d3`**. No upstream release version is asserted. The projection omits all other API fields. There is no runtime network lookup. Published catalogue values do not guarantee runtime support; missing exact records stay unknown. The README lists included models and matching limitations.

## Models.dev license

Source: https://github.com/anomalyco/models.dev/blob/dev/LICENSE

MIT License

Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
