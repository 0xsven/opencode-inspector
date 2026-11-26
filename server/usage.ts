import { DatabaseSync } from 'node:sqlite';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { globalConfigRoot } from './config-root.js';
import { redactText } from './redact.js';
import { projectToolUsage, readDelegations } from './usage-delegations.js';
import { readSessionMetadata, unattributed, usageKey } from './usage-sessions.js';
import { attachmentMetadata, distinctAttachments, splitPartColumns, v2SkillRangeSQL } from './usage-v2.js';
import type { UsageCounts, UsageGranularity, UsageRange, UsageResponse, UsageTokens, UsageTopSession } from '../src/usage-types.js';
export type { UsageRange } from '../src/usage-types.js';

const hour = 3_600_000, day = 24 * hour;
export function parseUsageRange(query: Record<string, unknown>): UsageRange | undefined {
  if (Object.keys(query).some(key => !['from', 'to', 'timezone', 'granularity', 'project'].includes(key))) return;
  if (typeof query.from !== 'string' || !query.from.trim() || typeof query.to !== 'string' || !query.to.trim() || typeof query.timezone !== 'string') return;
  const from = Number(query.from), to = Number(query.to), timezone = query.timezone;
  if (![from, to].every(value => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())) || from >= to) return;
  const granularity = query.granularity;
  if (granularity !== undefined && granularity !== 'day' && granularity !== 'hour' && granularity !== 'week' && granularity !== 'month') return;
  const rawProjects = query.project === undefined ? [] : Array.isArray(query.project) ? query.project : [query.project];
  if (rawProjects.length > 50) return;
  const projects = new Set<string>();
  for (const project of rawProjects) {
    if (project !== unattributed.id && (typeof project !== 'string' || !/^[a-f0-9]{64}$/.test(project))) return;
    projects.add(project);
  }
  if (granularity === 'month') {
    const limit = new Date(from);
    const month = limit.getUTCMonth();
    limit.setUTCFullYear(limit.getUTCFullYear() + 100);
    if (limit.getUTCMonth() !== month && Number.isFinite(limit.getTime())) limit.setUTCDate(0); // Leap day → February 28.
    if (to > limit.getTime()) return; // An anniversary beyond the JS date limit cannot be exceeded by a valid end.
  } else if (to - from > (granularity === 'hour' ? 26 * hour : granularity === 'week' ? 100 * day : 32 * day)) return;
  // Intl also accepts numeric offsets in newer Node releases; those are not IANA zones.
  if (!timezone || /^[+-]/.test(timezone)) return;
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { return; }
  const scope = projects.size > 1 ? { projects: [...projects].sort() } : projects.size === 1 ? { project: [...projects][0] } : {};
  return { from, to, timezone, ...(granularity === undefined ? {} : { granularity }), ...scope };
}

function calendarBucketKey(timezone: string, granularity: Extract<UsageGranularity, 'week' | 'month'>) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' });
  const offsetAt = (time: number) => {
    const offset = formatter.formatToParts(time).find(part => part.type === 'timeZoneName')!.value;
    if (offset === 'GMT') return 0;
    const [hours, minutes, seconds = 0] = offset.slice(4).split(':').map(Number);
    return (offset[3] === '-' ? -1 : 1) * (hours * hour + minutes * 60_000 + seconds * 1000);
  };
  const offsets = new Map<number, number | null>();
  const keys = new Map<number, string>();
  const dateLimit = 100_000_000 * day;
  return (time: number) => {
    const utcStart = Math.floor(time / day) * day;
    let offset = offsets.get(utcStart);
    if (offset === undefined) {
      // IANA transitions are spaced more than a day apart. Use per-record
      // offsets on transition days, including historical sub-hour changes.
      const first = offsetAt(utcStart), last = offsetAt(Math.min(utcStart + day - 1, dateLimit));
      offset = first === last ? first : null;
      offsets.set(utcStart, offset);
    }
    const localDay = Math.floor((time + (offset ?? offsetAt(time))) / day);
    // The epoch was a Thursday; move back to Monday using civil-day arithmetic.
    const bucketDay = granularity === 'week' ? localDay - ((localDay + 3) % 7 + 7) % 7 : localDay;
    let key = keys.get(bucketDay);
    if (key === undefined) {
      // Near the limits, the local day or its Monday may fall outside Date.
      // A Gregorian 400-year cycle has the same month/day.
      const cycle = Math.abs(bucketDay) > 100_000_000 ? Math.sign(bucketDay) : 0;
      const date = new Date((bucketDay - cycle * 146_097) * day);
      const year = date.getUTCFullYear() + cycle * 400;
      const yearKey = year >= 0 && year < 10_000 ? String(year).padStart(4, '0')
        : `${year < 0 ? '-' : '+'}${String(Math.abs(year)).padStart(6, '0')}`;
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dateOfMonth = granularity === 'month' ? '01' : String(date.getUTCDate()).padStart(2, '0');
      key = `${yearKey}-${month}-${dateOfMonth}`;
      keys.set(bucketDay, key);
    }
    return key;
  };
}

/** Resolve once at startup. This command only prints paths, and never starts OpenCode. */
export async function resolveUsageDatabase(root: string): Promise<string | undefined> {
  const override = process.env.OPENCODE_INSPECTOR_DB;
  if (override) return path.isAbsolute(override) ? override : undefined;
  const globalRoot = globalConfigRoot();
  try {
    if (await realpath(root) !== await realpath(globalRoot)) return;
    const { stdout } = await promisify(execFile)('opencode', ['debug', 'paths', 'db'], { timeout: 5000, maxBuffer: 4096 });
    const filename = stdout.trim();
    return path.isAbsolute(filename) && !filename.includes('\n') ? filename : undefined;
  } catch { return; }
}

const emptyTokens = (): UsageTokens => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const counts = (): UsageCounts => ({ activeSessions: 0, newSessions: 0, subagentSessions: 0, steps: 0, tokens: emptyTokens() });
function add(target: UsageTokens, value: UsageTokens) {
  for (const key of Object.keys(target) as Array<keyof UsageTokens>) {
    const total = target[key] + value[key];
    if (!Number.isSafeInteger(total)) throw new Error('Unrepresentable token total');
    target[key] = total;
  }
}
export function usageName(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\x00-\x1f]/.test(value) ? redactText(value) : 'Unknown';
}
const safeJSON = (column: string) => `CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;
/** Historical IDs only: no arbitrary objects, credentials or unbounded text. */
export function usageIdentity(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$/.test(value)
    && redactText(value) === value ? value : null;
}
type Row = Record<string, any>;

export function usageTokens(raw: any): UsageTokens | undefined {
  const values = [raw?.input, raw?.output, raw?.reasoning, raw?.cache?.read, raw?.cache?.write];
  if (!values.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return;
  const [input, output, reasoning, cacheRead, cacheWrite] = values;
  const total = input + output + reasoning + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(total)) return;
  return { input, output, reasoning, cacheRead, cacheWrite, total };
}

/** The caller owns a pinned read transaction. Also used to verify projections. */
export function readUsageSnapshot(db: DatabaseSync, range: UsageRange, updatedAt: string, normalizedNames = false): UsageResponse {
  if (normalizedNames) return aggregate(db, db, range, updatedAt, true);
  const tools = new DatabaseSync(':memory:');
  try {
    projectToolUsage(db, tools, id => id);
    return aggregate(db, tools, range, updatedAt);
  } finally { tools.close(); }
}

export function readUsage(filename: string | undefined, range: UsageRange, normalizedNames = false): UsageResponse {
  const updatedAt = new Date().toISOString();
  const unavailable = (): UsageResponse => ({ status: 'unavailable', updatedAt, message: 'Recorded usage is unavailable. Check the startup database selection and local read permissions.' });
  if (!filename || !path.isAbsolute(filename)) return unavailable();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(filename, { readOnly: true });
    db.exec('PRAGMA query_only=ON');
    db.exec('BEGIN');
    const result = readUsageSnapshot(db, range, updatedAt, normalizedNames);
    db.exec('ROLLBACK');
    return result;
  } catch { return unavailable(); }
  finally { db?.close(); }
}

function aggregate(db: DatabaseSync, tools: DatabaseSync, range: UsageRange, updatedAt: string, normalizedNames = false): UsageResponse {
  // Only private, validated app indexes pass true. Names there have already been
  // validated/redacted once; repeating length validation can alter long redactions.
  const displayName = normalizedNames ? (value: unknown) => typeof value === 'string' ? value : 'Unknown' : usageName;
  // Inspect columns before querying: schema identifiers below are a fixed allowlist.
  const schema = new Map<string, Set<string>>();
  for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Row[]) {
    schema.set(row.name, new Set((db.prepare('SELECT name FROM pragma_table_info(?)').all(row.name) as Row[]).map(column => column.name)));
  }
  const has = (table: string, columns: string[]) => columns.every(column => schema.get(table)?.has(column));
  const sessionColumns = ['id', 'parent_id', 'time_created'];
  const messageColumns = ['id', 'session_id', 'time_created', 'time_updated', 'data'];
  const legacy = has('session', sessionColumns) && has('message', messageColumns);
  const v2 = has('session_v2', [...sessionColumns, 'fork_session_id']) && has('session_message', [...messageColumns, 'type']);
  if (!legacy && !v2) throw new Error('Unsupported schema');
  const warnings = new Set<string>();
  const warn = (text: string) => warnings.add(text);
  if ((schema.has('message') && !legacy) || (schema.has('session_message') && !v2)) warn('Some history tables have an unsupported schema and were excluded.');
  if (v2 && schema.has('session_part') && !has('session_part', splitPartColumns)) warn('V2 split skill history has an unsupported schema and was excluded.');
  const summary = counts();
  const active = new Set<string>(), children = new Set<string>(), fresh = new Set<string>();
  const activity = new Map<string, { value: UsageCounts & { date: string }; active: Set<string>; children: Set<string>; fresh: Set<string> }>();
  type BucketUsage = { sessions: Set<string>; steps: number; tokens: number };
  type TimelineSeries = { sessions: Set<string>; steps: number; tokens: UsageTokens; bucketsByRole: Map<'main' | 'subagent', Map<string, BucketUsage>> };
  const agents = new Map<string, TimelineSeries & { name: string }>();
  const models = new Map<string, TimelineSeries & { provider: string | null; model: string | null }>();
  const skills = new Map<string, { name: string; sessions: Set<string>; loads: number; failedLoads: number }>();
  const sessionMetadata = readSessionMetadata(tools);
  const keys = new Map<string, string>();
  const sessionKey = (id: string) => {
    if (normalizedNames) return id;
    const key = keys.get(id) ?? usageKey(id);
    keys.set(id, key);
    return key;
  };
  const projects = new Map<string, { id: string; name: string; sessions: Set<string>; steps: number; tokens: number }>();
  const rankedSessions = new Map<string, UsageTopSession>();
  const noteProject = (key: string) => {
    const project = sessionMetadata.project(key);
    let entry = projects.get(project.id);
    if (!entry) {
      entry = { ...project, sessions: new Set(), steps: 0, tokens: 0 };
      projects.set(project.id, entry);
    }
    return entry;
  };
  const selectedProjects = range.projects && new Set(range.projects);
  const inScope = (project: string) => selectedProjects ? selectedProjects.has(project) : range.project === undefined || range.project === project;
  const scopedSession = (key: string) => inScope(sessionMetadata.project(key).id);
  const eventSchema = has('event', ['type', 'aggregate_id', 'created', 'data']);
  // The previous-V2 importer keeps projections/counters but not events. A table
  // (or a later usage event) alone cannot establish imported title coverage.
  const nativeLifecycle = eventSchema ? db.prepare(`SELECT EXISTS(
    SELECT 1 FROM event WHERE aggregate_id = ? AND created = ?
    AND type IN ('session.created.1', 'session.forked.2')
    AND json_extract(${safeJSON('data')}, '$.sessionID') = ?
    AND ((type = 'session.created.1' AND json_type(${safeJSON('data')}, '$.location') = 'object')
      OR (type = 'session.forked.2' AND json_type(${safeJSON('data')}, '$.boundary') = 'object'))
  ) recorded`) : undefined;
  const checkedCoverage = new Set<string>();
  const sessionTime = v2 ? db.prepare('SELECT time_created FROM session_v2 WHERE id=?') : undefined;
  const checkCoverage = (id: string, created?: number) => {
    if (checkedCoverage.has(id)) return;
    checkedCoverage.add(id);
    const time = created ?? sessionTime?.get(id)?.time_created;
    if (time === undefined || !(nativeLifecycle?.get(id, time, id) as Row | undefined)?.recorded) {
      warn('Some V2 history lacks its retained native creation lifecycle; imported title, compaction and generate usage coverage is unverified.');
    }
  };
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: range.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateKey = (time: number) => {
    const p = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  const activityKey = range.granularity === 'week' || range.granularity === 'month'
    ? calendarBucketKey(range.timezone, range.granularity) : dateKey;
  const bucket = (time: number) => {
    const date = activityKey(time);
    let value = activity.get(date);
    if (!value) { value = { value: { date, ...counts() }, active: new Set(), children: new Set(), fresh: new Set() }; activity.set(date, value); }
    return value;
  };
  const inRange = (time: unknown): time is number => typeof time === 'number' && Number.isFinite(time) && time >= range.from && time < range.to;
  const usage = (row: Row, raw: unknown, agentName: unknown, step: boolean, providerID?: unknown, modelID?: unknown) => {
    const key = sessionKey(row.session_id);
    const project = noteProject(key);
    const value = usageTokens(raw);
    if (value) {
      project.tokens += value.total;
      if (!Number.isSafeInteger(project.tokens)) throw new Error('Unrepresentable project token total');
    }
    if (step) project.steps++;
    if (!inScope(project.id)) return;
    const tokenTotal = value?.total ?? 0;
    if (step || tokenTotal > 0) {
      const root = sessionMetadata.root(key);
      if (root) {
        let entry = rankedSessions.get(root.key);
        if (!entry) {
          entry = { id: root.key, title: root.title, project: root.name, steps: 0, tokens: 0 };
          rankedSessions.set(root.key, entry);
        }
        if (step) entry.steps++;
        entry.tokens += tokenTotal;
        if (!Number.isSafeInteger(entry.tokens)) throw new Error('Unrepresentable session token total');
      }
    }
    const role = row.parent_id === null ? 'main' : 'subagent';
    const agent = displayName(agentName);
    let entry = agents.get(agent);
    if (!entry) { entry = { name: agent, sessions: new Set(), steps: 0, tokens: emptyTokens(), bucketsByRole: new Map() }; agents.set(agent, entry); }
    entry.sessions.add(row.session_id);
    const provider = usageIdentity(providerID), model = usageIdentity(modelID);
    const modelKey = JSON.stringify([provider, model]);
    let modelEntry = models.get(modelKey);
    if (!modelEntry) { modelEntry = { provider, model, sessions: new Set(), steps: 0, tokens: emptyTokens(), bucketsByRole: new Map() }; models.set(modelKey, modelEntry); }
    modelEntry.sessions.add(row.session_id);
    const period = bucket(row.time_created).value;
    if (step) { summary.steps++; period.steps++; entry.steps++; modelEntry.steps++; }
    // Real elapsed hours keep the repeated hour on fall-back days distinct.
    const timeKey = range.granularity === 'hour' ? new Date(range.from + Math.floor((row.time_created - range.from) / hour) * hour).toISOString() : period.date;
    for (const series of [entry, modelEntry]) {
      let roleBuckets = series.bucketsByRole.get(role);
      if (!roleBuckets) { roleBuckets = new Map(); series.bucketsByRole.set(role, roleBuckets); }
      let rolePeriod = roleBuckets.get(timeKey);
      if (!rolePeriod) { rolePeriod = { sessions: new Set(), steps: 0, tokens: 0 }; roleBuckets.set(timeKey, rolePeriod); }
      rolePeriod.sessions.add(row.session_id);
      if (step) rolePeriod.steps++;
      if (value) rolePeriod.tokens += value.total;
    }
    if (!value) { warn('Some usage records have missing or invalid token counters; totals include only known counters.'); return; }
    add(summary.tokens, value); add(period.tokens, value); add(entry.tokens, value); add(modelEntry.tokens, value);
  };
  const skill = (session: string, name: string, status: unknown, time: unknown) => {
    if (status !== 'completed' && status !== 'error') return;
    if (typeof time !== 'number' || !Number.isFinite(time)) {
      if (scopedSession(sessionKey(session))) warn('Some terminal skill attempts lack a completion timestamp and could not be assigned to the range.');
      return;
    }
    if (!inRange(time)) return;
    if (!inScope(noteProject(sessionKey(session)).id)) return;
    let entry = skills.get(name);
    if (!entry) { entry = { name, sessions: new Set(), loads: 0, failedLoads: 0 }; skills.set(name, entry); }
    entry.sessions.add(session);
    if (status === 'completed') entry.loads++; else entry.failedLoads++;
    return true;
  };

  // Migration keeps IDs. For overlaps select the most recently updated record;
  // ties prefer the original V1 metadata (migration can rewrite embedded times).
  // Table creation time is the accounting time in both implementations.
  for (const format of [legacy ? 'legacy' : '', v2 ? 'v2' : ''].filter(Boolean)) {
    const isV2 = format === 'v2';
    const table = isV2 ? 'session_message' : 'message', sessions = isV2 ? 'session_v2' : 'session';
    const other = isV2 ? 'message' : 'session_message';
    const overlap = legacy && v2;
    const join = overlap ? `LEFT JOIN ${other} o ON o.id = m.id AND o.session_id = m.session_id` : '';
    const selected = overlap ? isV2 ? '(o.id IS NULL OR m.time_updated > o.time_updated)' : '(o.id IS NULL OR m.time_updated >= o.time_updated)' : '1';
    const time = 'm.time_created';
    const json = safeJSON('m.data');
    const kind = isV2 ? 'm.type' : `json_extract(${json}, '$.role')`;
    // Session-first preserves the upstream (session_id,time_created) index for
    // bounded message reads instead of scanning the transcript table.
    const source = `FROM ${sessions} s CROSS JOIN ${table} m ON s.id = m.session_id ${join}`;
    // Both fork implementations preserve source history time. V1 migration also
    // preserves the table timestamp, even when it changes the embedded JSON time.
    const original = `${time} >= s.time_created`;
    // Creation cohorts are independent of the requested activity window. EXISTS
    // stops at the first retained original user/assistant record, even when that
    // activity happened after this range. Empty and copied-only launches stay out.
    const created = db.prepare(`SELECT s.id, s.time_created session_created FROM ${sessions} s
      WHERE s.parent_id IS NULL AND s.time_created >= ? AND s.time_created < ?
      AND EXISTS(SELECT 1 FROM ${table} m ${join} WHERE m.session_id = s.id
        AND ${selected} AND ${original} AND json_valid(m.data) AND ${kind} IN ('user', 'assistant'))`).iterate(range.from, range.to) as Iterable<Row>;
    for (const row of created) {
      if (!inScope(noteProject(sessionKey(row.id)).id)) continue;
      fresh.add(row.id); bucket(row.session_created).fresh.add(row.id);
      if (isV2) checkCoverage(row.id, row.session_created);
    }
    const rows = db.prepare(`SELECT m.id, m.session_id, ${time} time_created, s.parent_id, s.time_created session_created,
      ${isV2 ? 'm.type' : 'NULL'} kind,
      ${isV2 ? attachmentMetadata(json, 'm.type') : 'NULL'} attachments,
      CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role', '$.agent', '$.tokens', '$.status', '${isV2 ? '$.model.providerID' : '$.providerID'}', '${isV2 ? '$.model.id' : '$.modelID'}') ELSE NULL END metadata
      ${source} WHERE ${selected} AND ${original} AND ${time} >= ? AND ${time} < ?`).iterate(range.from, range.to) as Iterable<Row>;
    for (const row of rows) {
      const key = sessionKey(row.session_id);
      const scoped = scopedSession(key);
      if (row.metadata === null) { if (scoped) warn('Malformed history records were excluded.'); continue; }
      if (isV2 && scoped) checkCoverage(row.session_id, row.session_created);
      const [role, agent, rawTokens, status, providerID, modelID] = JSON.parse(row.metadata);
      if (!isV2) row.kind = role;
      if (scoped && row.kind === 'compaction' && status === 'completed' && !rawTokens) {
        warn('Some migrated compactions have no retained token counters; compaction usage may be incomplete.');
      }
      // UsageRecorded has no compaction/message ID. Session identity, time ranges
      // and identical token tuples cannot prove correspondence one-to-one. Keep
      // durable-only accounting and conservatively disclose that uncertainty.
      if (scoped && row.kind === 'compaction' && rawTokens) {
        warn('Compaction projection-to-event correspondence is unverified; totals include only retained durable usage events.');
      }
      if (row.kind === 'user' || row.kind === 'assistant') {
        const project = noteProject(key);
        if (row.parent_id === null) project.sessions.add(key);
        if (scoped) {
          const period = bucket(row.time_created);
          if (row.parent_id === null) {
            active.add(row.session_id); period.active.add(row.session_id);
          } else { children.add(row.session_id); period.children.add(row.session_id); }
        }
        if (row.kind === 'assistant') {
          usage(row, rawTokens, agent, true, providerID, modelID);
        } else if (row.attachments) {
          for (const { id, name } of distinctAttachments(row.attachments)) {
            if (!id) { if (scoped) warn('Some V2 skill attachments lack a recorded ID and were excluded.'); continue; }
            skill(row.session_id, displayName(name), 'completed', row.time_created);
          }
        }
      }
    }
    if (!isV2) {
      if (!has('part', ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'])) { warn('Skill load history is unavailable for legacy records.'); continue; }
      const p = safeJSON('p.data');
      // Scan parts once in storage order, checking timestamps before message/session
      // lookups. This also preserves first-wins duplicate-call handling without a
      // materialized candidate table, second part fetch or sort. CASE defers JSON
      // until after message reconciliation and fork filtering. Do not bound message
      // creation/updates from below: older calls can finish in range without updating
      // their parent. Terminal status is handled only after duplicate-call selection.
      const partKey = (db.prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = 'part'").get() as Row).wr ? 'id' : 'rowid';
      const calls = db.prepare(`SELECT m.id, m.session_id,
        json_extract(${p}, '$.callID', '$.state.status', '$.state.input.name', '$.state.metadata.name', '$.state.time.end') metadata
        FROM part p NOT INDEXED CROSS JOIN message m ON m.id = p.message_id
        CROSS JOIN session s ON s.id = m.session_id ${join}
        WHERE p.time_updated >= ?2 AND p.time_created < ?3 AND p.session_id = m.session_id
        AND CASE WHEN ${selected} AND ${original} AND m.time_created < ?1
          THEN json_extract(${p}, '$.tool') = 'skill' AND json_extract(${p}, '$.type') = 'tool'
          ELSE 0 END
        ORDER BY p.${partKey}`).iterate(range.to, range.from, range.to) as Iterable<Row>;
      const seen = new Set<string>();
      for (const row of calls) {
        const [id, status, input, label, end] = JSON.parse(row.metadata);
        const key = JSON.stringify([row.session_id, row.id, id]);
        if (seen.has(key)) { if (scopedSession(sessionKey(row.session_id))) warn('Duplicate legacy skill records were excluded.'); continue; }
        seen.add(key);
        skill(row.session_id, displayName(label ?? input), status, end);
      }
    } else {
      const skillWarnings = tools.prepare(range.project || selectedProjects
        ? 'SELECT message,owner FROM inspector_v2_skill_warning WHERE earliest<?'
        : 'SELECT DISTINCT message FROM inspector_v2_skill_warning WHERE earliest<?');
      for (const row of skillWarnings.iterate(range.to) as Iterable<Row>) {
        if (!row.owner || scopedSession(row.owner)) warn(row.message);
      }
      for (const row of tools.prepare(v2SkillRangeSQL).iterate(range.from, range.to) as Iterable<Row>) {
        if (skill(row.session_id, row.name, row.status, row.completed)) checkCoverage(row.session_id);
      }
      // Skill.Activated is an explicit activation, not a Tool.Success projection.
      // The tool implementation does not emit it: each represents a distinct load.
      const activations = db.prepare(`SELECT m.session_id, ${time} time_created, s.time_created session_created,
        json_extract(${json}, '$.name', '$.skill') metadata ${source}
        WHERE ${selected} AND ${original} AND ${kind} = 'skill' AND ${time} >= ? AND ${time} < ?`).iterate(range.from, range.to) as Iterable<Row>;
      for (const row of activations) {
        const [label, id] = JSON.parse(row.metadata);
        if (skill(row.session_id, displayName(label ?? id), 'completed', row.time_created)) checkCoverage(row.session_id, row.session_created);
      }
    }
  }

  if (v2) {
    if (eventSchema) {
      const json = safeJSON('e.data');
      // Compaction projections repeat these counters. Only durable usage events
      // are counted. Title and generate events likewise lack assistant attribution.
      const events = db.prepare(`SELECT e.aggregate_id session_id, e.created time_created, s.time_created session_created, s.parent_id,
        json_extract(${json}, '$.tokens') tokens
        FROM session_v2 s CROSS JOIN event e ON s.id = e.aggregate_id
        WHERE e.type = 'session.usage.recorded.1' AND e.created >= ? AND e.created < ?
        AND e.created >= s.time_created AND json_extract(${json}, '$.source') IN ('compaction', 'title', 'generate')`).iterate(range.from, range.to) as Iterable<Row>;
      for (const row of events) {
        if (scopedSession(sessionKey(row.session_id))) checkCoverage(row.session_id, row.session_created);
        usage(row, row.tokens ? JSON.parse(row.tokens) : undefined, undefined, false);
      }
    } else warn('V2 durable usage events are unavailable; compaction, title and generate token usage may be incomplete.');
  }
  summary.activeSessions = active.size; summary.newSessions = fresh.size; summary.subagentSessions = children.size;
  const delegations = readDelegations(tools, range, (key, inPeriod) =>
    inPeriod ? inScope(noteProject(key).id) : scopedSession(key));
  for (const warning of delegations.warnings) warn(warning);
  const rankedModels = [...models.values()].sort((a, b) => b.tokens.total - a.tokens.total || (a.provider ?? '').localeCompare(b.provider ?? '') || (a.model ?? '').localeCompare(b.model ?? ''));
  const rankedAgents = [...agents.values()].sort((a, b) => b.tokens.total - a.tokens.total || a.name.localeCompare(b.name));
  const topSessions = (measure: 'steps' | 'tokens') => [...rankedSessions.values()].filter(session => session[measure] > 0)
    .sort((a, b) => b[measure] - a[measure] || a.id.localeCompare(b.id)).slice(0, 10);
  const roleBuckets = (buckets: TimelineSeries['bucketsByRole']) => (['main', 'subagent'] as const).flatMap(role =>
    [...(buckets.get(role) ?? [])].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { tokens, steps, sessions }]) => ({ date, role, tokens, steps, sessions: sessions.size })));
  return {
    status: warnings.size ? 'partial' : 'available', updatedAt, range,
    formats: [legacy ? 'legacy' : '', v2 ? 'v2' : ''].filter(Boolean), warnings: [...warnings].sort(), summary, delegations,
    projects: [...projects.values()].map(({ sessions, ...project }) => ({ ...project, sessions: sessions.size }))
      .sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    topSessions: topSessions('steps'),
    topSessionsByTokens: topSessions('tokens'),
    activity: [...activity.values()].map(({ value, active, children, fresh }) => ({ ...value, activeSessions: active.size, newSessions: fresh.size, subagentSessions: children.size })).sort((a, b) => a.date.localeCompare(b.date)),
    agents: rankedAgents.map(({ name, sessions, steps, tokens }) => ({ name, sessions: sessions.size, steps, tokens })),
    agentActivity: rankedAgents.flatMap(({ name: agent, bucketsByRole }) => roleBuckets(bucketsByRole).map(bucket => ({ ...bucket, agent }))),
    models: rankedModels.map(({ provider, model, sessions, steps, tokens }) => ({ provider, model, sessions: sessions.size, steps, tokens })),
    modelActivity: rankedModels.flatMap(({ provider, model, bucketsByRole }) => roleBuckets(bucketsByRole)
      .map(bucket => ({ ...bucket, provider, model }))),
    skills: [...skills.values()].map(entry => ({ ...entry, sessions: entry.sessions.size })).sort((a, b) => b.loads - a.loads || a.name.localeCompare(b.name)),
  };
}
