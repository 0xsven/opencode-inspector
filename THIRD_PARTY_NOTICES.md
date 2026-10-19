# Bundled OpenCode theme data

`server/bundled-themes.ts` contains an allowlisted, reference-resolved projection of the classic TUI JSON palettes in:

https://github.com/anomalyco/opencode/tree/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/tui/src/theme/assets

Pinned release: **v1.18.34**, commit `aec0b9a6d8898f68f923aaf08b7306d931fd9d76`.
Files: `opencode.json`, `tokyonight.json`, `catppuccin.json`, `catppuccin-macchiato.json`, `nord.json`, `gruvbox.json`.
Only the browser-used color fields are included; references are resolved without changing the source colors.
The browser applies its own semantic surface mapping and contrast adjustment. These are classic TUI palettes, not a reproduction of newer v2 or desktop theme rendering.

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
