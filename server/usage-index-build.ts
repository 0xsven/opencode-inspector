import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { readUsageSnapshot, usageIdentity, usageName, usageTokens } from './usage.js';
import { projectToolUsage } from './usage-delegations.js';
import { distinctAttachments, winningAttachmentOwners } from './usage-v2.js';

export const usageIndexVersion = 6;
export type SourceState = { filename: string; identity: string; fingerprint: string };
export type IndexMetadata = { version: number; identity: string; fingerprint: string; indexedAt: string; changedDuringBuild: boolean };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Filesystem metadata only. Never opens the source SQLite database on ready GETs. */
export async function usageSourceState(filename: string): Promise<SourceState> {
  const canonical = await realpath(filename);
  const main = await stat(canonical, { bigint: true });
  if (!main.isFile()) throw new Error('Invalid source');
  const wal = await stat(canonical + '-wal', { bigint: true }).catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  const identity = hash(JSON.stringify([usageIndexVersion, canonical, String(main.dev), String(main.ino), String(main.birthtimeNs)]));
  const stamp = (file: typeof main | undefined) => file && [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].map(String);
  return { filename: canonical, identity, fingerprint: hash(JSON.stringify([stamp(main), stamp(wal)])) };
}

export function readIndexMetadata(db: DatabaseSync): IndexMetadata {
  const row = db.prepare('SELECT data FROM inspector_usage_index WHERE id = 1').get() as { data: string } | undefined;
  const metadata = row && JSON.parse(row.data) as IndexMetadata;
  if (!metadata || metadata.version !== usageIndexVersion || !/^[a-f0-9]{64}$/.test(metadata.identity)
    || !/^[a-f0-9]{64}$/.test(metadata.fingerprint) || !Number.isFinite(Date.parse(metadata.indexedAt))
    || typeof metadata.changedDuringBuild !== 'boolean') throw new Error('Invalid usage index');
  return metadata;
}

const definitions = {
  session: { id: 'TEXT PRIMARY KEY', parent_id: 'TEXT', time_created: 'INTEGER' },
  session_v2: { id: 'TEXT PRIMARY KEY', parent_id: 'TEXT', time_created: 'INTEGER', fork_session_id: 'TEXT' },
  message: { id: 'TEXT PRIMARY KEY', session_id: 'TEXT', time_created: 'INTEGER', time_updated: 'INTEGER', data: 'TEXT' },
  session_message: { id: 'TEXT PRIMARY KEY', session_id: 'TEXT', time_created: 'INTEGER', time_updated: 'INTEGER', data: 'TEXT', type: 'TEXT' },
  session_part: { message_id: 'TEXT', session_id: 'TEXT', ordinal: 'INTEGER', type: 'TEXT', data: 'TEXT' },
  part: { id: 'TEXT PRIMARY KEY', message_id: 'TEXT', session_id: 'TEXT', time_created: 'INTEGER', time_updated: 'INTEGER', data: 'TEXT' },
  event: { aggregate_id: 'TEXT', type: 'TEXT', created: 'INTEGER', data: 'TEXT' },
};
type Row = Record<string, any>;
const json = (column: string) => `CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;
// IDs are equality keys, not display text. Hash even malformed call IDs/objects
// rather than retaining arbitrary values embedded in source metadata.
const id = (value: unknown) => value === null || value === undefined ? null : hash(JSON.stringify(value));
const callID = (value: unknown) => hash(JSON.stringify(value ?? null));
const kind = (value: unknown) => typeof value === 'string' && ['user', 'assistant', 'compaction', 'skill'].includes(value) ? value : 'other';
const terminal = (value: unknown) => value === 'completed' || value === 'error' ? value : 'pending';
const completion = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) throw new Error('Invalid usage timestamp');
  return value;
}
function tokenMetadata(raw: unknown) {
  const value = usageTokens(raw);
  // Preserve both validation failure and truthiness (compaction disclosure),
  // without storing unknown token fields or malformed arbitrary source objects.
  return value ? { input: value.input, output: value.output, reasoning: value.reasoning, cache: { read: value.cacheRead, write: value.cacheWrite } } : raw ? {} : null;
}
function durableTokens(raw: unknown) {
  if (typeof raw === 'string' && raw) {
    try { raw = JSON.parse(raw); } catch { throw new Error('Invalid durable usage tokens'); }
  }
  return tokenMetadata(raw);
}

/** Only allowlisted metadata crosses into the app-owned database. The caller
 * owns the source read snapshot and destination transaction. Exported for fixture
 * equivalence tests; production calls this exclusively in the indexing child.
 */
export function projectUsageMetadata(source: DatabaseSync, target: DatabaseSync) {
  const schema = new Map<string, Set<string>>();
  for (const row of source.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Row[]) {
    schema.set(row.name, new Set((source.prepare('SELECT name FROM pragma_table_info(?)').all(row.name) as Row[]).map(column => column.name)));
  }
  const complete = (table: keyof typeof definitions) => Object.keys(definitions[table]).every(column => schema.get(table)?.has(column));
  for (const [table, fields] of Object.entries(definitions)) {
    if (!schema.has(table)) continue;
    const columns = Object.entries(fields).filter(([column]) => schema.get(table)!.has(column));
    // Keep unsupported table presence/columns so existing coverage warnings stay
    // identical, but never query unsupported source layouts or copy their data.
    target.exec(`CREATE TABLE ${table} (${columns.map(([column, type]) => `${column} ${type}`).join(', ') || '_unsupported INTEGER'})`);
  }
  for (const table of ['session', 'session_v2'] as const) {
    if (!complete(table)) continue;
    const v2 = table === 'session_v2';
    const insert = target.prepare(`INSERT INTO ${table} VALUES (${v2 ? '?,?,?,?' : '?,?,?'})`);
    for (const row of source.prepare(`SELECT id, parent_id, time_created${v2 ? ', fork_session_id' : ''} FROM ${table}`).iterate() as Iterable<Row>) {
      insert.run(...[id(row.id), id(row.parent_id), timestamp(row.time_created), ...(v2 ? [id(row.fork_session_id)] : [])]);
    }
  }
  for (const table of ['message', 'session_message'] as const) {
    if (!complete(table)) continue;
    const v2 = table === 'session_message';
    const insert = target.prepare(`INSERT INTO ${table} VALUES (${v2 ? '?,?,?,?,?,?' : '?,?,?,?,?'})`);
    const rows = source.prepare(`SELECT id, session_id, time_created, time_updated${v2 ? ', type' : ''},
      CASE WHEN json_valid(data) THEN json_extract(data, '$.role', '$.agent', '$.tokens', '$.status', '$.name', '$.skill', '${v2 ? '$.model.providerID' : '$.providerID'}', '${v2 ? '$.model.id' : '$.modelID'}') END metadata FROM ${table}`).iterate() as Iterable<Row>;
    for (const row of rows) {
      let data = '!'; // Retain malformed-record disclosure without retaining content.
      if (row.metadata !== null) {
        const [role, agent, tokens, status, label, skill, providerID, modelID] = JSON.parse(row.metadata);
        data = JSON.stringify({ role: kind(role), agent: usageName(agent), tokens: tokenMetadata(tokens), status: status === 'completed' ? 'completed' : null,
          ...(v2 ? { model: { providerID: usageIdentity(providerID), id: usageIdentity(modelID) } } : { providerID: usageIdentity(providerID), modelID: usageIdentity(modelID) }),
          ...(v2 && row.type === 'skill' ? { name: usageName(label ?? skill) } : {}) });
      }
      insert.run(...[id(row.id), id(row.session_id), timestamp(row.time_created), timestamp(row.time_updated), data, ...(v2 ? [kind(row.type)] : [])]);
    }
    target.exec(`CREATE INDEX ${table}_session_time ON ${table}(session_id, time_created, id)`);
  }
  if (complete('part')) {
    const insert = target.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
    const key = (source.prepare("SELECT wr FROM pragma_table_list WHERE schema='main' AND name='part'").get() as Row).wr ? 'id' : 'rowid';
    const p = json('p.data');
    const rows = source.prepare(`SELECT p.id, p.message_id, p.session_id, p.time_created, p.time_updated,
      json_extract(${p}, '$.callID', '$.state.status', '$.state.input.name', '$.state.metadata.name', '$.state.time.end') metadata
      FROM part p NOT INDEXED WHERE json_extract(${p}, '$.tool')='skill' AND json_extract(${p}, '$.type')='tool' ORDER BY p.${key}`).iterate() as Iterable<Row>;
    for (const row of rows) {
      const [call, status, input, label, end] = JSON.parse(row.metadata);
      const data = { type: 'tool', tool: 'skill', callID: callID(call), state: { status: terminal(status), metadata: { name: usageName(label ?? input) }, time: { end: completion(end) } } };
      insert.run(id(row.id), id(row.message_id), id(row.session_id), timestamp(row.time_created), timestamp(row.time_updated), JSON.stringify(data));
    }
  }
  if (complete('session_message') && complete('session_v2')) {
    const attach = target.prepare("UPDATE session_message SET data=json_set(data, '$.skills', json(?)) WHERE id=?");
    for (const row of winningAttachmentOwners(source, complete('message') && complete('session')) as Iterable<Row>) {
      const skills = Array.from(distinctAttachments(row.attachments), a => ({ id: id(a.id), name: a.id ? usageName(a.name) : null }));
      attach.run(JSON.stringify(skills), id(row.id));
    }
  }
  if (complete('event')) {
    const e = json('data');
    const insert = target.prepare('INSERT INTO event VALUES (?,?,?,?)');
    const rows = source.prepare(`SELECT aggregate_id, type, created,
      json_extract(${e}, '$.sessionID', '$.source', '$.tokens') metadata,
      json_type(${e}, '$.location') location, json_type(${e}, '$.boundary') boundary
      FROM event WHERE type IN ('session.created.1','session.forked.2','session.usage.recorded.1')`).iterate() as Iterable<Row>;
    for (const row of rows) {
      const [sessionID, sourceKind, tokens] = JSON.parse(row.metadata);
      const data = row.type === 'session.usage.recorded.1'
        // The live event reader JSON-decodes json_extract's single-column result.
        // That also accepts an object encoded in a JSON string. Invalid strings
        // must fail the build rather than publish different accounting totals.
        ? { source: ['title', 'compaction', 'generate'].includes(sourceKind) ? sourceKind : null, tokens: durableTokens(tokens) }
        : { sessionID: id(sessionID), ...(row.location === 'object' ? { location: {} } : {}), ...(row.boundary === 'object' ? { boundary: {} } : {}) };
      insert.run(id(row.aggregate_id), row.type, timestamp(row.created), JSON.stringify(data));
    }
    target.exec('CREATE INDEX event_session_type ON event(aggregate_id, type, created)');
  }
  projectToolUsage(source, target, id);
}

export async function buildUsageIndex(filename: string, destination: string, identity: string): Promise<IndexMetadata> {
  const before = await usageSourceState(filename);
  if (before.identity !== identity) throw new Error('Source identity changed');
  const source = new DatabaseSync(before.filename, { readOnly: true });
  let target: DatabaseSync | undefined;
  try {
    source.exec('PRAGMA query_only=ON; BEGIN');
    source.prepare('SELECT name FROM sqlite_schema LIMIT 1').get(); // Pin the WAL-aware read snapshot.
    const indexedAt = new Date().toISOString();
    target = new DatabaseSync(destination);
    target.exec('BEGIN');
    projectUsageMetadata(source, target);
    // Validate the accounting schema before publishing even an empty index.
    readUsageSnapshot(target, { from: 0, to: 1, timezone: 'UTC' }, indexedAt, true);
    const after = await usageSourceState(filename);
    if (after.identity !== identity) throw new Error('Source identity changed');
    const metadata: IndexMetadata = { version: usageIndexVersion, identity, fingerprint: before.fingerprint, indexedAt, changedDuringBuild: before.fingerprint !== after.fingerprint };
    target.exec('CREATE TABLE inspector_usage_index(id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    target.prepare('INSERT INTO inspector_usage_index VALUES (1,?)').run(JSON.stringify(metadata));
    target.exec('COMMIT');
    source.exec('ROLLBACK');
    return metadata;
  } finally { target?.close(); source.close(); }
}
