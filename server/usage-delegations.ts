import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { usageName, type UsageRange } from './usage.js';
import { splitPartColumns, v2ToolMetadata } from './usage-v2.js';
import type { UsageDelegations, UsageDelegationNode, UsageDelegationStatus } from '../src/usage-types.js';

type Row = Record<string, any>;
type Call = { key: string; session: string; created: number | null; caller: string | null; callee: string | null; status: UsageDelegationStatus; child: string | null };
const statuses = ['pending', 'streaming', 'running', 'completed', 'error', 'unknown'] as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
const name = (value: unknown) => validName(value) ? usageName(value) : null;
const key = (value: unknown) => validName(value) ? hash(value) : null;
const time = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime()) ? value : null;
const safe = (column: string) => `CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;
const emptyStatuses = () => Object.fromEntries(statuses.map(status => [status, 0])) as Record<UsageDelegationStatus, number>;

/** Materialized once per index snapshot. Only scalar allowlisted metadata crosses
 * this boundary; transcript/tool input/output/error objects are never selected.
 * The live reader uses this same projection in memory for accounting equivalence.
 */
export function projectToolUsage(source: DatabaseSync, target: DatabaseSync, skillSessionID: (id: string) => string | null) {
  const schema = new Map<string, Set<string>>();
  for (const row of source.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Row[]) {
    schema.set(row.name, new Set((source.prepare('SELECT name FROM pragma_table_info(?)').all(row.name) as Row[]).map(column => column.name)));
  }
  const has = (table: string, columns: string[]) => columns.every(column => schema.get(table)?.has(column));
  const legacy = has('session', ['id', 'parent_id', 'time_created']) && has('message', ['id', 'session_id', 'time_created', 'time_updated', 'data']);
  const v2 = has('session_v2', ['id', 'parent_id', 'time_created', 'fork_session_id']) && has('session_message', ['id', 'session_id', 'time_created', 'time_updated', 'data', 'type']);
  target.exec(`CREATE TABLE inspector_delegation_session(key TEXT PRIMARY KEY, parent TEXT, known INTEGER NOT NULL);
    CREATE TABLE inspector_delegation_call(key TEXT PRIMARY KEY, session TEXT NOT NULL, message TEXT NOT NULL,
      created INTEGER, caller TEXT, callee TEXT, status TEXT NOT NULL, child TEXT, resume TEXT);
    CREATE TABLE inspector_delegation_warning(message TEXT PRIMARY KEY);
    CREATE TABLE inspector_v2_skill(session_id TEXT NOT NULL, owner_created INTEGER NOT NULL, completed INTEGER NOT NULL, status TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE inspector_v2_skill_warning(message TEXT PRIMARY KEY, earliest INTEGER NOT NULL);`);
  const warnings = new Set<string>();
  const warn = (text: string) => warnings.add(text);
  const insertSession = target.prepare(`INSERT INTO inspector_delegation_session VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET known=CASE WHEN parent IS excluded.parent AND known=1 AND excluded.known=1 THEN 1 ELSE 0 END`);
  for (const table of [legacy ? 'session' : '', v2 ? 'session_v2' : ''].filter(Boolean)) {
    for (const row of source.prepare(`SELECT id,parent_id FROM ${table}`).iterate() as Iterable<Row>) {
      const session = key(row.id);
      if (!session) { warn('Some delegation sessions have invalid identities; ancestry is incomplete.'); continue; }
      const parent = key(row.parent_id);
      insertSession.run(session, parent, row.parent_id === null || parent !== null ? 1 : 0);
    }
  }
  if ((schema.has('message') && !legacy) || (schema.has('session_message') && !v2)) warn('Some delegation history has an unsupported schema and was excluded.');
  const split = has('session_part', splitPartColumns);
  if (v2 && schema.has('session_part') && !split) warn('V2 split delegation history has an unsupported schema and was excluded.');
  const insert = target.prepare('INSERT OR IGNORE INTO inspector_delegation_call VALUES(?,?,?,?,?,?,?,?,?)');
  const store = (row: Row, metadata: unknown[], format: string) => {
    const [call, status, caller, callee, child, resume, created] = metadata;
    const session = key(row.session_id), message = key(row.message_id);
    if (!session || !message) { warn('Some delegation records have invalid owner identities and were excluded.'); return; }
    const callKey = format === 'legacy' ? key(call) : typeof call === 'string' && call ? hash(call) : null;
    if (!callKey) warn('Some delegation call identities are missing or invalid; distinct record-local identities were used.');
    const identity = hash([session, message, callKey ?? [format, row.record]]);
    const state = statuses.includes(status as UsageDelegationStatus) ? status as UsageDelegationStatus : 'unknown';
    if (state === 'unknown') warn('Some delegation records have unknown lifecycle states.');
    const result = insert.run(identity, session, message, time(created), name(caller), name(callee), state, key(child), key(resume));
    if (!result.changes) warn('Duplicate delegation call records were excluded.');
  };
  // Reconcile the owning message BEFORE expanding parts/content. IDs alone in a
  // different session are not overlaps. Ties keep the original legacy metadata.
  for (const format of [legacy ? 'legacy' : '', v2 ? 'v2' : ''].filter(Boolean)) {
    const isV2 = format === 'v2', table = isV2 ? 'session_message' : 'message', sessions = isV2 ? 'session_v2' : 'session';
    const other = isV2 ? 'message' : 'session_message';
    const join = legacy && v2 ? `LEFT JOIN ${other} o ON o.id=m.id AND o.session_id=m.session_id` : '';
    const selected = legacy && v2 ? `(o.id IS NULL OR m.time_updated ${isV2 ? '>' : '>='} o.time_updated)` : '1';
    const m = safe('m.data');
    const original = 'm.time_created >= s.time_created';
    if (!isV2) {
      if (!has('part', ['id', 'session_id', 'message_id', 'time_created', 'data'])) { warn('Legacy delegation tool history is unavailable.'); continue; }
      const p = safe('p.data');
      const order = (source.prepare("SELECT wr FROM pragma_table_list WHERE schema='main' AND name='part'").get() as Row).wr ? 'id' : 'rowid';
      const rows = source.prepare(`SELECT p.id record,m.id message_id,m.session_id,
        json_extract(${p}, '$.callID', '$.state.status') state,
        json_quote(json_extract(${m}, '$.agent')) caller,
        json_extract(${p}, '$.state.input.subagent_type', '$.state.metadata.sessionId', '$.state.input.task_id') labels,
        p.time_created created
        FROM part p NOT INDEXED CROSS JOIN message m ON m.id=p.message_id AND m.session_id=p.session_id
        CROSS JOIN session s ON s.id=m.session_id ${join}
        WHERE ${selected} AND ${original} AND json_extract(${m}, '$.role')='assistant'
        AND json_extract(${p}, '$.type')='tool' AND json_extract(${p}, '$.tool')='task'
        ORDER BY p.${order}`).iterate() as Iterable<Row>;
      for (const row of rows) {
        const [call, status] = JSON.parse(row.state), [callee, child, resume] = JSON.parse(row.labels);
        store(row, [call, status, JSON.parse(row.caller), callee, child, resume, row.created], format);
      }
    } else {
      const invalidContent = source.prepare(`SELECT EXISTS(SELECT 1
        FROM session_v2 s CROSS JOIN session_message m ON s.id=m.session_id ${join}
        WHERE ${selected} AND ${original} AND m.type='assistant'
        AND json_type(${m}, '$.content') IS NOT NULL AND json_type(${m}, '$.content')!='array') invalid`).get() as Row;
      if (invalidContent.invalid) warn('Some V2 delegation content has an unsupported shape and was excluded.');
      const insertSkill = target.prepare('INSERT INTO inspector_v2_skill VALUES(?,?,?,?,?)');
      const skillWarning = target.prepare(`INSERT INTO inspector_v2_skill_warning VALUES(?,?)
        ON CONFLICT(message) DO UPDATE SET earliest=min(earliest,excluded.earliest)`);
      for (const row of v2ToolMetadata(source, legacy, split)) {
        if (row.duplicate) {
          if (row.tool === 'skill') skillWarning.run('Duplicate V2 skill records were excluded.', row.owner_created);
          else warn('Duplicate delegation call records were excluded.');
          continue;
        }
        if (row.tool === 'skill') {
          const [status, input, inputID, label, end] = JSON.parse(row.metadata);
          if (status !== 'completed' && status !== 'error') continue;
          if (typeof end !== 'number' || !Number.isFinite(end)) {
            skillWarning.run('Some terminal skill attempts lack a completion timestamp and could not be assigned to the range.', row.owner_created);
          } else insertSkill.run(skillSessionID(row.session_id), row.owner_created, end, status, usageName(label ?? input ?? inputID));
          continue;
        }
        const [status, callee, child, resume, created] = JSON.parse(row.metadata);
        if (row.tool === 'task') warn('V2 task records may retain migrated creation timestamps or interrupted lifecycle states.');
        store(row, [row.call, status, JSON.parse(row.caller), callee, child, resume, created], row.storage === 0 ? 'split' : 'inline');
      }
    }
  }
  target.exec(`CREATE INDEX inspector_delegation_time ON inspector_delegation_call(created,key);
    CREATE INDEX inspector_delegation_child ON inspector_delegation_call(child,created,key);
    CREATE INDEX inspector_v2_skill_completed ON inspector_v2_skill(completed);`);
  const insertWarning = target.prepare('INSERT INTO inspector_delegation_warning VALUES(?)');
  for (const warning of warnings) insertWarning.run(warning);
}

type Segment = Pick<UsageDelegationNode, 'agent' | 'role' | 'ancestry'>;
type Ancestry = UsageDelegationNode['ancestry'];
type Resolved = { path: Segment[]; sessions: string[]; reason: Ancestry };
const maxDepth = 32, maxCandidates = 64, maxWork = 256, maxNodes = 2000;

// Keep both predicates as index seeks on (child,created,key). Combining these
// with OR can leave SQLite scanning every future resume for each period call.
// Export the exact production SQL for query-plan regression checks.
export const delegationInboundSQL = {
  timed: `SELECT key,session,created,caller,callee,status,child FROM inspector_delegation_call
    WHERE child=? AND created<=? ORDER BY created,key LIMIT ?`,
  unlocated: `SELECT key,session,created,caller,callee,status,child FROM inspector_delegation_call
    WHERE child=? AND created IS NULL ORDER BY key LIMIT ?`,
};

export function readDelegations(db: DatabaseSync, range: UsageRange): UsageDelegations {
  const warnings = new Set((db.prepare('SELECT message FROM inspector_delegation_warning ORDER BY message').all() as Array<{ message: string }>).map(row => row.message));
  const unlocatedAttempts = (db.prepare('SELECT count(*) n FROM inspector_delegation_call WHERE created IS NULL').get() as { n: number }).n;
  if (unlocatedAttempts) warnings.add('Some delegation attempts lack a valid creation timestamp and cannot be assigned to a period.');
  const session = db.prepare('SELECT parent,known FROM inspector_delegation_session WHERE key=?');
  const inbound = db.prepare(delegationInboundSQL.timed);
  const inboundUnlocated = db.prepare(delegationInboundSQL.unlocated);
  const cache = new Map<string, Resolved>();
  const resolve = (call: Call, visited: Set<string>, work: { remaining: number }): Resolved => {
    const fail = (reason: Ancestry): Resolved => ({ path: [], sessions: [], reason });
    if (visited.has(call.session)) return fail('cycle');
    if (visited.size >= maxDepth || --work.remaining < 0) return fail('limited');
    const cached = cache.get(call.key);
    if (cached) {
      if (cached.sessions.some(id => visited.has(id))) return fail('cycle');
      return cached.sessions.length + visited.size > maxDepth ? fail('limited') : cached;
    }
    const owner = session.get(call.session) as { parent: string | null; known: number } | undefined;
    if (!owner?.known) return fail('unknown');
    if (owner.parent === null) {
      const result: Resolved = { path: [{ agent: call.caller, role: 'main', ancestry: call.caller === null ? 'unknown' : 'verified' }], sessions: [call.session], reason: call.caller === null ? 'unknown' : 'verified' };
      cache.set(call.key, result); return result;
    }
    if (call.created === null || call.caller === null) return fail('unknown');
    // Match the previous NULL-first ordering and shared candidate cap, without
    // traversing out-of-range resumes. Unknown timestamps still block certainty.
    const candidates = inboundUnlocated.all(call.session, maxCandidates + 1) as Call[];
    if (candidates.length <= maxCandidates) candidates.push(...inbound.all(call.session, call.created, maxCandidates + 1 - candidates.length) as Call[]);
    if (candidates.length > maxCandidates) return fail('limited');
    if (!candidates.length) return fail('unknown');
    const next = new Set(visited).add(call.session);
    let result: Resolved | undefined;
    for (const candidate of candidates) {
      // Session ownership is not an invocation link. In particular, legacy task
      // resumes can point outside parent_id; keep such associations unproven.
      if (candidate.session !== owner.parent || candidate.created === null) return fail('unknown');
      const parent = resolve(candidate, next, work);
      if (parent.reason !== 'verified') return fail(parent.reason);
      if (candidate.callee !== call.caller) return fail('ambiguous');
      const path: Segment[] = [...parent.path, { agent: call.caller, role: 'subagent', ancestry: 'verified' }];
      if (result && JSON.stringify(result.path) !== JSON.stringify(path)) return fail('ambiguous');
      result = { path, sessions: [...new Set([...(result?.sessions ?? []), ...parent.sessions, call.session])], reason: 'verified' };
    }
    if (result) { cache.set(call.key, result); return result; }
    return fail('unknown');
  };
  const nodes = new Map<string, UsageDelegationNode>();
  const overflowPath: Segment[] = [{ agent: null, role: 'unknown', ancestry: 'limited' }, { agent: null, role: 'unknown', ancestry: 'limited' }];
  const overflowRoot = hash([null, overflowPath[0]]);
  const overflowIDs = new Set([overflowRoot, hash([overflowRoot, overflowPath[1]])]);
  let regularNodes = 0;
  const ensure = (path: Segment[]) => {
    let parentId: string | null = null;
    return path.map((segment, index) => {
      const id = hash([parentId, segment]);
      let node = nodes.get(id);
      if (!node) {
        node = { ...segment, id, parentId, countBasis: index === 0 ? 'outgoing' : 'incoming', attempts: 0, statuses: emptyStatuses(), contextOnly: true };
        nodes.set(id, node);
        if (!overflowIDs.has(id)) regularNodes++;
      }
      parentId = id;
      return node;
    });
  };
  const increment = (node: UsageDelegationNode, status: UsageDelegationStatus) => { node.attempts++; node.statuses[status]++; node.contextOnly = false; };
  let totalAttempts = 0;
  const rows = db.prepare(`SELECT key,session,created,caller,callee,status,child FROM inspector_delegation_call
    WHERE created>=? AND created<? ORDER BY created,key`).iterate(range.from, range.to) as Iterable<Call>;
  for (const call of rows) {
    totalAttempts++;
    const resolved = resolve(call, new Set(), { remaining: maxWork });
    let reason = resolved.reason;
    let path = resolved.path;
    if (!path.length) {
      path = [{ agent: null, role: 'unknown', ancestry: reason }, ...(call.caller === null ? [] : [{ agent: call.caller, role: 'unknown' as const, ancestry: reason }])];
    }
    path = [...path, { agent: call.callee, role: 'subagent', ancestry: call.callee === null ? 'unknown' : reason }];
    // Reserve two nodes separately from normal capacity. Existing paths must
    // remain countable after overflow, and overflow must not consume that reserve
    // twice or prevent a remaining normal slot from being used.
    const directRootID = path.length === 2 ? hash([null, path[0]]) : null;
    let parent: string | null = null, missing = 0;
    for (const segment of path) { const id = hash([parent, segment]); if (!nodes.has(id) && !overflowIDs.has(id)) missing++; parent = id; }
    if (regularNodes + missing > maxNodes - 2) {
      reason = 'limited';
      path = overflowPath;
    }
    const chain = ensure(path);
    increment(chain[chain.length - 1], call.status);
    // A known direct caller retains its outgoing count even if its new callee
    // cannot be rendered. Do not invent direct-root activity for nested overflow.
    if (directRootID !== null) increment(nodes.get(directRootID) ?? chain[0], call.status);
    if (reason !== 'verified') warnings.add(`Some delegation ancestry is ${reason}; those attempts are shown without an inferred causal chain.`);
    if (call.callee === null || call.caller === null) warnings.add('Some delegation attempts have unknown caller or requested callee agents.');
    if (call.child === null) warnings.add('Some delegation attempts have no retained child-session association; requested resumes are not treated as verified links.');
  }
  return { metric: 'recorded-attempts', timeBasis: 'creation', totalAttempts, unlocatedAttempts, warnings: [...warnings].sort(), nodes: [...nodes.values()] };
}
