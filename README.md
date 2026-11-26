# Understand your OpenCode usage

![Build agent view in OpenCode Inspector](screenshot.png)

## Get started

Requires Git and Node.js 22.13+ (built-in SQLite, no experimental flag required).

```sh
git clone https://github.com/0xsven/opencode-inspector.git
cd opencode-inspector
npm ci && npm run build && npm start
```

Open **http://127.0.0.1:4317** to see recorded usage. Use the page dropdown next
to **OpenCode Inspector** to switch Usage views, open **Config**, or go to **Settings**.
Inspector runs locally and reads `$XDG_CONFIG_HOME/opencode` when set, or
`~/.config/opencode`, without changing it. Stop with Ctrl+C.
After rebuilding an update, stop and restart Inspector so the running API and
browser bundle are both on the new version.

Usage lives at `/usage` (also the landing page at `/`), with Agents, Models,
and Skills under `/usage/`. Configuration lives at `/config`, with category
lists at `/config/<category>` and individual definitions at
`/config/<category>/<id>`. Browser Back restores the category list's filter and
scroll position. Settings live at `/settings` and
`/settings/theme`. Older links such as `/agents/build`, `/usage/overview`, and
`/settings/general` still work.

The configuration views inspect V1 and native V2 definitions in the selected
directory. They don't resolve OpenCode's full project configuration, runtime
permissions or MCP connection state. Theme Follow reads the global terminal
settings; OpenCode Desktop's appearance preferences are separate.

## Recorded usage index

Usage's first request builds a private metadata-only SQLite index in a separate
child process. Initial indexing can take more than a second; configuration/API
requests remain responsive. OpenCode's database is always opened read-only with
`query_only`, including its live WAL. No source indexes or journaling settings
are changed. The app index contains hashed identities, timestamps, token counters,
redacted labels (including project names and session titles), delegation statuses,
hashed child-session links, and coverage metadata. It does not copy transcripts,
tool output, or complete source records. Session titles can still reveal what you
worked on; check Overview before sharing a screenshot.

With the default config root, Inspector asks the `opencode` CLI on its `PATH`
where the local database is. Terminal and Desktop history can appear together
when both use the same local service. If the Desktop CLI is not on `PATH` or
the desired local database is elsewhere, set `OPENCODE_INSPECTOR_DB` to its
absolute path before starting Inspector. A custom config root does not
automatically select your personal history.

Usage Overview shows active sessions, assistant steps, and tokens for the
selected period. The shared **Tokens / Steps** switch changes the usage charts
and rankings on Overview, Agents, and Models. The Overview's Projects, Top
sessions, Models, and Agents lists show up to ten entries by the selected
measure. Top sessions include work from verified linked subagents; neither
measure estimates hours worked. The filter menu next to
the date range scopes all Usage totals to one project without changing
the dates. The dropdown shows the current project; choose **All projects** to
clear the filter. The Agent and Model timelines have their own role controls,
and the delegation trees have a Main agent picker.
Project attribution uses the session's project in the indexed snapshot, not
where the session was when each step ran. History that cannot be assigned to a
project remains under Unattributed.

Usage → Agents includes delegation trees above the data table. Circles share a
count-to-area scale and represent recorded delegation attempts created in the
selected period, including failed or unfinished calls—not completed executions.
Uncertain ancestry stays separate, and out-of-period ancestors are context only.
Usage reads both inline and separate V2 tool records. Skill loads include
successful tool calls, explicit activations, and distinct skill attachments
on delivered V2 user messages. The Skills chart and table both rank by total
load attempts, with successful and failed loads shown separately.

Usage → Models groups recorded assistant usage by provider/model pair, with distinct
contributing root/child sessions, assistant steps, and disjoint token categories.
It uses legacy assistant `providerID`/`modelID` and V2 `model.providerID`/`model.id`,
never the configured model catalog. Missing or invalid identities display as
Unknown. Durable title, compaction, and session-generation usage records contain
no model identity, so their tokens stay Unknown with zero assistant steps.
Per-model tokens and steps reconcile to the period summary; session counts
overlap when a session uses multiple models.
The Models and Agents timelines compare tokens or assistant steps
by provider/model or agent, with stacked bars or individual trend lines.
Filter either timeline to main agents (root sessions) or subagents (child
sessions). In Delegation trees, select a main agent to see its recorded branches.
Day uses hourly buckets; 7 days and Month use local calendar days. The
seven-day view defaults to today and the six preceding days. Token and step
totals in All agents reconcile to Usage Overview.

The index persists under `$XDG_CACHE_HOME/opencode-inspector/usage`, or
`~/Library/Caches/opencode-inspector/usage` on macOS (`~/.cache` on other systems).
Its directory is private (0700), files are 0600, and only complete builds are
atomically published. Subsequent periods and app restarts read that snapshot.
The index timestamp is the source snapshot time, not the request time. While
Usage is visible, Inspector checks the source DB/WAL for changes and rebuilds
the index in the background when needed. It keeps the previous snapshot visible
until the new one is ready. Automatic rebuilds wait at least five minutes after
a successful build before starting again. The toolbar status button shows
active indexing and warnings, and offers Retry on failure. Automatic retries back off after a
failed update; a failed initial build requires an explicit retry. Source
replacement gets a separate index.

To manually scan all recorded history again, open **Settings → Indexing** and
choose **Rebuild index**. This bypasses the automatic wait. Inspector keeps
the last usable snapshot until the rebuild succeeds and never changes
OpenCode's database.
Copied timestamps must be valid numeric epoch milliseconds; unexpected text/blob
values fail indexing with a sanitized error. Cache schema changes rebuild the
index rather than serving older projections.

SIGINT/SIGTERM close the API and await its indexing child and temporary-file
cleanup. The launcher allows five seconds for graceful shutdown before forcing
unresponsive direct children to exit. Build coalescing is per process: independent
processes sharing a cache are not coordinated and may overwrite newer snapshots.
The standard fixed API port prevents concurrent serving instances.

### Usage API lifecycle (frontend integration)

`GET /api/usage?from=<ms>&to=<exclusive-ms>&timezone=<IANA>` returns HTTP 200 with
`IndexedUsageResponse` from `src/usage-types.ts`. Existing origin/host/method guards
apply; source/cache paths cannot be selected through the API. Add
`granularity=hour` for up to 26 hours to get hourly agent/model timeline buckets
starting at `from`. The default uses local calendar days. Longer ranges use
`granularity=week` (Monday starts) or `granularity=month` (first of the month)
for both the activity summary and the timelines.
Use `project=<id>` with an opaque ID from the response's `projects` list to
scope usage. Repeat `project` to include any of the selected projects (up to 50
values). The project list itself always describes the unfiltered period.

- Initial build: `status: "indexing"`, range, and `index.state: "indexing"`; there
  are no summary/activity/agent/model/skill arrays yet. Show an indexing state, not zeros.
- Ready: existing `available`/`partial` accounting DTO plus `index` with `state`,
  `indexedAt`, `sourceChanged`, and optional sanitized `message`. `updatedAt` also
  equals `indexedAt`. Coverage warnings retain their existing meaning.
- `GET /api/usage/status` returns just the index state, without running a usage
  range query. A visible Usage page uses it to check freshness, request an
  automatic background update when needed, and detect a new snapshot. Only then
  does it reload the selected range.
- Settings uses `GET /api/usage/index?mode=observe` to check without starting a
  job and `mode=rebuild` to explicitly request a full rebuild.
- Send **one** range request with `&refresh=1` on explicit Retry. It returns old
  data with `index.state: "refreshing"` (or `status: "indexing"` if no snapshot exists).
- `sourceChanged: true` means history may have changed since indexing; `null`
  means the source cannot be checked. A change signal is not a row-level delta:
  updates still rebuild the complete index so edits and deletes are included.
- Failed refresh: old data, `status: "partial"`, `index.state: "failed"`, warning
  and message. Failed initial build: `status: "unavailable"`, no invented counts.
  Initial indexing can take up to ten minutes before the build is failed; server
  close terminates its child.

Development launches `server/usage-worker.ts` with the existing tsx loader;
`npm run build` produces both `dist/server/index.js` and the standalone
`dist/server/usage-worker.js`. No extra service or dependency is required.
