# OpenCode Inspector

A local, read-only column browser for OpenCode configuration. Follow **Agents → Build → Subagents**, inspect prompts and permissions, and trace configured values back to their files and symlink targets.

React + TypeScript + Vite, with a small loopback-only Node/Express parser API. No telemetry, remote fonts, or external image loading.

## Install and run

Requires Node.js 22+ and npm. Clone the source and run the local inspector:

```sh
git clone https://github.com/0xsven/opencode-inspector.git
cd opencode-inspector
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4317**. Stop with Ctrl+C. By default, OpenCode Inspector reads `~/.config/opencode` without modifying it. This is an independent, local-only application, not a hosted service.

```sh
# Try the fictional, credential-free example instead
npm start -- --config examples/demo
```

## Development

Run these commands from the cloned repository. The development UI is at **http://127.0.0.1:5173** and the API at **127.0.0.1:4317**.

```sh
npm run dev
npm run dev -- --config examples/demo

# Inspect another local root (quote paths containing spaces)
npm run dev -- --config /path/to/opencode

# Or select the root via environment
OPENCODE_CONFIG_ROOT=/path/to/opencode npm run dev

# Production: serves both the app and API on port 4317
npm run build
npm start -- --config examples/demo
```

`--config` overrides `OPENCODE_CONFIG_ROOT`. Root selection is fixed for the life of the process. The header shows the current root; refreshing the browser rereads files without writing them. Stop the launcher with Ctrl+C. Dev and production use the same API port, so run one at a time.

## What is inspected

- `opencode.json` and `opencode.jsonc` (comments and trailing commas supported).
- Inline `agent` definitions and recursively discovered `agents/**/*.md`; command Markdown/YAML frontmatter and inline `command` entries.
- `skills/*/SKILL.md`, including symlinked folders.
- Explicit `provider.*.models`, MCP configuration, both `plugin` and `plugins` arrays, and local plugin filenames (references only).
- Root `AGENTS.md` and explicitly configured local `instructions` paths. Explicit absolute paths and symlink targets may be outside the root; there is no arbitrary file-read API.

## Resolution contract & limitations

This is a **static inspector**, not an OpenCode runtime emulator. It never supplies an imagined built-in prompt, permission, model limit, or default agent. An absent value is **unknown**. It does not scan project roots, remote registries, auth stores, or other global skill directories.

The inspector's explicit merge order is **JSON → JSONC → agent/command Markdown frontmatter**. Objects merge recursively; scalars and arrays replace. The Markdown body supplies the file prompt. This is a documented inspection convention, not a guarantee of identical precedence in every OpenCode release. Same-name inline and file commands are combined using this priority.

Agent models inherit the configured global `model` only when absent. Reasoning displays the first configured value from agent `reasoningEffort`, agent `options.reasoningEffort`, selected model variant, model options, then provider options. Context/input/output limits come only from the matching configured provider model. These labels show static configuration, not verified effective runtime behavior.

### Model-capacity comparison (offline)

**Agents → Model & settings** and **Models → Context limits** show configured context alongside **Model capacity**, the published Models.dev catalogue context. Lower configured values say **Capped below model capacity**; equal values have no cap indication; greater values explicitly say they exceed published capacity, with runtime support/enforcement unknown. Input/output remain separately labeled configured values. This is not a live usage gauge or runtime capability check.

`server/model-capacities.ts` bundles 11 exact `openai` provider/model context records extracted from [Models.dev API](https://models.dev/api.json), checked **2026-10-15**. The full response SHA-256 is `d89d121bb5511e41bd5e9ddf00873aab132849fd96df549f0d39f6e80d64a4d3`. This digest identifies the source snapshot, not an upstream release version. Attribution/license: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No catalogue is downloaded at runtime; the source link only opens on user action.

Published contexts: `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-luna`, and `gpt-5.5` are **1,050,000**; `gpt-5.2` and `gpt-5.1` are **400,000**. The checked catalogue has no exact `openai` records for `gpt-5.2-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex`, or `gpt-5.1-codex-mini`; records from other providers are not substituted.

Lookup uses the configured provider key plus the model's API `id` override when present, otherwise its configuration key. No family-name inference, provider aliases, or configuration-supplied native metadata are trusted. Custom providers, overridden endpoints (`options.baseURL`), and non-OpenAI SDK overrides have unknown capacity. Unbundled IDs and the fictional demo models also show unknown. Missing, nonnumeric, nonpositive, or invalid limits cannot imply a cap. Catalogue data is a published reference and may be stale or differ from account, endpoint, or runtime support. To update the small projection, verify exact records against the source and update the checked date, digest, tests, and notices together.

Accessible subagents use configured `permission.task` rules (or string permission shorthand). `*` matches any string and `?` matches one character; matching is case sensitive; **the last matching rule wins**. Agent task rules override matching global patterns and are placed after global rules in local declaration order. `allow` and `ask` are shown as reachable; `ask` requires approval. No match is unknown, never an assumed allow. Explicit primary-only, disabled, and the current agent are excluded. Unspecified modes remain candidates with unknown runtime eligibility. Hidden agents are retained. This inventory cannot discover built-in agents omitted from configuration or verify actual tool availability.

No `{env:…}` or `{file:…}` evaluation, instruction glob expansion, URL fetching, plugin loading, MCP startup, or shell execution. Files over 2 MB are skipped with a notice; agent/command traversal is depth-limited. Parse failures yield notices instead of raw parser errors.

## Security model

- API and production app bind to **127.0.0.1 only**. Host allowlisting mitigates DNS rebinding. API rejects cross-site fetch metadata and unapproved origins, offers no CORS access, and only accepts GET. Development also allows the local Vite origin.
- One fixed-root snapshot endpoint: no path query, mutation, file download, command execution, or plugin import endpoints. Sources include real paths so symlinks are transparent.
- **Redaction runs recursively on the server before a snapshot response.** Sensitive key names (`apiKey`, password, token, secret, authorization, cookie, credentials, private keys), environment values, recognizable URL credentials/query secrets, common token formats, bearer values, secret CLI flags, and assignment-style prompt secrets are masked. Raw view is the redacted parsed prompt, never a raw config/file endpoint. Errors do not echo source text or exception details.
- Markdown is rendered without raw HTML, clickable links, or remote images. Production adds a restrictive CSP and responses are not cached.

**Redaction is best-effort, not a secret scanner or a publication guarantee.** An unlabeled credential, unusual encoding, custom command format, secret in a filename, or arbitrary prose may evade detection. Local paths and configuration metadata are intentionally visible. Inspect before sharing screenshots, snapshots, or exports. There is no built-in export. Treat config files as trusted local input and avoid untrusted symlinks. Any process with local machine access can contact this unauthenticated local inspector; do not expose its ports through a tunnel or reverse proxy.

## Verify

```sh
npm test
npm run typecheck
npm run build
```

Focused Node tests cover JSONC/frontmatter parsing, merge priority, ordered permissions and shorthand, symlink realpaths, recursive redaction, sanitized failures, malformed display fields, collapsed-first navigation, theme resolution/discovery, preference isolation, contrast, and a representative seven-category demo. No tests depend on your personal configuration.

## Themes

Open **Settings → Appearance** using the link at the bottom of the left sidebar, or choose **Settings** in the mobile category dropdown. `/settings` supports direct links, refresh, and browser Back/Forward. The default is **Follow OpenCode**, with **Auto (browser)** color mode. Manual choices are saved only under `opencode-inspector.appearance.v1` in this app's browser localStorage; no OpenCode file is written. If storage is blocked, the app keeps working and overrides last for that page. Browser refresh rereads the selected root and follows changed OpenCode selections. Auto responds to `prefers-color-scheme` changes; Light and Dark pin the browser mode independently of terminal settings.

### Selection and honest fallback

Inspection priority (highest first):

1. The selected root's `tui.jsonc` theme, then `tui.json` theme. String names and `{ "name": "…" }` are accepted.
2. Legacy `theme` in the merged `opencode.json` / `opencode.jsonc`.
3. **Only for the canonical global config root**, saved `theme.name` in `cli.json` (CLI v2). If that file is absent, legacy `theme` in the XDG state directory's `opencode/kv.json`.
4. **Inspector default**, labeled fallback. No configured/saved selection is not evidence of an active built-in default.

The global-root check uses real paths against `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`; state uses `$XDG_STATE_HOME/opencode` or `~/.local/state/opencode`. Demo and arbitrary roots never inherit personal host CLI preferences. An existing CLI v2 config prevents reviving stale legacy KV settings. Selection names are references, not paths: placeholders and URLs are never evaluated or fetched. An unavailable selected palette produces a notice and Inspector fallback, never an unrelated built-in palette.

Detection was verified against these pinned upstream releases:

- **CLI v2.0.16** (`3a103fe0aff726a4edc7492f03f7b88195d9e4c9`): [`packages/cli/src/config/config.ts`](https://github.com/anomalyco/opencode/blob/3a103fe0aff726a4edc7492f03f7b88195d9e4c9/packages/cli/src/config/config.ts) persists `cli.json`; [`packages/tui/src/context/theme.tsx`](https://github.com/anomalyco/opencode/blob/3a103fe0aff726a4edc7492f03f7b88195d9e4c9/packages/tui/src/context/theme.tsx) saves `theme.name` through that config service.
- **v1.18.34 TUI**: [`theme.tsx`](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/tui/src/context/theme.tsx) uses configured theme or KV `theme`; [`kv.tsx`](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/tui/src/context/kv.tsx) persists `state/kv.json`.
- **Desktop v1.18.34**: [`packages/ui/src/theme/context.tsx`](https://github.com/anomalyco/opencode/blob/aec0b9a6d8898f68f923aaf08b7306d931fd9d76/packages/ui/src/theme/context.tsx) stores `opencode-theme-id` and `opencode-color-scheme` in its own browser localStorage. **Inspector does not inspect Electron/Chromium databases or desktop preferences.** Its detected saved selection is explicitly labeled CLI, not an assertion about the desktop's active theme. Process-only overrides and project themes outside the fixed root are also not detected.

### Offline palettes and custom themes

Bundled classic TUI palettes: **opencode, tokyonight, catppuccin, catppuccin-macchiato, nord, gruvbox**. The exact source is pinned to OpenCode v1.18.34; palette projection and upstream MIT notice are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). OpenCode's newer v2/desktop theme engines have different formats and surfaces; these palettes preserve the familiar classic colors, not pixel-identical application rendering. Macchiato's upstream light and dark variants are identical, and this is noted when applied.

Custom definitions are discovered from **the selected root's `themes/*.json` and `themes/*.jsonc` only**. JSONC support is an Inspector convenience beyond the documented `.json` theme discovery. Same-name custom palettes override bundled ones; `.jsonc` sorts after `.json`. No network or plugin loading occurs. The demo includes `themes/harbor.json`: run `npm run dev -- --config examples/demo`, then choose **harbor (custom)** in Settings.

The classic `{ "defs": {…}, "theme": {…} }` format supports references to defs or theme colors (defs first), chained references, `{ "dark": …, "light": … }`, hex RGB/RGBA, ANSI integers 0–255, and `"none"`. Missing fields and `none` use Inspector's mode-specific defaults. Alpha colors are composited over the corresponding fallback color. ANSI 0–15 use the standard xterm approximation, since actual terminal colors are unavailable. References are bounded; cycles, missing references, malformed JSON, unsupported formats, and invalid colors skip the custom file with a sanitized notice. Files are limited to 2 MB. Unknown fields/unused definitions are not exposed.

Only 21 allowlisted, resolved hex color fields per mode reach the browser—no raw theme files, definitions, arbitrary CSS, URLs, or preference contents. CSS uses semantic variables for surfaces, controls, text, Markdown, and focus states. Text colors are adjusted toward a contrasting endpoint when necessary for a 4.5:1 ratio on their browser surface. This browser mapping intentionally differs from terminal rendering. Original Inspector dark fallback colors are retained when no palette is selected; a matching neutral light fallback is available.

**System** is explicitly a browser approximation: it uses Inspector colors and browser color-mode detection. It cannot reproduce the terminal palette or terminal `none` behavior. Settings shows the applied palette, source, and any fallback notices without adding persistent header chrome.

## Interface

Start at `/` with **Choose a category to begin**. Selecting a category reveals its item list without choosing an item. Select an item to see its name and closed disclosure sections; open only what you need. Clicking the selected category closes it. The app name links home. Use browser Back/Forward to restore previous views, including returning from a subagent to its parent agent.

Agent sections include Model & settings, Subagents, Prompt, Sources, and Raw configuration. Agent descriptions appear in full in the overview; other definitions retain About. Model & settings and Models → Context limits use compact, zebra-striped Setting / Value / Source tables, with stacked labels on mobile. Subagents shows candidate decisions (including denied and unknown), matching rules, and an optional closed **Configured task rules** table in effective matching order, including patterns with no known candidate. Approval requirements are explicit. Permissions remain in Raw configuration. New item navigation starts closed in Markdown mode; browser Back/Forward and refresh restore the sections and raw-prompt mode saved in that history entry. Settings includes a collapsed **Configuration information** section for root/real paths, static-inspection limitations, and configuration notices. There is no About overlay or duplicated browser navigation in the header.

Agent details also show a compact, borderless overview: the full About description in a readable 64-character-width column, Model, Reasoning variant (named variant and resolved effort when different), configured Context limit, estimated Prompt length in tokens, and linked reachable Subagents. A **Capped** note means the configured limit is below the verified published capacity; the published capacity never replaces the configured limit. Full settings/provenance remain in the closed-by-default disclosures.

Prompt length is an **estimate of the configured local prompt body only**, counted on the server before redaction using the bundled `js-tiktoken` `o200k_base` encoding. Markdown agent bodies replace inline prompts under the existing merge rules; frontmatter is excluded. The displayed `~N tokens` is not a runtime context total: global `AGENTS.md`, injected instructions, substitutions, tools, conversation, and built-in prompts are excluded. Actual model tokenization (including GPT-6) is not guaranteed to match this encoding. No live model request is made, and no tokenizer dictionary is sent to the browser. Large prompts are processed in 8,192-character chunks without splitting surrogate pairs; chunk boundaries can slightly change the estimate. Missing/blank prompts, prompts over the existing 2 MB limit, and tokenizer failures have no estimate, rather than claiming zero runtime tokens. Only `{count, approximate: true, encoding: 'o200k_base'}` is added as entry-level `promptSize` metadata outside Raw configuration; the existing prompt text remains redacted.

### URLs and refresh

Both production (`http://127.0.0.1:4317`) and Vite development (`http://127.0.0.1:5173`) accept direct links:

- `/` — all categories collapsed.
- `/settings` — browser-local Appearance preferences, separate from configuration categories; `/settings/extra` is not found.
- `/agents` — Agents list, no automatic item selection.
- `/agents/build` — the exact configured Build definition.
- `/agents/build?open=model-settings,prompt&raw=1` — those disclosures open, prompt shown as redacted raw text.
- `/models/openai%2Fgpt-6.1-sol` — slash-containing model ID. Split paths such as `/models/openai/gpt-6.1-sol` also decode to the same ID.
- `/plugins/.%2Fplugins%2Ffoo.ts` — exact plugin ID `./plugins/foo.ts`.

Dot-only IDs use `~.` / `~..` to avoid browser path normalization; a literal leading `~` is doubled by generated links.

Category slugs are `agents`, `skills`, `commands`, `models`, `mcp-servers`, `plugins`, and `instructions`. Links encode each full ID with percent encoding, decoded exactly once (including Unicode, spaces, `%`, `?`, and `#`). Category/item/subagent links support copying and opening in a new tab. URLs only select existing snapshot entries; they never fetch filesystem paths. Unknown routes and missing definitions show not-found states with the category navigation available. Production unknown page URLs return HTTP 404; missing definitions within a valid route are detected client-side after the snapshot loads. Missing assets stay 404 and unknown API paths stay JSON 404.

Disclosures update `open` using history replacement, so opening sections adds no Back steps. Stable keys are `about` (non-agents), `model-settings`, `subagents`, `task-rules`, `prompt`, `instructions`, `context-limits`, `sources`, `provenance`, and `raw-configuration` (including nested disclosures). Legacy agent `about`, `permissions`, and `agent-rules` selections are harmless and open no unrelated section. No query means closed sections and Markdown mode. Unknown query parameters/section keys are ignored; unrelated parameters are preserved during disclosure edits and discarded on category/item/home navigation. Hashes are not used for app state. Scroll positions, filters, and mobile dropdown focus are not URL-persisted. Links depend on the server's selected configuration root and currently available definitions; they do not choose or change that root. Appearance remains in browser-local preferences.

Desktop uses a single 56px header and independently scrolling columns with a filterable item list. On narrow screens, a 48px header sits above one 52px row of side-by-side category and item dropdowns, with placeholders instead of automatic selections. Clicking the app title opens home. Path information is available in Settings on narrow screens. There are no horizontal-only navigation controls. All navigation and disclosures support native keyboard interaction. Unsupported display-field types are labeled or omitted safely, while their original values remain available in Raw configuration.

MIT licensed. Independent project; not affiliated with OpenCode.
