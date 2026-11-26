import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { UsageIndex } from '../server/usage-index.js';
import { usageSourceState, projectUsageMetadata, usageIndexVersion } from '../server/usage-index-build.js';
import { readUsage, readUsageSnapshot } from '../server/usage.js';
import { delegationInboundSQL } from '../server/usage-delegations.js';
import { createApp } from '../server/app.js';
import type { IndexedUsageResponse } from '../src/usage-types.js';

const from = Date.parse('2026-11-01T00:00:00Z');
const range = { from, to: from + 30 * 86_400_000, timezone: 'Europe/Berlin' };
const tokens = { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } };
function seed(filename: string) {
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  db.prepare('INSERT INTO session VALUES(?,?,?)').run('PRIVATE SESSION ID', null, from - 1000);
  const insert = db.prepare('INSERT INTO message VALUES(?,?,?,?,?)');
  insert.run('PRIVATE MESSAGE ID', 'PRIVATE SESSION ID', from + 1000, from + 1000, JSON.stringify({ role: 'assistant', agent: 'build', providerID: 'openai', modelID: 'recorded-model', model: { id: 'PRIVATE IGNORED OBJECT', credential: 'PRIVATE MODEL SECRET' }, tokens, text: 'PRIVATE PROMPT AND CONVERSATION', extra: 'sk-privatecredential12345' }));
  db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('PRIVATE PART ID', 'PRIVATE MESSAGE ID', 'PRIVATE SESSION ID', from + 1000, from + 2000, JSON.stringify({ type: 'tool', tool: 'skill', callID: { arbitrary: 'PRIVATE CALL OBJECT' }, state: { status: 'completed', input: { name: 'research' }, time: { end: from + 2000 }, output: 'PRIVATE TOOL OUTPUT' } }));
  db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('unrelated', 'PRIVATE MESSAGE ID', 'PRIVATE SESSION ID', from + 1000, from + 2000, JSON.stringify({ type: 'text', text: 'PRIVATE NONSKILL PART' }));
  return db;
}
async function fixture(run: (filename: string, directory: string, db: DatabaseSync) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inspector-index-'));
  const filename = path.join(directory, 'source.db'), db = seed(filename);
  try { await run(filename, directory, db); } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
}
async function settled(index: UsageIndex, filename: string) {
  for (let i = 0; i < 500; i++) {
    const dto = await index.read(filename, range);
    if (!['indexing', 'refreshing'].includes(dto.index.state)) return dto;
    await delay(10);
  }
  throw new Error('Index did not settle');
}
function ready(dto: IndexedUsageResponse) {
  assert.ok(dto.status === 'available' || dto.status === 'partial', JSON.stringify(dto));
  if (dto.status !== 'available' && dto.status !== 'partial') throw new Error('Expected retained counts');
  return dto;
}

test('initial build coalesces, stores only private metadata, persists across restart and leaves live WAL untouched', async () => {
  await fixture(async (filename, directory, db) => {
    db.exec(`CREATE TABLE project(id TEXT PRIMARY KEY, name TEXT, worktree TEXT);
      INSERT INTO project VALUES ('PRIVATE PROJECT', '/Users/PRIVATE/name', '/Users/PRIVATE/Visible');
      ALTER TABLE session ADD COLUMN project_id TEXT;
      ALTER TABLE session ADD COLUMN title TEXT;
      UPDATE session SET project_id='PRIVATE PROJECT', title='[redacted:session-title:PRIVATE SESSION ID]';`);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    db.prepare("UPDATE message SET time_updated=time_updated+1 WHERE id='PRIVATE MESSAGE ID'").run();
    const before = await stat(filename), walBefore = await stat(filename + '-wal');
    const cache = path.join(directory, 'cache'), index = new UsageIndex(cache);
    try {
      const initial = await Promise.all(Array.from({ length: 12 }, () => index.read(filename, range)));
      assert.ok(initial.every(dto => dto.status === 'indexing'));
      assert.ok(initial.every(dto => !('summary' in dto)));
      const first = ready(await settled(index, filename));
      assert.equal(first.index.state, 'ready'); assert.equal(first.summary.tokens.total, 15);
      assert.deepEqual(first.models.map(({ provider, model, steps, sessions }) => ({ provider, model, steps, sessions })), [{ provider: 'openai', model: 'recorded-model', steps: 1, sessions: 1 }]);
      assert.equal(first.skills[0].loads, 1); assert.equal(first.updatedAt, first.index.indexedAt);
      const [project] = first.projects;
      assert.match(project.id, /^[0-9a-f]{64}$/);
      assert.deepEqual(project, { id: project.id, name: 'Visible', sessions: 1, steps: 1, tokens: 15 });
      assert.equal(first.topSessions[0].title, null);
      const files = await readdir(cache);
      assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{64}\.sqlite$/);
      assert.equal((await stat(cache)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(cache, files[0]))).mode & 0o777, 0o600);
      const bytes = await readFile(path.join(cache, files[0]));
      assert.doesNotMatch(bytes.toString('utf8'), /PRIVATE|sk-private|source\.db|\/Users\/|redacted:session-title/);
      assert.doesNotMatch(JSON.stringify(first), /PRIVATE SESSION ID|redacted:session-title/);
      const cached = new DatabaseSync(path.join(cache, files[0]), { readOnly: true });
      try {
        cached.exec('PRAGMA query_only=ON');
        assert.equal((cached.prepare('SELECT count(*) n FROM part').get() as { n: number }).n, 1);
        assert.equal((cached.prepare('SELECT count(*) n FROM message').get() as { n: number }).n, 1);
      } finally { cached.close(); }
      await index.close();
      const restarted = new UsageIndex(cache);
      try {
        const persisted = ready(await restarted.read(filename, range));
        assert.equal(persisted.index.state, 'ready');
        assert.equal(persisted.index.indexedAt, first.index.indexedAt);
        assert.deepEqual(persisted.summary, first.summary);
        assert.deepEqual(ready(await restarted.read(filename, { ...range, project: project.id })).topSessions, first.topSessions);
        assert.equal(persisted.index.sourceChanged, false);
      } finally { await restarted.close(); }
      assert.equal((await stat(filename)).mtimeMs, before.mtimeMs);
      assert.equal((await stat(filename + '-wal')).mtimeMs, walBefore.mtimeMs);
      assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    } finally { await index.close(); }
  });
});

test('explicit refresh is atomic, failures retain the old snapshot, and failed initial builds do not auto-retry', async () => {
  await fixture(async (filename, directory, db) => {
    const cache = path.join(directory, 'cache'), index = new UsageIndex(cache);
    try {
      const first = ready(await settled(index, filename));
      db.prepare('UPDATE message SET data=json_set(data, ?, ?)').run('$.tokens.input', 50);
      const stale = ready(await index.read(filename, range));
      assert.equal(stale.index.sourceChanged, true); assert.equal(stale.summary.tokens.input, 1);
      const refreshes = await Promise.all(Array.from({ length: 8 }, () => index.read(filename, range, true)));
      for (const dto of refreshes) {
        assert.equal(dto.index.state, 'refreshing');
        assert.deepEqual(ready(dto).summary, first.summary);
      }
      const second = ready(await settled(index, filename));
      assert.equal(second.summary.tokens.input, 50); assert.notEqual(second.index.indexedAt, first.index.indexedAt);
      const key = (await usageSourceState(filename)).identity, published = path.join(cache, key + '.sqlite');
      const bytes = await readFile(published);
      db.exec('DROP TABLE session'); // No accounting schema: rebuild must fail, not publish zeros.
      assert.equal((await index.read(filename, range, true)).index.state, 'refreshing');
      const failed = ready(await settled(index, filename));
      assert.equal(failed.index.state, 'failed'); assert.equal(failed.status, 'partial');
      assert.deepEqual(failed.summary, second.summary); assert.equal(failed.index.indexedAt, second.index.indexedAt);
      assert.match(failed.warnings.join(' '), /previous indexed snapshot/);
      assert.deepEqual(await readFile(published), bytes);
      assert.equal((await index.read(filename, range)).index.state, 'failed');
      assert.deepEqual((await readdir(cache)).sort(), [key + '.sqlite']);
      let now = 0;
      const empty = new UsageIndex(path.join(directory, 'empty-cache'), () => now);
      try {
        assert.equal((await empty.status(filename)).state, 'indexing');
        const unavailable = await settled(empty, filename);
        assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.index.state, 'failed');
        db.exec('CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER)');
        now += 60 * 60_000;
        assert.match((await empty.status(filename)).message!, /Use Refresh to retry/);
        assert.equal((await empty.read(filename, range)).status, 'unavailable'); // No automatic retry after repair.
        assert.equal((await empty.read(filename, range, true)).status, 'indexing');
        assert.equal(ready(await settled(empty, filename)).index.state, 'ready');
      } finally { await empty.close(); }
    } finally { await index.close(); }
  });
});

test('status wakes one dirty-cache rebuild and enforces a completion cooldown while range GETs retain previous counts', async () => {
  await fixture(async (filename, directory, db) => {
    let now = 0;
    const cache = path.join(directory, 'cache'), index = new UsageIndex(cache, () => now);
    try {
      const [status, usage] = await Promise.all([index.status(filename), index.read(filename, range)]);
      assert.deepEqual(status, { state: 'indexing', indexedAt: null, sourceChanged: false });
      assert.equal(usage.status, 'indexing');
      const first = ready(await settled(index, filename));
      const update = db.prepare('UPDATE message SET data=json_set(data, ?, ?)');
      update.run('$.tokens.input', 50);
      now = 5 * 60_000 - 1;
      assert.deepEqual(await index.status(filename), { ...first.index, sourceChanged: true });

      now++;
      assert.equal((await index.read(filename, range)).index.state, 'ready');
      const statuses = await Promise.all(Array.from({ length: 8 }, () => index.status(filename)));
      for (const status of statuses) assert.deepEqual(status, { state: 'refreshing', indexedAt: first.index.indexedAt, sourceChanged: true });
      const refreshing = ready(await index.read(filename, range));
      assert.equal(refreshing.index.state, 'refreshing');
      assert.deepEqual(refreshing.summary, first.summary);
      const second = ready(await settled(index, filename));
      assert.equal(second.summary.tokens.input, 50);
      assert.deepEqual(await index.status(filename), second.index);

      // A build can detect writes while it was reading, even if the current
      // fingerprint still matches the published header's initial check.
      const key = (await usageSourceState(filename)).identity;
      const cached = new DatabaseSync(path.join(cache, key + '.sqlite'));
      try { cached.exec("UPDATE inspector_usage_index SET data=json_set(data,'$.changedDuringBuild',json('true'))"); }
      finally { cached.close(); }
      now += 5 * 60_000 - 1;
      assert.deepEqual(await index.status(filename), { ...second.index, sourceChanged: true });
      now++;
      assert.equal((await index.status(filename)).state, 'refreshing');
      assert.equal((await settled(index, filename)).index.sourceChanged, false);
    } finally { await index.close(); }
  });
});

test('a failed automatic rebuild keeps the previous snapshot and notice, backs off, and can be manually retried', async () => {
  await fixture(async (filename, directory, db) => {
    let now = 0;
    const cache = path.join(directory, 'cache'), index = new UsageIndex(cache, () => now);
    try {
      const first = ready(await settled(index, filename));
      db.exec('ALTER TABLE session RENAME TO original_session');
      now = 5 * 60_000;
      assert.equal((await index.status(filename)).state, 'refreshing');
      const failed = ready(await settled(index, filename));
      assert.equal(failed.index.state, 'failed');
      assert.match(failed.index.message!, /previous indexed snapshot/);
      assert.deepEqual(failed.summary, first.summary);
      assert.equal(failed.index.indexedAt, first.index.indexedAt);

      now += 5 * 60_000 - 1;
      assert.deepEqual(await index.status(filename), failed.index);
      now++;
      assert.deepEqual(await index.status(filename), { ...failed.index, state: 'refreshing' });
      assert.deepEqual((await settled(index, filename)).index, failed.index);
      db.exec('ALTER TABLE original_session RENAME TO session');
      db.prepare('UPDATE message SET data=json_set(data, ?, ?)').run('$.tokens.input', 90);
      assert.deepEqual(await index.status(filename), failed.index);
      assert.equal((await index.read(filename, range, true)).index.state, 'refreshing');
      const recovered = ready(await settled(index, filename));
      assert.equal(recovered.summary.tokens.input, 90);
      assert.equal(recovered.index.message, undefined);
      now += 60 * 60_000;
      assert.deepEqual(await index.status(filename), recovered.index);
    } finally { await index.close(); }
  });
});

test('status reads a valid header without querying accounting tables', async () => {
  await fixture(async (filename, directory) => {
    const cache = path.join(directory, 'cache'), index = new UsageIndex(cache);
    try {
      const first = ready(await settled(index, filename));
      const key = (await usageSourceState(filename)).identity;
      const cached = new DatabaseSync(path.join(cache, key + '.sqlite'));
      try { cached.exec('DROP TABLE session'); }
      finally { cached.close(); }
      assert.deepEqual(await index.status(filename), first.index);
      assert.equal((await index.read(filename, range)).status, 'unavailable');
    } finally { await index.close(); }
  });
});

test('source replacement uses a new identity; temporary source failure retains only the known snapshot', async () => {
  await fixture(async (filename, directory) => {
    const cache = path.join(directory, 'cache'), index = new UsageIndex(cache);
    try {
      const first = ready(await settled(index, filename));
      const identity = (await usageSourceState(filename)).identity;
      const moved = filename + '.old'; await rename(filename, moved);
      const missing = ready(await index.read(filename, range));
      assert.equal(missing.index.sourceChanged, null); assert.equal(missing.status, 'partial');
      assert.deepEqual(missing.summary, first.summary);
      assert.deepEqual(await index.status(filename), missing.index);
      const replacement = seed(filename);
      replacement.prepare('UPDATE message SET data=json_set(data, ?, ?)').run('$.tokens.input', 99);
      replacement.close();
      assert.notEqual((await usageSourceState(filename)).identity, identity);
      const [nextStatus, initial] = await Promise.all([index.status(filename), index.read(filename, range)]);
      assert.deepEqual(nextStatus, { state: 'indexing', indexedAt: null, sourceChanged: false });
      assert.equal(initial.status, 'indexing'); assert.equal('summary' in initial, false);
      assert.equal(ready(await settled(index, filename)).summary.tokens.input, 99);
      assert.equal((await readdir(cache)).filter(file => file.endsWith('.sqlite')).length, 2);
    } finally { await index.close(); }
  });
});

test('incompatible, wrong-source and corrupt cache metadata is rebuilt rather than served', async () => {
  await fixture(async (filename, directory) => {
    const cache = path.join(directory, 'cache');
    const initial = new UsageIndex(cache);
    try { ready(await settled(initial, filename)); } finally { await initial.close(); }
    const identity = (await usageSourceState(filename)).identity;
    const published = path.join(cache, identity + '.sqlite');
    for (const invalidate of [
      (metadata: any) => JSON.stringify({ ...metadata, version: usageIndexVersion - 1 }),
      (metadata: any) => JSON.stringify({ ...metadata, version: metadata.version + 1 }),
      (metadata: any) => JSON.stringify({ ...metadata, identity: '0'.repeat(64) }),
      () => '{invalid',
    ]) {
      const db = new DatabaseSync(published);
      try {
        const row = db.prepare('SELECT data FROM inspector_usage_index WHERE id=1').get() as { data: string };
        db.prepare('UPDATE inspector_usage_index SET data=? WHERE id=1').run(invalidate(JSON.parse(row.data)));
      } finally { db.close(); }
      const restarted = new UsageIndex(cache);
      try {
        const first = await restarted.read(filename, range);
        assert.equal(first.status, 'indexing'); assert.equal('summary' in first, false);
        const rebuilt = ready(await settled(restarted, filename));
        assert.equal(rebuilt.index.state, 'ready'); assert.equal(rebuilt.summary.tokens.total, 15);
      } finally { await restarted.close(); }
    }
  });
});

test('delegation private projection allowlists metadata, hashes associations and retains unknown names/times safely', async () => {
  await fixture(async (filename, directory, db) => {
    db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,time_created INTEGER,fork_session_id TEXT);
      CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT,type TEXT);`);
    db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?)').run('PRIVATE V2 SESSION', null, from - 1000, null);
    const native = { type: 'tool', id: { secret: 'PRIVATE CALL OBJECT' }, name: 'subagent',
      state: { status: 'completed', input: { agent: { secret: 'PRIVATE CALLEE OBJECT' }, sessionID: 'PRIVATE REQUESTED RESUME', prompt: 'PRIVATE PROMPT', description: 'PRIVATE DESCRIPTION', command: 'PRIVATE COMMAND' },
        metadata: { sessionID: 'PRIVATE CHILD SESSION', status: 'running', arbitrary: 'PRIVATE METADATA' },
        content: [{ type: 'text', text: 'PRIVATE CONTENT' }], output: 'PRIVATE OUTPUT', error: 'PRIVATE ERROR' },
      time: { created: from + 1000, ran: 'PRIVATE RAN', completed: 'PRIVATE COMPLETION' }, native: { arbitrary: 'PRIVATE PROVIDER DATA' } };
    db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?)').run('PRIVATE V2 MESSAGE', 'PRIVATE V2 SESSION', from + 1000, from + 2000, JSON.stringify({ agent: { nested: 'PRIVATE CALLER OBJECT' }, model: { providerID: 'provider-v2', id: 'recorded-v2', variant: 'PRIVATE VARIANT', headers: { authorization: 'PRIVATE MODEL SECRET' } }, content: [native, { ...native, id: 'PRIVATE V2 CALL ID', time: { created: { secret: 'PRIVATE CREATED OBJECT' } } }] }), 'assistant');
    db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run('PRIVATE TASK PART', 'PRIVATE MESSAGE ID', 'PRIVATE SESSION ID', from + 1000, from + 2000, JSON.stringify({ type: 'tool', tool: 'task', callID: 'PRIVATE LEGACY CALL ID',
      state: { status: 'error', input: { subagent_type: 'research', task_id: 'PRIVATE REQUESTED RESUME', prompt: 'PRIVATE LEGACY PROMPT' }, metadata: { sessionId: 'PRIVATE CHILD SESSION', other: 'PRIVATE EXTRA METADATA' }, output: 'PRIVATE OUTPUT', error: 'PRIVATE ERROR' } }));
    const index = new UsageIndex(path.join(directory, 'cache'));
    try {
      const result = ready(await settled(index, filename));
      assert.equal(result.delegations.totalAttempts, 2); assert.equal(result.delegations.unlocatedAttempts, 1);
      assert.ok(result.models.some(model => model.provider === 'provider-v2' && model.model === 'recorded-v2' && model.steps === 1));
      assert.ok(result.delegations.nodes.some(n => n.agent === null));
      const cached = path.join(directory, 'cache', (await usageSourceState(filename)).identity + '.sqlite');
      assert.doesNotMatch((await readFile(cached)).toString(), /PRIVATE/);
      const projected = new DatabaseSync(cached, { readOnly: true });
      try {
        projected.exec('PRAGMA query_only=ON');
        const rows = projected.prepare('SELECT key,session,message,child,resume,caller,callee,created FROM inspector_delegation_call').all() as any[];
        assert.equal(rows.length, 3);
        for (const row of rows) for (const field of ['key', 'session', 'message', 'child', 'resume']) if (row[field] !== null) assert.match(row[field], /^[a-f0-9]{64}$/);
        assert.ok(rows.some(row => row.caller === null && row.callee === null));
        assert.ok(rows.some(row => row.created === null));
        assert.deepEqual(readUsageSnapshot(projected, range, 'fixed', true), readUsageSnapshot(db, range, 'fixed'));
      } finally { projected.close(); }
    } finally { await index.close(); }
  });
});

test('indexed session labels seek only touched sessions and ancestors, once per request', async t => {
  await fixture(async (_filename, _directory, db) => {
    db.exec(`ALTER TABLE session ADD COLUMN title TEXT;
      UPDATE session SET parent_id='ancestor';`);
    const insertSession = db.prepare('INSERT INTO session VALUES(?,NULL,?,?)');
    insertSession.run('ancestor', from - 2000, 'Ancestor');
    for (let i = 0; i < 2000; i++) insertSession.run(`older-${i}`, from - 100_000, 'Unrelated historical label');
    const insertMessage = db.prepare('INSERT INTO message VALUES(?,?,?,?,?)');
    for (let i = 0; i < 30; i++) insertMessage.run(`m-${i}`, 'PRIVATE SESSION ID', from + 1, from + 1, JSON.stringify({ role: 'assistant', tokens }));
    const index = new DatabaseSync(':memory:');
    try {
      projectUsageMetadata(db, index);
      const prepare = index.prepare.bind(index), queries: string[] = [], seen: string[] = [];
      t.mock.method(index, 'prepare', (sql: string) => {
        const statement = prepare(sql);
        if (sql.includes('inspector_usage_session_label')) {
          queries.push(sql);
          const get = statement.get.bind(statement);
          t.mock.method(statement, 'get', (key: string) => { seen.push(key); return get(key); });
        }
        return statement;
      });
      const usage = readUsageSnapshot(index, range, 'fixed', true);
      assert.ok(usage.status !== 'unavailable');
      assert.equal(usage.topSessions[0].title, 'Ancestor');
      assert.equal(usage.topSessions[0].steps, 31);
      assert.equal(queries.length, 1);
      assert.equal(seen.length, 2);
      assert.equal(new Set(seen).size, 2);
      const plan = prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).all(seen[0]).map(row => String(row.detail));
      assert.equal(plan.filter(detail => /SEARCH .*key=\?/.test(detail)).length, 2);
      assert.ok(!plan.some(detail => /\bSCAN\b/.test(detail)));
    } finally { index.close(); }
  });
});

test('ready delegation ranges use private time/child indexes and keep transcript-sized work out of call lookup', async t => {
  await fixture(async (_filename, _directory, db) => {
    db.exec('BEGIN');
    const message = db.prepare('INSERT INTO message VALUES(?,?,?,?,?)');
    const part = db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)');
    for (let i = 0; i < 6000; i++) {
      const created = from + (i % 30) * 86_400_000 + 3000 + i;
      message.run(`m-${i}`, 'PRIVATE SESSION ID', created, created, JSON.stringify({ role: 'assistant', agent: i % 2 ? 'plan' : 'build', tokens, text: 'PRIVATE TRANSCRIPT' }));
      part.run(`p-${i}`, `m-${i}`, 'PRIVATE SESSION ID', created, created, JSON.stringify({ type: 'tool', tool: 'task', callID: `call-${i}`, state: { status: 'completed', input: { subagent_type: `worker-${i % 4}`, prompt: 'PRIVATE PROMPT' } } }));
    }
    db.exec('COMMIT');
    const projected = new DatabaseSync(':memory:');
    try {
      projectUsageMetadata(db, projected);
      const plan = (sql: string, ...params: any[]) => JSON.stringify(projected.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params));
      assert.match(plan('SELECT key FROM inspector_delegation_call WHERE created>=? AND created<? ORDER BY created,key', from, range.to), /inspector_delegation_time/);
      const timedPlan = plan(delegationInboundSQL.timed, 'child', range.to, 65);
      const nullPlan = plan(delegationInboundSQL.unlocated, 'child', 65);
      assert.match(timedPlan, /inspector_delegation_child \(child=\? AND created<\?\)/);
      assert.match(nullPlan, /inspector_delegation_child \(child=\? AND created=\?\)/);
      assert.doesNotMatch(timedPlan + nullPlan, /SCAN |TEMP B-TREE/);
      for (const days of [1, 7, 30]) {
        const start = performance.now();
        const result = ready({ ...readUsageSnapshot(projected, { ...range, to: from + days * 86_400_000 }, 'fixed', true), index: { state: 'ready', indexedAt: 'fixed', sourceChanged: false } });
        const elapsed = performance.now() - start;
        assert.equal(result.delegations.totalAttempts, days * 200);
        t.diagnostic(`${days}-day private snapshot, 6000 delegation calls: ${elapsed.toFixed(1)}ms`);
      }
    } finally { projected.close(); }
  });
});

test('nested private reads seek past future resumes and preserve NULL timestamp uncertainty', async t => {
  await fixture(async (_filename, _directory, db) => {
    db.exec('BEGIN');
    db.prepare('INSERT INTO session VALUES(?,?,?)').run('child', 'PRIVATE SESSION ID', from - 500);
    const message = db.prepare('INSERT INTO message VALUES(?,?,?,?,?)');
    message.run('nested', 'child', from + 1000, from + 1000, JSON.stringify({ role: 'assistant', agent: 'research', tokens }));
    const part = db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)');
    for (let i = 0; i < 2000; i++) part.run(`nested-${i}`, 'nested', 'child', from + 2000 + i, from + 2000 + i,
      JSON.stringify({ type: 'tool', tool: 'task', callID: `nested-${i}`, state: { status: 'completed', input: { subagent_type: 'worker' } } }));
    db.exec('COMMIT');
    const baseline = new DatabaseSync(':memory:'), future = new DatabaseSync(':memory:');
    try {
      projectUsageMetadata(db, baseline);
      const start = performance.now();
      const before = readUsageSnapshot(baseline, range, 'fixed', true);
      const baselineMs = performance.now() - start;
      db.exec('BEGIN');
      message.run('future', 'PRIVATE SESSION ID', range.to + 1, range.to + 1, JSON.stringify({ role: 'assistant', agent: 'build', tokens }));
      for (let i = 0; i < 20000; i++) part.run(`future-${i}`, 'future', 'PRIVATE SESSION ID', range.to + 2 + i, range.to + 2 + i,
        JSON.stringify({ type: 'tool', tool: 'task', callID: `future-${i}`, state: { status: 'completed', input: { subagent_type: 'research', task_id: 'child' }, metadata: { sessionId: 'child' } } }));
      db.exec('COMMIT');
      projectUsageMetadata(db, future);
      const futureStart = performance.now();
      const after = readUsageSnapshot(future, range, 'fixed', true);
      const futureMs = performance.now() - futureStart;
      assert.deepEqual(after, before, 'future resumes cannot change a historical period or its ancestry');
      assert.deepEqual(readUsageSnapshot(future, range, 'fixed', true), after, 'repeated indexed reads preserve the projection and DTO');
      assert.ok(after.status !== 'unavailable');
      assert.equal(after.delegations.totalAttempts, 2000);
      const child = (future.prepare("SELECT session FROM inspector_delegation_call WHERE callee='worker' LIMIT 1").get() as { session: string }).session;
      assert.equal(future.prepare('SELECT count(*) n FROM inspector_delegation_call WHERE child=?').get(child)!.n, 20000);
      assert.equal(future.prepare(delegationInboundSQL.timed).all(child, range.to, 65).length, 0);
      assert.equal(future.prepare(delegationInboundSQL.unlocated).all(child, 65).length, 0);
      t.diagnostic(`2000 nested period calls: ${baselineMs.toFixed(1)}ms without future resumes; ${futureMs.toFixed(1)}ms with 20000 future resumes`);

      // Add one valid earlier link plus one unlocated link in the private fixture. The bounded
      // NULL seek must still prevent a falsely verified ancestry path.
      const first = future.prepare('SELECT * FROM inspector_delegation_call WHERE child=? LIMIT 1').get(child) as any;
      future.prepare('UPDATE inspector_delegation_call SET created=? WHERE key=?').run(from - 1, first.key);
      const linked = readUsageSnapshot(future, range, 'fixed', true);
      assert.ok(linked.status !== 'unavailable');
      assert.ok(linked.delegations.nodes.some(n => n.role === 'main' && n.agent === 'build'));
      future.prepare('UPDATE inspector_delegation_call SET created=NULL WHERE key=(SELECT key FROM inspector_delegation_call WHERE child=? AND created>? LIMIT 1)').run(child, range.to);
      assert.equal(future.prepare(delegationInboundSQL.unlocated).all(child, 65).length, 1);
      const uncertain = readUsageSnapshot(future, range, 'fixed', true);
      assert.ok(uncertain.status !== 'unavailable');
      assert.equal(uncertain.delegations.totalAttempts, 2000);
      assert.equal(uncertain.delegations.unlocatedAttempts, 1);
      assert.ok(!uncertain.delegations.nodes.some(n => n.role === 'main'));
      assert.ok(uncertain.delegations.nodes.some(n => n.ancestry === 'unknown' && n.attempts === 2000));
    } finally { baseline.close(); future.close(); }
  });
});

test('metadata projection preserves unsupported/malformed coverage and never stores unexpected label/token objects', async () => {
  await fixture(async (_filename, _directory, db) => {
    db.exec('CREATE TABLE session_message(id TEXT PRIMARY KEY)'); // Unsupported V2 table must remain visible to coverage logic.
    db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('bad', 'PRIVATE SESSION ID', from + 3000, from + 3000, '{PRIVATE INVALID JSON');
    db.prepare('UPDATE message SET data=json_set(data, ?, json(?), ?, json(?)) WHERE id=?').run('$.agent', JSON.stringify({ nested: 'PRIVATE OBJECT' }), '$.tokens', JSON.stringify({ input: 'PRIVATE TOKEN OBJECT' }), 'PRIVATE MESSAGE ID');
    for (const value of [{ secret: 'PRIVATE MODEL OBJECT' }, 'PRIVATE\nMODEL', 'x'.repeat(257), 'sk-privatecredential12345', 'https://PRIVATE:SECRET@example.com']) {
      db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run(JSON.stringify(value), 'PRIVATE SESSION ID', from + 1000, from + 1000, JSON.stringify({ role: 'assistant', agent: 'build', tokens, providerID: value, modelID: value }));
    }
    const vertexModels = ['claude-sonnet-4-5@20250929', 'claude-haiku-4-5@20251001'];
    for (const modelID of vertexModels) {
      db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run(modelID, 'PRIVATE SESSION ID', from + 1000, from + 1000, JSON.stringify({ role: 'assistant', agent: 'build', tokens, providerID: 'google-vertex-anthropic', modelID }));
    }
    const projected = new DatabaseSync(':memory:');
    try {
      projectUsageMetadata(db, projected);
      assert.deepEqual(readUsageSnapshot(projected, range, 'fixed', true), readUsageSnapshot(db, range, 'fixed'));
      const result = readUsageSnapshot(projected, range, 'fixed', true);
      assert.ok(result.status !== 'unavailable');
      assert.deepEqual(result.models.filter(model => model.provider === 'google-vertex-anthropic').map(({ model, steps, sessions, tokens }) => ({ model, steps, sessions, total: tokens.total })), [
        { model: vertexModels[1], steps: 1, sessions: 1, total: 15 },
        { model: vertexModels[0], steps: 1, sessions: 1, total: 15 },
      ]);
      assert.doesNotMatch(JSON.stringify(projected.prepare('SELECT data FROM message').all()), /PRIVATE/);
      assert.doesNotMatch(JSON.stringify(projected.prepare('SELECT data FROM message').all()), /sk-private|x{257}/);
    } finally { projected.close(); }
  });
});

test('every copied timestamp rejects private text/blob payloads before insertion; failed builds leave no cache content', async () => {
  await fixture(async (filename, directory, db) => {
    db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER, fork_session_id TEXT);
      CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, type TEXT);
      CREATE TABLE event(aggregate_id TEXT, type TEXT, created INTEGER, data TEXT);
      INSERT INTO session_v2 SELECT id, parent_id, time_created, NULL FROM session;
      INSERT INTO session_message SELECT *, 'assistant' FROM message;`);
    db.prepare('INSERT INTO event VALUES(?,?,?,?)').run('PRIVATE SESSION ID', 'session.created.1', from - 1000, '{}');
    for (const [table, columns] of Object.entries({ session: ['time_created'], session_v2: ['time_created'], message: ['time_created', 'time_updated'], session_message: ['time_created', 'time_updated'], part: ['time_created', 'time_updated'], event: ['created'] })) {
      for (const column of columns) for (const value of ['PRIVATE TIMESTAMP SENTINEL', Buffer.from('PRIVATE BLOB SENTINEL')]) {
        db.exec('SAVEPOINT malformed');
        db.prepare(`UPDATE ${table} SET ${column}=?`).run(value);
        const target = new DatabaseSync(':memory:');
        try {
          assert.throws(() => projectUsageMetadata(db, target), /^Error: Invalid usage timestamp$/);
          assert.doesNotMatch(JSON.stringify(target.prepare(`SELECT * FROM ${table}`).all()), /SENTINEL/);
        } finally { target.close(); db.exec('ROLLBACK TO malformed; RELEASE malformed'); }
      }
    }
    const cache = path.join(directory, 'cache'), index = new UsageIndex(cache);
    db.prepare('UPDATE message SET time_updated=?').run('PRIVATE TIMESTAMP SENTINEL');
    try {
      const dto = await settled(index, filename);
      assert.equal(dto.status, 'unavailable'); assert.equal(dto.index.state, 'failed');
      assert.doesNotMatch(JSON.stringify(dto), /PRIVATE|SENTINEL|source\.db/);
      assert.deepEqual(await readdir(cache), []);
    } finally { await index.close(); }
  });
});

test('durable usage accepts JSON-encoded token objects and fails malformed strings without publishing changed totals', async () => {
  await fixture(async (filename, directory, db) => {
    db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER, fork_session_id TEXT);
      CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, type TEXT);
      CREATE TABLE event(aggregate_id TEXT, type TEXT, created INTEGER, data TEXT);
      INSERT INTO session_v2 SELECT id, parent_id, time_created, NULL FROM session;
      DELETE FROM message; DELETE FROM part;`);
    db.prepare('INSERT INTO event VALUES(?,?,?,?)').run('PRIVATE SESSION ID', 'session.usage.recorded.1', from + 1000, JSON.stringify({ source: 'compaction', tokens: JSON.stringify(tokens) }));
    const cache = path.join(directory, 'cache'), index = new UsageIndex(cache);
    try {
      const live = readUsage(filename, range), first = ready(await settled(index, filename));
      assert.notEqual(live.status, 'unavailable');
      const { index: _index, ...accounting } = first;
      assert.deepEqual(accounting, { ...live, updatedAt: first.updatedAt });
      assert.equal(first.summary.tokens.total, 15);
      db.prepare('UPDATE event SET data=?').run(JSON.stringify({ source: 'compaction', tokens: 'PRIVATE INVALID TOKEN STRING' }));
      assert.equal(readUsage(filename, range).status, 'unavailable');
      await index.read(filename, range, true);
      const failed = ready(await settled(index, filename));
      assert.equal(failed.index.state, 'failed'); assert.deepEqual(failed.summary, first.summary);
      assert.doesNotMatch(JSON.stringify(failed), /PRIVATE|INVALID TOKEN/);
      for (const file of await readdir(cache)) assert.doesNotMatch((await readFile(path.join(cache, file))).toString(), /PRIVATE INVALID TOKEN/);
    } finally { await index.close(); }
  });
});

test('HTTP remains responsive during indexing and close waits for child/temp-file cleanup', async () => {
  await fixture(async (filename, directory) => {
    const cache = path.join(directory, 'cache');
    const app = createApp({ root: path.resolve('examples/demo'), usageDatabase: filename, usageCacheDirectory: cache });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const get = (url: string) => new Promise<any>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: (server.address() as { port: number }).port, path: url, headers: { host: '127.0.0.1:4317' } }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(JSON.parse(body)));
      }); req.on('error', reject); req.end();
    });
    try {
      assert.deepEqual(await get('/api/usage/status'), { state: 'indexing', indexedAt: null, sourceChanged: false });
      const initial = await get(`/api/usage?from=${range.from}&to=${range.to}&timezone=UTC`);
      assert.equal(initial.status, 'indexing');
      const snapshot = await get('/api/snapshot');
      assert.ok(snapshot); // Independent config endpoint works while the child builds.
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    const files = await readdir(cache).catch(() => []);
    assert.ok(files.every(file => file.endsWith('.sqlite')), files.join(','));
  });
});

test('new index endpoint observes without work, explicitly rebuilds, and validates raw query selection', async () => {
  await fixture(async (filename, directory) => {
    const cache = path.join(directory, 'cache');
    const app = createApp({ root: path.resolve('examples/demo'), usageDatabase: filename, usageCacheDirectory: cache });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const get = (url: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: (server.address() as { port: number }).port, path: url, headers: { host: '127.0.0.1:4317' } }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
      }); req.on('error', reject); req.end();
    });
    const observe = '/api/usage/index?mode=observe', rebuild = '/api/usage/index?mode=rebuild';
    const waitReady = async () => {
      for (let i = 0; i < 500; i++) {
        const { body } = await get(observe);
        if (body.state === 'ready' && body.indexedAt) return body;
        assert.ok(body.state === 'indexing' || body.state === 'refreshing', JSON.stringify(body));
        await delay(10);
      }
      throw new Error('Index did not settle');
    };
    try {
      const observed = await get(observe);
      assert.equal(observed.status, 200);
      assert.deepEqual(observed.body, { state: 'ready', indexedAt: null, sourceChanged: true });
      assert.deepEqual(await readdir(cache).catch(() => []), []);
      const invalid = await get('/api/usage/index?mode=observe&mode=rebuild');
      assert.equal(invalid.status, 400);
      assert.equal((await get('/api/usage/index?unexpected=1')).status, 400);
      assert.equal((await get('/api/usage/index?mode=unknown')).status, 400);
      assert.equal((await get('/api/usage/index')).status, 400);
      assert.equal((await get(rebuild)).body.state, 'indexing');
      assert.equal((await get('/api/usage/status')).body.state, 'indexing');
      const first = await waitReady();
      assert.equal(first.sourceChanged, false);
      assert.deepEqual((await get(rebuild)).body, { ...first, state: 'refreshing' });
      assert.notEqual((await waitReady()).indexedAt, first.indexedAt);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
