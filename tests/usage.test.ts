import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readUsage as readLiveUsage, readUsageSnapshot, parseUsageRange, resolveUsageDatabase } from '../server/usage.js';
import { projectUsageMetadata } from '../server/usage-index-build.js';
import { usageKey } from '../server/usage-sessions.js';
import { v2SkillRangeSQL } from '../server/usage-v2.js';
import { createApp } from '../server/app.js';

const from = Date.parse('2026-10-01T00:00:00Z'), to = from + 7 * 86_400_000;
const range = { from, to, timezone: 'America/New_York' };
const tokens = { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 }, total: 9999 };
// Every existing accounting assertion also verifies its private metadata
// projection. Fixture writes are synchronous between reads, so both see the same
// source state; the production/live benchmark additionally pins one snapshot.
function readUsage(filename: string | undefined, selectedRange: Parameters<typeof readLiveUsage>[1]) {
  const live = readLiveUsage(filename, selectedRange);
  if (live.status === 'unavailable') return live;
  const source = new DatabaseSync(filename!, { readOnly: true }), index = new DatabaseSync(':memory:');
  try {
    source.exec('PRAGMA query_only=ON; BEGIN');
    projectUsageMetadata(source, index);
    assert.deepEqual(readUsageSnapshot(index, selectedRange, live.updatedAt, true), live, 'projected accounting matches source');
    source.exec('ROLLBACK');
  } finally { source.close(); index.close(); }
  return live;
}
async function fixture(run: (db: DatabaseSync, filename: string) => Promise<void> | void) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inspector-usage-'));
  const filename = path.join(directory, 'usage.db');
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER);
    CREATE TABLE session_v2(id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER, fork_session_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, type TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE event(id TEXT PRIMARY KEY, aggregate_id TEXT, type TEXT, created INTEGER, data TEXT);
  `);
  try { await run(db, filename); } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
}
function session(db: DatabaseSync, id: string, created = from - 1000, parent: string | null = null, fork: string | null = null) {
  db.prepare('INSERT INTO session VALUES(?,?,?)').run(id, parent, created);
  db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?)').run(id, parent, created, fork);
}
function message(db: DatabaseSync, id: string, sessionID: string, time = from + 1000, agent: string | null = 'build', role = 'assistant', format: 'legacy' | 'v2' | 'both' = 'both', extra = {}) {
  const data = { role, agent, tokens, time: { created: time }, text: 'PRIVATE CONVERSATION sk-supersecret123', ...extra };
  if (format !== 'v2') db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run(id, sessionID, time, time, JSON.stringify(data));
  if (format !== 'legacy') db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?)').run(id, sessionID, time, time, JSON.stringify({ ...data, time: { created: time + 999 } }), role);
}
function skillPart(db: DatabaseSync, id: string, messageID: string, sessionID: string, status = 'completed', name = 'research', end = from + 2000) {
  db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(id, messageID, sessionID, end - 1, end, JSON.stringify({ type: 'tool', tool: 'skill', callID: 'reused-call-id', state: { status, input: { name }, time: { start: end - 1, end }, output: 'PRIVATE TOOL OUTPUT' } }));
}

test('model attribution follows reconciled assistant metadata, keeps provider pairs distinct and reconciles durable unknown usage', async () => {
  await fixture((db, filename) => {
    session(db, 'root'); session(db, 'child', from - 1000, 'root'); session(db, 'fork', from + 5000, null, 'root');
    const legacy = { providerID: 'provider-a', modelID: 'shared', model: { providerID: 'ignored', id: 'ignored' } };
    const native = { model: { providerID: 'provider-b', id: 'shared', variant: 'high', secret: 'PRIVATE MODEL SECRET' } };
    message(db, 'tie', 'root', from + 1000, 'build', 'assistant', 'both', legacy);
    message(db, 'newer', 'root', from + 1000, 'build', 'assistant', 'both', legacy);
    db.prepare('UPDATE session_message SET time_updated=?,data=? WHERE id=?').run(from + 2000, JSON.stringify({ agent: 'build', tokens, ...native }), 'newer');
    message(db, 'legacy-newer', 'root', from + 1000, 'build', 'assistant', 'both', native);
    db.prepare('UPDATE message SET time_updated=?,data=? WHERE id=?').run(from + 2000, JSON.stringify({ role: 'assistant', agent: 'build', tokens, ...legacy }), 'legacy-newer');
    message(db, 'child', 'child', from + 1000, 'build', 'assistant', 'v2', native);
    message(db, 'repeat', 'root', Date.parse('2026-10-01T04:00:00Z'), 'build', 'assistant', 'legacy', legacy);
    message(db, 'copy', 'fork', from + 1000, 'build', 'assistant', 'v2', native);
    message(db, 'excluded', 'root', to, 'build', 'assistant', 'legacy', legacy);
    message(db, 'user', 'root', from + 1000, 'build', 'user', 'legacy', legacy);
    message(db, 'unknown', 'root', from + 1000, 'build', 'assistant', 'v2', { tokens: null, model: { providerID: { secret: 'PRIVATE' }, id: 'sk-privatecredential12345' } });
    message(db, 'partial', 'child', from + 1000, 'build', 'assistant', 'v2', { model: { providerID: 'provider-b', id: 'x'.repeat(257) } });
    const vertexModels = ['claude-sonnet-4-5@20250929', 'claude-haiku-4-5@20251001'];
    for (const modelID of vertexModels) {
      message(db, `legacy-${modelID}`, 'root', from + 1000, 'build', 'assistant', 'legacy', { providerID: 'google-vertex-anthropic', modelID });
      message(db, `v2-${modelID}`, 'child', from + 1000, 'build', 'assistant', 'v2', { model: { providerID: 'google-vertex-anthropic', id: modelID } });
    }
    // The durable contract has no model identity. Neither nearby assistant nor
    // compaction projection metadata can establish one-to-one correspondence.
    message(db, 'compaction', 'root', from + 3000, null, 'compaction', 'v2', { status: 'completed', ...native });
    for (const source of ['title', 'compaction']) db.prepare('INSERT INTO event VALUES(?,?,?,?,?)').run(source, 'root', 'session.usage.recorded.1', from + 3000, JSON.stringify({ source, tokens }));
    const result = readUsage(filename, range);
    assert.ok(result.status !== 'unavailable');
    const row = (provider: string | null, model: string | null) => result.models.find(entry => entry.provider === provider && entry.model === model)!;
    assert.equal(result.models.length, 6, 'aggregate rankings remain grouped without role');
    for (const modelID of vertexModels) {
      assert.equal(row('google-vertex-anthropic', modelID).steps, 2);
      assert.equal(row('google-vertex-anthropic', modelID).sessions, 2);
      assert.equal(row('google-vertex-anthropic', modelID).tokens.total, 84);
    }
    assert.equal(row('google-vertex-anthropic', null), undefined);
    assert.equal(row('provider-a', 'shared').steps, 3); assert.equal(row('provider-a', 'shared').sessions, 1);
    assert.equal(row('provider-b', 'shared').steps, 2); assert.equal(row('provider-b', 'shared').sessions, 2);
    assert.equal(row('provider-b', null).steps, 1);
    assert.equal(row(null, null).steps, 1); assert.equal(row(null, null).sessions, 1);
    assert.equal(row(null, null).tokens.total, 84, 'two durable usages, invalid assistant counters excluded');
    assert.deepEqual(result.modelActivity.filter(entry => entry.model === 'shared'), [
      { date: '2026-09-30', provider: 'provider-a', model: 'shared', role: 'main', tokens: 84, sessions: 1, steps: 2 },
      { date: '2026-10-01', provider: 'provider-a', model: 'shared', role: 'main', tokens: 42, sessions: 1, steps: 1 },
      { date: '2026-09-30', provider: 'provider-b', model: 'shared', role: 'main', tokens: 42, sessions: 1, steps: 1 },
      { date: '2026-09-30', provider: 'provider-b', model: 'shared', role: 'subagent', tokens: 42, sessions: 1, steps: 1 },
    ]);
    assert.deepEqual(result.agentActivity.filter(entry => entry.agent === 'build'), [
      { date: '2026-09-30', tokens: 210, sessions: 1, steps: 6, agent: 'build', role: 'main' },
      { date: '2026-10-01', tokens: 42, sessions: 1, steps: 1, agent: 'build', role: 'main' },
      { date: '2026-09-30', tokens: 168, sessions: 1, steps: 4, agent: 'build', role: 'subagent' },
    ]);
    assert.ok(result.modelActivity.some(entry => entry.provider === null && entry.model === null && entry.role === 'main' && entry.tokens === 84 && entry.sessions === 1 && entry.steps === 1));
    for (const timeline of [result.modelActivity, result.agentActivity]) {
      for (const day of result.activity) {
        const records = timeline.filter(row => row.date === day.date);
        assert.equal(records.reduce((sum, row) => sum + row.tokens, 0), day.tokens.total);
        assert.equal(records.reduce((sum, row) => sum + row.steps, 0), day.steps);
      }
    }
    assert.equal(result.models.reduce((sum, entry) => sum + entry.steps, 0), result.summary.steps);
    for (const key of Object.keys(result.summary.tokens) as Array<keyof typeof result.summary.tokens>) {
      assert.equal(result.models.reduce((sum, entry) => sum + entry.tokens[key], 0), result.summary.tokens[key], key);
    }
    assert.doesNotMatch(JSON.stringify(result.models), /PRIVATE|sk-private|ignored|variant|secret/);
  });
});

test('weekly and monthly buckets use local calendar boundaries and count distinct sessions', async () => {
  await fixture((db, filename) => {
    const start = Date.parse('2026-11-01T03:59:59.999Z'), end = Date.parse('2026-12-01T05:00:00.001Z');
    session(db, 'root', start);
    session(db, 'other', Date.parse('2026-11-02T05:00:00.000Z'));
    session(db, 'child', start, 'root');
    const rows = [
      ['root', '2026-11-01T03:59:59.999Z'], // Still October locally; inclusive start.
      ['root', '2026-11-01T04:00:00.000Z'],
      ['root', '2026-11-01T05:59:59.999Z'], // DST fall-back.
      ['root', '2026-11-01T06:00:00.000Z'],
      ['root', '2026-11-02T04:59:59.999Z'], // Still Sunday after the offset changed.
      ['root', '2026-11-02T05:00:00.000Z'],
      ['root', '2026-11-03T05:00:00.000Z'],
      ['other', '2026-11-03T05:00:00.000Z'],
      ['child', '2026-11-02T05:00:00.000Z'],
      ['child', '2026-11-03T05:00:00.000Z'],
      ['root', '2026-12-01T04:59:59.999Z'],
      ['root', '2026-12-01T05:00:00.000Z'],
      ['root', '2026-12-01T05:00:00.001Z'], // Exclusive end.
    ];
    rows.forEach(([id, time], i) => message(db, `msg-${i}`, id, Date.parse(time), 'build', 'assistant', 'legacy', { providerID: 'example', modelID: 'model' }));

    const expected = {
      week: [
        { date: '2026-10-26', activeSessions: 1, newSessions: 1, subagentSessions: 0, steps: 5 },
        { date: '2026-11-02', activeSessions: 2, newSessions: 1, subagentSessions: 1, steps: 5 },
        { date: '2026-11-30', activeSessions: 1, newSessions: 0, subagentSessions: 0, steps: 2 },
      ],
      month: [
        { date: '2026-10-01', activeSessions: 1, newSessions: 1, subagentSessions: 0, steps: 1 },
        { date: '2026-11-01', activeSessions: 2, newSessions: 1, subagentSessions: 1, steps: 10 },
        { date: '2026-12-01', activeSessions: 1, newSessions: 0, subagentSessions: 0, steps: 1 },
      ],
    };
    for (const granularity of ['week', 'month'] as const) {
      const result = readUsage(filename, { from: start, to: end, timezone: range.timezone, granularity });
      assert.ok(result.status !== 'unavailable');
      assert.deepEqual(result.activity.map(({ tokens, ...row }) => ({ ...row, tokens: tokens.total })),
        expected[granularity].map(row => ({ ...row, tokens: row.steps * 42 })));
      const main = expected[granularity].map(({ date, activeSessions, subagentSessions, steps }) => ({
        date, sessions: activeSessions, steps: steps - 2 * subagentSessions, tokens: (steps - 2 * subagentSessions) * 42, role: 'main',
      }));
      const child = { date: expected[granularity][1].date, sessions: 1, steps: 2, tokens: 84, role: 'subagent' };
      assert.deepEqual(result.agentActivity, [...main, child].map(row => ({ ...row, agent: 'build' })));
      assert.deepEqual(result.modelActivity, [...main, child].map(row => ({ ...row, provider: 'example', model: 'model' })));
      assert.deepEqual(result.summary, {
        activeSessions: 2, newSessions: 2, subagentSessions: 1, steps: 12,
        tokens: { input: 120, output: 240, reasoning: 36, cacheRead: 48, cacheWrite: 60, total: 504 },
      });
      assert.equal(result.agents[0].sessions, 3);
      assert.equal(result.models[0].sessions, 3);
    }
  });
});

test('hourly model and agent timelines keep the repeated local hour distinct', async () => {
  await fixture((db, filename) => {
    const start = Date.parse('2026-11-01T04:00:00Z'), end = Date.parse('2026-11-02T05:00:00Z');
    const selected = parseUsageRange({ from: String(start), to: String(end), timezone: range.timezone, granularity: 'hour' });
    assert.ok(selected);
    session(db, 'root');
    const model = { model: { providerID: 'example', id: 'model' } };
    message(db, 'early', 'root', Date.parse('2026-11-01T05:59:59Z'), 'build', 'assistant', 'v2', model);
    message(db, 'late', 'root', Date.parse('2026-11-01T06:00:00Z'), 'review', 'assistant', 'v2', model);
    message(db, 'exclude-end', 'root', end, 'review', 'assistant', 'v2', model);
    const result = readUsage(filename, selected);
    assert.notEqual(result.status, 'unavailable');
    if (result.status === 'unavailable') return;
    const expected = [{ date: '2026-11-01T05:00:00.000Z', tokens: 42, steps: 1, sessions: 1 },
      { date: '2026-11-01T06:00:00.000Z', tokens: 42, steps: 1, sessions: 1 }];
    assert.deepEqual(result.modelActivity, expected.map(row => ({ ...row, provider: 'example', model: 'model', role: 'main' })));
    assert.deepEqual(result.agentActivity, [{ ...expected[0], agent: 'build', role: 'main' }, { ...expected[1], agent: 'review', role: 'main' }]);
    assert.equal(result.activity.length, 1, 'overview remains daily');
    assert.equal(result.summary.tokens.total, 84);
  });
});

function taskPart(db: DatabaseSync, id: string, messageID: string, sessionID: string, options: {
  call?: unknown; created?: unknown; status?: unknown; callee?: unknown; child?: unknown; resume?: unknown;
} = {}) {
  const created = options.created ?? from + 2000;
  db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(id, messageID, sessionID, created as any, to + 1000, JSON.stringify({
    type: 'tool', tool: 'task', callID: 'call' in options ? options.call : id,
    state: { status: options.status ?? 'completed', input: { subagent_type: options.callee ?? 'research', task_id: options.resume,
      prompt: 'PRIVATE TASK PROMPT', description: 'PRIVATE DESCRIPTION' }, metadata: { sessionId: options.child },
      time: { start: from - 9999, end: to + 1000 }, error: 'PRIVATE ERROR', output: 'PRIVATE OUTPUT' },
  }));
}
function delegationTool(id: unknown, agent: unknown, created: unknown = from + 2000, extra = {}) {
  return { type: 'tool', name: 'subagent', id, state: { status: 'completed', input: { agent, prompt: 'PRIVATE V2 PROMPT' }, metadata: {} }, time: { created, completed: to + 1 }, ...extra };
}
function delegationResult(filename: string, selectedRange = range) {
  const result = readUsage(filename, selectedRange);
  assert.ok(result.status !== 'unavailable');
  // Root outgoing counts intentionally mirror direct incoming nodes; every call
  // contributes to exactly one incoming node, including unknown/limited branches.
  assert.equal(result.delegations.nodes.filter(node => node.countBasis === 'incoming').reduce((n, node) => n + node.attempts, 0), result.delegations.totalAttempts);
  for (const node of result.delegations.nodes) {
    assert.equal(Object.values(node.statuses).reduce((a, b) => a + b, 0), node.attempts);
    assert.equal(node.contextOnly, node.attempts === 0);
    assert.match(node.id, /^[a-f0-9]{64}$/);
  }
  return result.delegations;
}

test('token and step rankings independently select their top ten with stable ties', async () => {
  await fixture((db, filename) => {
    const stepLeaders = Array.from({ length: 10 }, (_, i) => `step-leader-${i}`);
    for (const id of stepLeaders) {
      session(db, id);
      message(db, `${id}-first`, id);
      message(db, `${id}-second`, id);
    }
    session(db, 'token-leader');
    message(db, 'token-heavy-step', 'token-leader', from + 1000, 'build', 'assistant', 'both', { tokens: { ...tokens, input: 1000 } });

    const result = readUsage(filename, range);
    assert.ok(result.status !== 'unavailable');
    const stepIDs = stepLeaders.map(usageKey).sort();
    const ranking = (rows: typeof result.topSessions) => rows.map(row => [row.id, row.steps, row.tokens]);
    assert.deepEqual(ranking(result.topSessions), stepIDs.map(id => [id, 2, 84]));
    assert.deepEqual(ranking(result.topSessionsByTokens), [
      [usageKey('token-leader'), 1, 1032],
      ...stepIDs.slice(0, 9).map(id => [id, 2, 84]),
    ]);
  });
});

test('durable descendant tokens rank under their root while zero and invalid counters still count as steps', async () => {
  await fixture((db, filename) => {
    session(db, 'root');
    session(db, 'child', from - 1000, 'root');
    session(db, 'steps-only');
    message(db, 'zero-step', 'steps-only', from + 1000, 'build', 'assistant', 'both', {
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 9999 },
    });
    message(db, 'invalid-step', 'steps-only', from + 1000, 'build', 'assistant', 'both', {
      tokens: { ...tokens, input: -1 },
    });
    db.prepare('INSERT INTO event VALUES(?,?,?,?,?)').run('durable', 'child', 'session.usage.recorded.1', from + 2000, JSON.stringify({ source: 'title', tokens }));

    const result = readUsage(filename, range);
    assert.ok(result.status !== 'unavailable');
    assert.deepEqual(result.topSessions, [
      { id: usageKey('steps-only'), title: null, project: null, steps: 2, tokens: 0 },
    ]);
    assert.deepEqual(result.topSessionsByTokens, [
      { id: usageKey('root'), title: null, project: null, steps: 0, tokens: 42 },
    ]);
    assert.equal(result.summary.tokens.total, 42);
  });
});

test('project scopes reconcile moved sessions, roll up verified descendants, and preserve all-project picker totals', async () => {
  await fixture((db, filename) => {
    db.exec(`CREATE TABLE project(id TEXT PRIMARY KEY, name TEXT, worktree TEXT);
      INSERT INTO project VALUES ('PROJ_ALPHA', 'Alpha', '/Users/PRIVATE/alpha'),
        ('PROJ_BETA', NULL, '/Users/PRIVATE/beta/'), ('global', 'Do not use', '/');
      ALTER TABLE session ADD COLUMN project_id TEXT;
      ALTER TABLE session ADD COLUMN title TEXT;
      ALTER TABLE session ADD COLUMN time_updated INTEGER;
      ALTER TABLE session_v2 ADD COLUMN project_id TEXT;
      ALTER TABLE session_v2 ADD COLUMN title TEXT;
      ALTER TABLE session_v2 ADD COLUMN time_updated INTEGER;`);
    const addSession = (id: string, project: string | null, title: string, parent: string | null = null, fork: string | null = null, created = from - 1000) => {
      db.prepare('INSERT INTO session VALUES(?,?,?,?,?,?)').run(id, parent, created, project, title, from);
      db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?)').run(id, parent, created, fork, project, title, from);
    };
    addSession('root-moved', 'PROJ_ALPHA', 'Moved sk-faketitle12345');
    // Worktree.Event.Resolved changes V2 project_id without touching time_updated.
    db.prepare('UPDATE session_v2 SET project_id=?,title=? WHERE id=?')
      .run('PROJ_BETA', 'Tie loses', 'root-moved');
    addSession('child', 'PROJ_ALPHA', 'Child', 'root-moved');
    addSession('grandchild', null, 'Grandchild', 'child');
    // Parent records and descendants may exist in only one format each.
    db.exec("DELETE FROM session_v2 WHERE id='grandchild'; DELETE FROM session WHERE id='child'");
    addSession('alpha-root', 'PROJ_ALPHA', 'Alpha task');
    db.exec("UPDATE session_v2 SET title='Tie loses' WHERE id='alpha-root'");
    addSession('alpha-user', 'PROJ_ALPHA', 'User-only');
    addSession('fork', 'PROJ_ALPHA', 'Independent fork', null, 'root-moved', from + 900);
    addSession('unattributed-root', 'global', '/Users/PRIVATE/title');
    addSession('orphan', 'MISSING_PROJECT', 'Orphan', 'missing-session');
    addSession('cycle', 'PROJ_ALPHA', 'Cycle', 'cycle');
    addSession('ambiguous', 'PROJ_ALPHA', 'Conflict', 'root-moved');
    db.exec("UPDATE session_v2 SET parent_id='alpha-root' WHERE id='ambiguous'");
    message(db, 'migrated', 'root-moved');
    message(db, 'updated', 'root-moved', from + 1000, 'winner');
    db.prepare('UPDATE session_message SET time_updated=? WHERE id=?').run(from + 3000, 'updated');
    message(db, 'child-step', 'child', from + 1000, 'review', 'assistant', 'v2', {
      tokens: null,
      content: [{ type: 'tool', id: 'load', name: 'skill', state: { status: 'completed', input: { name: 'v2-skill' } }, time: { completed: from + 2000 } }],
    });
    message(db, 'grandchild-step', 'grandchild', from + 1001, 'legacy', 'assistant', 'legacy');
    message(db, 'activation', 'child', from + 1000, null, 'skill', 'v2', { name: 'activated' });
    message(db, 'a1', 'alpha-root', from + 1000, 'alpha', 'assistant', 'legacy');
    message(db, 'a2', 'alpha-root', from + 1000, 'alpha', 'assistant', 'legacy');
    message(db, 'user-only', 'alpha-user', from + 1000, null, 'user');
    message(db, 'copy', 'fork', from + 800);
    message(db, 'fork-step', 'fork');
    message(db, 'global-step', 'unattributed-root');
    message(db, 'orphan-step', 'orphan');
    message(db, 'cycle-step', 'cycle');
    message(db, 'conflict-step', 'ambiguous');
    message(db, 'exclusive-end', 'root-moved', to);
    db.prepare('INSERT INTO event VALUES(?,?,?,?,?)').run('durable', 'child', 'session.usage.recorded.1', from + 4000, JSON.stringify({ source: 'title', tokens }));
    skillPart(db, 'legacy-skill', 'migrated', 'root-moved', 'completed', 'legacy-skill');
    skillPart(db, 'alpha-skill', 'a1', 'alpha-root', 'error', 'legacy-skill');
    taskPart(db, 'moved-attempt', 'migrated', 'root-moved', { child: 'child' });
    taskPart(db, 'alpha-attempt', 'a1', 'alpha-root', { callee: 'alpha-agent' });
    taskPart(db, 'unlocated', 'orphan-step', 'orphan', { created: 'invalid' });

    const all = readUsage(filename, range);
    assert.ok(all.status !== 'unavailable');
    const [alpha, beta, unknown] = all.projects;
    assert.match(alpha.id, /^[0-9a-f]{64}$/); assert.match(beta.id, /^[0-9a-f]{64}$/);
    assert.deepEqual(all.projects, [
      { id: alpha.id, name: 'Alpha', sessions: 3, steps: 5, tokens: 210 },
      { id: beta.id, name: 'beta', sessions: 1, steps: 4, tokens: 168 },
      { id: 'unattributed', name: 'Unattributed', sessions: 1, steps: 2, tokens: 84 },
    ]);
    assert.equal(all.summary.steps, 11);
    assert.equal(all.summary.activeSessions, 5);
    assert.equal(all.topSessions.length, 4);
    assert.deepEqual(all.topSessions.slice(0, 2).map(({ id, ...row }) => {
      assert.match(id, /^[0-9a-f]{64}$/); return row;
    }), [
      { title: 'Moved [REDACTED]', project: 'beta', steps: 4, tokens: 168 },
      { title: 'Alpha task', project: 'Alpha', steps: 2, tokens: 84 },
    ]);
    assert.deepEqual(all.topSessionsByTokens, all.topSessions, 'unverified ancestry contributes to totals but not either rank');

    const scoped = readUsage(filename, { ...range, project: beta.id });
    assert.ok(scoped.status !== 'unavailable');
    assert.deepEqual(scoped.projects, all.projects);
    assert.deepEqual(scoped.topSessions, all.topSessions.slice(0, 1));
    assert.deepEqual(scoped.topSessionsByTokens, all.topSessionsByTokens.slice(0, 1));
    assert.deepEqual([scoped.summary.activeSessions, scoped.summary.subagentSessions, scoped.summary.newSessions, scoped.summary.steps, scoped.summary.tokens.total], [1, 2, 0, 4, 168]);
    for (const rows of [scoped.activity, scoped.agents, scoped.models, scoped.agentActivity, scoped.modelActivity]) {
      assert.equal(rows.reduce((sum, row) => sum + row.steps, 0), 4);
    }
    assert.deepEqual(scoped.skills.map(row => row.name), ['activated', 'legacy-skill', 'v2-skill']);
    assert.equal(scoped.delegations.totalAttempts, 1);
    assert.equal(scoped.delegations.unlocatedAttempts, 0);
    assert.ok(!scoped.delegations.nodes.some(node => node.agent === 'alpha-agent'));

    const childOnly = readUsage(filename, { ...range, from: from + 1001, to: from + 1002, project: beta.id });
    assert.ok(childOnly.status !== 'unavailable');
    assert.equal(childOnly.summary.activeSessions, 0);
    assert.deepEqual(childOnly.topSessions, [{ ...all.topSessions[0], steps: 1, tokens: 42 }]);
    assert.deepEqual(childOnly.topSessionsByTokens, childOnly.topSessions);

    const alphaScope = readUsage(filename, { ...range, project: alpha.id });
    assert.ok(alphaScope.status !== 'unavailable');
    assert.equal(alphaScope.summary.newSessions, 1);
    assert.deepEqual(alphaScope.topSessions.map(row => row.title), ['Alpha task', 'Independent fork']);
    assert.deepEqual(alphaScope.skills, [{ name: 'legacy-skill', sessions: 1, loads: 0, failedLoads: 1 }]);

    const unassigned = readUsage(filename, { ...range, project: unknown.id });
    assert.ok(unassigned.status !== 'unavailable');
    assert.equal(unassigned.summary.steps, 2);
    assert.deepEqual(unassigned.topSessions.map(({ id: _id, ...row }) => row), [{ title: null, project: null, steps: 1, tokens: 42 }]);
    assert.deepEqual(unassigned.topSessionsByTokens, unassigned.topSessions);
    assert.equal(unassigned.delegations.totalAttempts, 0);
    assert.equal(unassigned.delegations.unlocatedAttempts, 1);

    const combined = readUsage(filename, { ...range, projects: [alpha.id, beta.id].sort() });
    assert.ok(combined.status !== 'unavailable');
    assert.deepEqual(combined.projects, all.projects);
    assert.deepEqual(combined.topSessions, all.topSessions.filter(row => row.project !== null));
    assert.deepEqual(combined.topSessionsByTokens, all.topSessionsByTokens.filter(row => row.project !== null));
    assert.deepEqual([combined.summary.activeSessions, combined.summary.subagentSessions, combined.summary.newSessions, combined.summary.steps, combined.summary.tokens.total], [4, 4, 1, 9, 378]);
    for (const rows of [combined.activity, combined.agents, combined.models, combined.agentActivity, combined.modelActivity]) {
      assert.equal(rows.reduce((sum, row) => sum + row.steps, 0), 9);
    }
    assert.deepEqual(combined.models.map(row => [row.sessions, row.steps]), [[7, 9]], 'shared model rows merge across selected owners');
    assert.deepEqual(combined.skills, [
      { name: 'activated', sessions: 1, loads: 1, failedLoads: 0 },
      { name: 'legacy-skill', sessions: 2, loads: 1, failedLoads: 1 },
      { name: 'v2-skill', sessions: 1, loads: 1, failedLoads: 0 },
    ]);
    assert.equal(combined.delegations.totalAttempts, 2);
    assert.equal(combined.delegations.unlocatedAttempts, 0);
    assert.ok(combined.delegations.nodes.some(node => node.agent === 'alpha-agent'));
    assert.doesNotMatch(combined.delegations.warnings.join(' '), /lack a valid creation timestamp/);

    const includingUnattributed = readUsage(filename, { ...range, projects: [beta.id, unknown.id].sort() });
    assert.ok(includingUnattributed.status !== 'unavailable');
    assert.deepEqual(includingUnattributed.projects, all.projects);
    assert.equal(includingUnattributed.summary.steps, 6);
    assert.equal(includingUnattributed.summary.tokens.total, 252);
    assert.deepEqual(includingUnattributed.topSessions, [...scoped.topSessions, ...unassigned.topSessions]);
    assert.deepEqual(includingUnattributed.topSessionsByTokens, [...scoped.topSessionsByTokens, ...unassigned.topSessionsByTokens]);
    assert.deepEqual(includingUnattributed.skills, scoped.skills);
    assert.equal(includingUnattributed.delegations.totalAttempts, 1);
    assert.equal(includingUnattributed.delegations.unlocatedAttempts, 1);
    assert.deepEqual(includingUnattributed.delegations.nodes, scoped.delegations.nodes);
    assert.doesNotMatch(JSON.stringify([all, scoped, unassigned, combined, includingUnattributed]), /PROJ_|MISSING_PROJECT|PRIVATE|sk-faketitle|root-moved|Tie loses/);

    for (let i = 0; i < 8; i++) {
      addSession(`extra-${i}`, 'PROJ_ALPHA', `Extra session ${i}`);
      message(db, `extra-step-${i}`, `extra-${i}`);
    }
    const expanded = readUsage(filename, range);
    assert.ok(expanded.status !== 'unavailable');
    assert.equal(expanded.topSessions.length, 10);
    assert.deepEqual(expanded.topSessions.slice(0, 2), all.topSessions.slice(0, 2));

    db.exec('ALTER TABLE session_v2 DROP COLUMN project_id');
    const missingV2ProjectField = readUsage(filename, range);
    assert.ok(missingV2ProjectField.status !== 'unavailable');
    assert.deepEqual(missingV2ProjectField.topSessions[0], { ...all.topSessions[0], project: 'Alpha' });
  });
});

test('record-specific V2 skill and delegation diagnostics only affect their owning scope', async () => {
  await fixture((db, filename) => {
    db.exec(`CREATE TABLE project(id TEXT PRIMARY KEY, name TEXT);
      INSERT INTO project VALUES ('clean', 'Clean'), ('dirty', 'Dirty');
      ALTER TABLE session ADD COLUMN project_id TEXT;
      ALTER TABLE session_v2 ADD COLUMN project_id TEXT;`);
    db.prepare('INSERT INTO session VALUES(?,?,?,?)').run('clean-owner', null, from - 1000, 'clean');
    db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?,?)').run('dirty-owner', null, from - 1000, null, 'dirty');
    message(db, 'clean-message', 'clean-owner', from + 1000, 'build', 'assistant', 'legacy');
    const load = { type: 'tool', id: 'attempt', name: 'skill', state: { status: 'completed', input: { name: 'notes' } }, time: { completed: from + 2000 } };
    message(db, 'dirty-duplicates', 'dirty-owner', from + 1000, 'build', 'assistant', 'v2', { content: [load, load] });
    message(db, 'dirty-shape', 'dirty-owner', from - 500, 'build', 'assistant', 'v2', { content: {} });
    message(db, 'dirty-future', 'dirty-owner', to + 1000, 'build', 'assistant', 'v2', { content: [{ ...load, time: {} }] });
    const all = readUsage(filename, range);
    assert.ok(all.status === 'partial');
    const clean = all.projects.find(row => row.name === 'Clean')!, dirty = all.projects.find(row => row.name === 'Dirty')!;
    assert.match(all.warnings.join(' '), /Duplicate V2 skill/);
    assert.doesNotMatch(all.warnings.join(' '), /lack a completion timestamp/);
    assert.match(all.delegations.warnings.join(' '), /unsupported shape/, 'snapshot diagnostic includes earlier attempts');
    const cleanRange = { ...range, project: clean.id };
    const cleanScope = readUsage(filename, cleanRange);
    assert.ok(cleanScope.status === 'available');
    assert.deepEqual(cleanScope.warnings, []);
    assert.deepEqual(cleanScope.delegations.warnings, []);
    const cleanUnion = readUsage(filename, { ...range, projects: [clean.id, 'unattributed'] });
    assert.ok(cleanUnion.status === 'available');
    assert.deepEqual(cleanUnion.warnings, []);
    assert.deepEqual(cleanUnion.delegations.warnings, []);
    const dirtyScope = readUsage(filename, { ...range, project: dirty.id, to: to + 2000 });
    assert.ok(dirtyScope.status === 'partial');
    assert.match(dirtyScope.warnings.join(' '), /Duplicate V2 skill/);
    assert.match(dirtyScope.warnings.join(' '), /lack a completion timestamp/);
    assert.match(dirtyScope.delegations.warnings.join(' '), /unsupported shape/);
    const dirtyUnion = readUsage(filename, { ...range, to: to + 2000, projects: [clean.id, dirty.id].sort() });
    assert.ok(dirtyUnion.status === 'partial');
    assert.deepEqual(dirtyUnion.warnings, dirtyScope.warnings);
    assert.deepEqual(dirtyUnion.delegations.warnings, dirtyScope.delegations.warnings);
    db.exec('DROP TABLE part');
    const structuralWarning = readUsage(filename, cleanRange);
    assert.ok(structuralWarning.status === 'partial');
    assert.match(structuralWarning.delegations.warnings.join(' '), /Legacy delegation tool history is unavailable/);
  });
});

test('delegations reconcile messages before extraction across legacy, migrated task and native V2; reject forks and non-assistant owners', async () => {
  await fixture((db, filename) => {
    session(db, 'root'); session(db, 'fork', from + 5000, null, 'root'); session(db, 'other');
    const migrated = { type: 'tool', name: 'task', id: 'shared', state: { status: 'completed', input: { subagent_type: 'migrated' }, metadata: {} }, time: { created: from + 2000 } };
    message(db, 'tie', 'root', from + 1000, 'plan', 'assistant', 'both', { content: [migrated] });
    taskPart(db, 'tie-part', 'tie', 'root', { call: 'shared', callee: 'legacy-tie' });
    message(db, 'v2-newer', 'root', from + 1000, 'build', 'assistant', 'both', { content: [delegationTool('shared', 'native')] });
    taskPart(db, 'superseded-part', 'v2-newer', 'root', { callee: 'must-not-union' });
    db.prepare('UPDATE session_message SET time_updated=? WHERE id=?').run(from + 3000, 'v2-newer');
    message(db, 'legacy-newer', 'root', from + 1000, 'custom-main', 'assistant', 'both', { content: [migrated] });
    taskPart(db, 'newer-part', 'legacy-newer', 'root', { callee: 'legacy-newer' });
    db.prepare('UPDATE message SET time_updated=? WHERE id=?').run(from + 4000, 'legacy-newer');
    message(db, 'migrated', 'root', from + 1000, 'build', 'assistant', 'v2', { content: [migrated] });
    message(db, 'fork-copy', 'fork', from + 1000, 'build', 'assistant', 'v2', { content: [delegationTool('fork', 'copied')] });
    message(db, 'user', 'root', from + 1000, 'build', 'user', 'both', { content: [delegationTool('user-call', 'ignored')] });
    taskPart(db, 'user-part', 'user', 'root'); taskPart(db, 'wrong-session', 'tie', 'other');
    const tree = delegationResult(filename);
    assert.equal(tree.totalAttempts, 4);
    assert.deepEqual(tree.nodes.filter(n => n.countBasis === 'incoming').map(n => n.agent).sort(), ['legacy-newer', 'legacy-tie', 'migrated', 'native']);
    assert.deepEqual(tree.nodes.filter(n => n.role === 'main').map(n => [n.agent, n.attempts]).sort(), [['build', 2], ['custom-main', 1], ['plan', 1]]);
  });
});

test('delegation identity is message/session scoped; duplicate first record wins and malformed IDs use distinct local keys', async () => {
  await fixture((db, filename) => {
    session(db, 'root'); session(db, 'other');
    message(db, 'a', 'root', from + 1000, 'build', 'assistant', 'legacy');
    message(db, 'b', 'root', from + 1000, 'build', 'assistant', 'legacy');
    message(db, 'a', 'other', from + 1000, 'plan', 'assistant', 'v2', { content: [delegationTool('reused', 'v2'), delegationTool('reused', 'duplicate-v2'), delegationTool(null, 'missing'), delegationTool(null, 'missing')] });
    taskPart(db, 'z-first', 'a', 'root', { call: 'reused', status: 'pending', callee: 'first' });
    taskPart(db, 'a-duplicate', 'a', 'root', { call: 'reused', callee: 'duplicate' });
    taskPart(db, 'other-message', 'b', 'root', { call: 'reused' });
    taskPart(db, 'missing-1', 'a', 'root', { call: null, callee: 'missing' });
    taskPart(db, 'missing-2', 'a', 'root', { call: { secret: 'PRIVATE MALFORMED CALL ID' }, callee: 'missing' });
    const tree = delegationResult(filename);
    assert.equal(tree.totalAttempts, 7);
    assert.equal(tree.nodes.find(n => n.agent === 'first')?.statuses.pending, 1);
    assert.equal(tree.nodes.filter(n => n.agent === 'missing').reduce((n, node) => n + node.attempts, 0), 4);
    assert.match(tree.warnings.join(' '), /Duplicate/); assert.match(tree.warnings.join(' '), /record-local/);
    assert.doesNotMatch(JSON.stringify(tree), /PRIVATE|duplicate-v2|"duplicate"/);
    db.exec('ALTER TABLE part RENAME TO old_part; CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT) WITHOUT ROWID; INSERT INTO part SELECT * FROM old_part; DROP TABLE old_part;');
    const reordered = delegationResult(filename);
    assert.equal(reordered.totalAttempts, 7);
    assert.equal(reordered.nodes.find(n => n.agent === 'duplicate')?.attempts, 1);
  });
});

test('delegation attempts use creation boundaries and recorded statuses, not completion, child counts or requested resumes', async () => {
  await fixture((db, filename) => {
    session(db, 'root', from - 20000); session(db, 'child', from - 1000, 'root');
    message(db, 'old', 'root', from - 5000, 'plan', 'assistant', 'legacy');
    taskPart(db, 'before', 'old', 'root', { created: from - 1 });
    taskPart(db, 'start', 'old', 'root', { created: from, child: 'child' });
    taskPart(db, 'resume', 'old', 'root', { created: from + 1, child: 'child', resume: 'child', status: 'error' });
    taskPart(db, 'pending', 'old', 'root', { status: 'pending', resume: 'child' });
    taskPart(db, 'end', 'old', 'root', { created: to });
    message(db, 'native', 'root', from + 1000, 'build', 'assistant', 'v2', { content: [
      delegationTool('stream', 'research', from + 2, { state: { status: 'streaming', input: 'PRIVATE RAW INCOMPLETE ARGUMENTS' } }),
      delegationTool('running', 'research', from + 3, { state: { status: 'running', input: { agent: 'research', sessionID: 'child' }, metadata: {} } }),
      delegationTool('background', 'research', from + 4, { state: { status: 'completed', input: { agent: 'research', background: true }, metadata: { sessionID: 'child', status: 'running' } } }),
      delegationTool('unknown', 'research', from + 5, { state: { status: 'future', input: { agent: 'research' } } }),
      delegationTool('unlocated', 'research', 'PRIVATE BAD TIMESTAMP'),
    ] });
    const tree = delegationResult(filename);
    assert.equal(tree.totalAttempts, 7); assert.equal(tree.unlocatedAttempts, 1);
    const incoming = tree.nodes.filter(n => n.countBasis === 'incoming');
    assert.deepEqual(Object.fromEntries(['pending','streaming','running','completed','error','unknown'].map(status => [status, incoming.reduce((n, node) => n + node.statuses[status as keyof typeof node.statuses], 0)])), { pending: 1, streaming: 1, running: 1, completed: 2, error: 1, unknown: 1 });
    assert.match(tree.warnings.join(' '), /creation timestamp/); assert.doesNotMatch(JSON.stringify(tree), /PRIVATE/);
    assert.equal(delegationResult(filename, { ...range, from: to, to: to + 10000 }).totalAttempts, 1);
  });
});

test('delegation ancestry collapses only identical proven paths; switched agents, missing links and resumed ambiguity stay explicit', async () => {
  await fixture((db, filename) => {
    session(db, 'root', from - 20000); session(db, 'child', from - 10000, 'root'); session(db, 'unlinked', from - 10000, 'root');
    message(db, 'launch', 'root', from - 5000, 'plan', 'assistant', 'legacy');
    taskPart(db, 'launch-1', 'launch', 'root', { created: from - 4000, callee: 'research', child: 'child' });
    taskPart(db, 'launch-2', 'launch', 'root', { created: from - 3000, callee: 'research', child: 'child', resume: 'child' });
    message(db, 'nested', 'child', from + 1000, 'research', 'assistant', 'legacy');
    taskPart(db, 'nested-call', 'nested', 'child', { callee: 'worker' });
    const tree = delegationResult(filename);
    assert.equal(tree.totalAttempts, 1);
    assert.deepEqual(tree.nodes.map(n => [n.agent, n.attempts, n.contextOnly, n.ancestry]), [['plan', 0, true, 'verified'], ['research', 0, true, 'verified'], ['worker', 1, false, 'verified']]);
    // Root agent changes before resuming the SAME child. Never guess that the
    // latest inbound call is the causal parent of the nested assistant step.
    message(db, 'resume-build', 'root', from - 2000, 'build', 'assistant', 'legacy');
    taskPart(db, 'launch-3', 'resume-build', 'root', { created: from - 1000, callee: 'research', child: 'child', resume: 'child' });
    message(db, 'switched', 'child', from + 1000, 'different-child-agent', 'assistant', 'legacy');
    taskPart(db, 'switched-call', 'switched', 'child', { callee: 'worker' });
    message(db, 'missing', 'unlinked', from + 1000, 'research', 'assistant', 'legacy');
    taskPart(db, 'missing-link', 'missing', 'unlinked', { resume: 'child' });
    const ambiguous = delegationResult(filename);
    assert.equal(ambiguous.totalAttempts, 3);
    assert.ok(ambiguous.nodes.some(n => n.ancestry === 'ambiguous' && n.attempts > 0));
    assert.ok(ambiguous.nodes.some(n => n.ancestry === 'unknown' && n.attempts > 0));
    assert.ok(!ambiguous.nodes.some(n => n.role === 'main'));
  });
});

test('delegation cycles and candidate/depth/node bounds preserve every incoming period count', async () => {
  await fixture((db, filename) => {
    session(db, 'a', from - 10000, 'b'); session(db, 'b', from - 10000, 'a');
    message(db, 'a-msg', 'a', from - 5000, 'alpha', 'assistant', 'legacy');
    message(db, 'b-msg', 'b', from - 5000, 'beta', 'assistant', 'legacy');
    taskPart(db, 'ab', 'a-msg', 'a', { created: from - 3000, callee: 'beta', child: 'b' });
    taskPart(db, 'ba', 'b-msg', 'b', { created: from - 3000, callee: 'alpha', child: 'a' });
    taskPart(db, 'cycle', 'a-msg', 'a', { callee: 'worker' });
    const cycle = delegationResult(filename);
    assert.equal(cycle.totalAttempts, 1); assert.ok(cycle.nodes.some(n => n.ancestry === 'cycle' && n.attempts === 1));
    session(db, 'root', from - 20000); session(db, 'busy-child', from - 10000, 'root');
    message(db, 'root-msg', 'root', from - 5000, 'build', 'assistant', 'legacy');
    for (let i = 0; i < 65; i++) taskPart(db, `resume-${i}`, 'root-msg', 'root', { created: from - 1000, callee: 'research', child: 'busy-child' });
    message(db, 'busy', 'busy-child', from + 1000, 'research', 'assistant', 'legacy');
    taskPart(db, 'limited', 'busy', 'busy-child');
    // Enough distinct agent paths to exercise the render-node cap as well.
    for (let i = 0; i < 2010; i++) taskPart(db, `wide-${i}`, 'root-msg', 'root', { created: from + 3000 + i, callee: `worker-${i}` });
    for (let i = 0; i < 100; i++) taskPart(db, `repeat-${i}`, 'root-msg', 'root', { created: from + 6000 + i, callee: 'worker-0', status: 'error' });
    const limited = delegationResult(filename);
    assert.equal(limited.totalAttempts, 2112); assert.equal(limited.nodes.length, 2000);
    const worker = limited.nodes.find(n => n.agent === 'worker-0')!;
    assert.equal(worker.attempts, 101); assert.equal(worker.statuses.completed, 1); assert.equal(worker.statuses.error, 100);
    const build = limited.nodes.find(n => n.role === 'main' && n.agent === 'build')!;
    assert.equal(build.attempts, 2110); assert.equal(build.statuses.completed, 2010); assert.equal(build.statuses.error, 100);
    assert.equal(limited.nodes.filter(n => n.ancestry === 'limited' && n.countBasis === 'incoming').reduce((n, node) => n + node.statuses.error, 0), 0);
    assert.ok(limited.nodes.some(n => n.ancestry === 'limited' && n.attempts > 1));
    assert.match(limited.warnings.join(' '), /limited/);
  });
});

test('deep delegation context is bounded even when earlier period calls populate the ancestry cache', async () => {
  await fixture((db, filename) => {
    for (let i = 0; i < 36; i++) {
      session(db, `depth-${i}`, from - 10000, i === 0 ? null : `depth-${i - 1}`);
      message(db, `depth-msg-${i}`, `depth-${i}`, from - 5000, `agent-${i}`, 'assistant', 'legacy');
      if (i < 35) taskPart(db, `depth-call-${i}`, `depth-msg-${i}`, `depth-${i}`, { created: from - 1000, callee: `agent-${i + 1}`, child: `depth-${i + 1}` });
      // Read shallower period attempts first so verified cache paths exist.
      taskPart(db, `period-${i}`, `depth-msg-${i}`, `depth-${i}`, { created: from + i, callee: 'worker' });
    }
    const tree = delegationResult(filename);
    assert.equal(tree.totalAttempts, 36);
    assert.ok(tree.nodes.some(n => n.ancestry === 'limited' && n.attempts > 0));
    const byID = new Map(tree.nodes.map(n => [n.id, n]));
    for (const node of tree.nodes) {
      let current = node, depth = 1;
      while (current.parentId) { current = byID.get(current.parentId)!; depth++; assert.ok(depth <= 33); }
    }
  });
});

test('unsupported delegation layouts are partial and malformed content does not masquerade as a valid tool array', async () => {
  await fixture((db, filename) => {
    session(db, 'root');
    message(db, 'invalid-content', 'root', from + 1000, 'build', 'assistant', 'v2', { content: { nested: delegationTool('not-an-array', 'worker') } });
    db.exec('DROP TABLE part; CREATE TABLE session_part(message_id TEXT, data TEXT)');
    const result = readUsage(filename, range);
    assert.ok(result.status === 'partial');
    assert.equal(result.delegations.totalAttempts, 0);
    assert.match(result.delegations.warnings.join(' '), /unsupported shape/);
    assert.match(result.delegations.warnings.join(' '), /Legacy delegation tool history is unavailable/);
    assert.match(result.warnings.join(' '), /V2 split skill history has an unsupported schema/);
    assert.match(result.delegations.warnings.join(' '), /V2 split delegation history has an unsupported schema/);
  });
});

test('reconciles formats, excludes fork copies, retains per-step agents and period activity', async () => {
  await fixture((db, filename) => {
    session(db, 'root'); session(db, 'new', from + 500); session(db, 'empty', from + 500);
    session(db, 'child', from - 2000, 'root'); session(db, 'fork', from + 5000, null, 'root');
    message(db, 'old', 'root', from - 1); message(db, 'a', 'root');
    message(db, 'b', 'root', from + 2000, 'removed-agent', 'assistant', 'legacy');
    message(db, 'c', 'child', from + 3000, null, 'assistant', 'v2');
    message(db, 'u', 'new', from + 1000, 'ignored-user-agent', 'user');
    message(db, 'end', 'root', to); message(db, 'copied', 'fork', from + 1000);
    message(db, 'fork-work', 'fork', from + 6000);
    db.prepare('INSERT INTO event VALUES(?,?,?,?,?)').run('child-created', 'child', 'session.created.1', from - 2000, JSON.stringify({ sessionID: 'child', projectID: 'fixture', location: { directory: '/fixture' } }));
    const result = readUsage(filename, range);
    assert.notEqual(result.status, 'unavailable'); if (result.status === 'unavailable') return;
    assert.equal(result.status, 'available');
    assert.deepEqual(result.formats, ['legacy', 'v2']);
    assert.deepEqual(result.summary, { activeSessions: 3, newSessions: 2, subagentSessions: 1, steps: 4, tokens: { input: 40, output: 80, reasoning: 12, cacheRead: 16, cacheWrite: 20, total: 168 } });
    assert.deepEqual(result.agents.map(agent => [agent.name, agent.steps]).sort(), [['Unknown', 1], ['build', 2], ['removed-agent', 1]]);
    assert.equal(result.activity[0].date, '2026-09-30');
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /PRIVATE|supersecret|ignored-user-agent|copied|fork-work/);
  });
});

test('selects newer overlapping records in either direction, using table timestamps', async () => {
  await fixture((db, filename) => {
    session(db, 'root'); message(db, 'v2-newer', 'root'); message(db, 'legacy-newer', 'root');
    db.prepare('UPDATE session_message SET time_updated = ?, data = ? WHERE id = ?').run(from + 5000, JSON.stringify({ agent: 'v2-agent', tokens: { ...tokens, input: 30 } }), 'v2-newer');
    db.prepare('UPDATE message SET time_updated = ?, data = ? WHERE id = ?').run(from + 6000, JSON.stringify({ role: 'assistant', agent: 'legacy-agent', tokens: { ...tokens, input: 40 } }), 'legacy-newer');
    const result = readUsage(filename, range);
    assert.notEqual(result.status, 'unavailable'); if (result.status === 'unavailable') return;
    assert.equal(result.summary.steps, 2); assert.equal(result.summary.tokens.input, 70);
    assert.deepEqual(result.agents.map(agent => agent.name).sort(), ['legacy-agent', 'v2-agent']);
  });
});

test('skill attempts use message-scoped call identity and completion time; V2 activations are separate loads', async () => {
  await fixture((db, filename) => {
    session(db, 'root');
    message(db, 'a', 'root'); message(db, 'b', 'root'); message(db, 'prior', 'root', from - 1, 'build', 'assistant', 'legacy');
    skillPart(db, 'p1', 'a', 'root'); skillPart(db, 'p2', 'b', 'root');
    skillPart(db, 'p3', 'b', 'root', 'error', 'failed');
    // Distinct failed attempt uses another call identity.
    db.prepare("UPDATE part SET data = json_set(data, '$.callID', 'failed-call') WHERE id = 'p3'").run();
    skillPart(db, 'p4', 'b', 'root', 'running', 'pending');
    skillPart(db, 'p5', 'prior', 'root', 'completed', 'continued');
    message(db, 'v2', 'root', from + 3000, 'plan', 'assistant', 'v2', { content: [
      { type: 'tool', id: 'one', name: 'skill', state: { status: 'completed', input: { id: 'skill-id' }, metadata: { name: 'V2 skill' }, output: 'PRIVATE' }, time: { completed: from + 4000 } },
      { type: 'tool', id: 'two', name: 'skill', state: { status: 'error', input: { id: 'missing-id' } }, time: { completed: from + 4000 } },
      { type: 'tool', id: 'three', name: 'skill', state: { status: 'running', input: { id: 'pending-id' } }, time: {} },
    ] });
    message(db, 'activation', 'root', from + 5000, null, 'skill', 'v2', { skill: 'explicit-id', name: 'explicit activation' });
    const result = readUsage(filename, range);
    assert.notEqual(result.status, 'unavailable'); if (result.status === 'unavailable') return;
    assert.deepEqual(result.skills.map(entry => [entry.name, entry.loads, entry.failedLoads, entry.sessions]).sort(), [
      ['V2 skill', 1, 0, 1], ['continued', 1, 0, 1], ['explicit activation', 1, 0, 1], ['failed', 0, 1, 1], ['missing-id', 0, 1, 1], ['research', 2, 0, 1],
    ]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|pending/);
  });
});

test('indexed legacy skills retain old parents, first duplicate attempts and exact session identity', async () => {
  await fixture((db, filename) => {
    // Match upstream index shapes, without relying on their names. In particular,
    // a session lookup must not change first-wins deduplication to part-ID order.
    db.exec(`
      CREATE INDEX fixture_messages ON message(session_id, time_created, id);
      CREATE INDEX fixture_parts ON part(message_id, id);
      CREATE INDEX fixture_session_parts ON part(session_id);
    `);
    session(db, 'root', from - 10_000); session(db, 'other', from - 10_000);
    session(db, 'fork', from + 5000, null, 'root');
    message(db, 'old-parent', 'root', from - 5000, 'build', 'assistant', 'legacy');
    skillPart(db, 'z-first', 'old-parent', 'root', 'completed', 'continued', from);
    // The part started before the range, and its parent was never updated in it.
    db.prepare('UPDATE part SET time_created = ? WHERE id = ?').run(from - 4000, 'z-first');
    skillPart(db, 'a-duplicate', 'old-parent', 'root', 'error', 'must-not-replace-first');
    skillPart(db, 'wrong-session', 'old-parent', 'other', 'completed', 'wrong-session');
    skillPart(db, 'outside', 'old-parent', 'root', 'completed', 'exclusive-end', to);
    message(db, 'pending-parent', 'root', from - 5000, 'build', 'assistant', 'legacy');
    // A nonterminal first record still owns this call identity. Filtering it out
    // in SQL would incorrectly count its later duplicate as a completed load.
    skillPart(db, 'pending-a-first', 'pending-parent', 'root', 'running', 'pending');
    skillPart(db, 'pending-z-duplicate', 'pending-parent', 'root', 'completed', 'must-stay-pending');
    message(db, 'future-parent', 'root', to, 'build', 'assistant', 'legacy');
    skillPart(db, 'future-part', 'future-parent', 'root', 'completed', 'future-parent');
    message(db, 'copied-parent', 'fork', from + 1000, 'build', 'assistant', 'legacy');
    skillPart(db, 'copied-part', 'copied-parent', 'fork', 'completed', 'fork-copy');
    // The same message ID in a different format/session is not an overlap.
    message(db, 'old-parent', 'other', from - 5000, 'build', 'assistant', 'v2');
    db.prepare('UPDATE session_message SET time_updated = ? WHERE id = ?').run(from + 5000, 'old-parent');
    const result = readUsage(filename, range);
    assert.notEqual(result.status, 'unavailable'); if (result.status === 'unavailable') return;
    assert.equal(result.summary.steps, 0);
    assert.deepEqual(result.skills, [{ name: 'continued', loads: 1, failedLoads: 0, sessions: 1 }]);
    assert.deepEqual(result.warnings, ['Duplicate legacy skill records were excluded.']);
    // The supported column contract does not require rowid storage. Its table
    // scan visits the primary key first, so that duplicate wins instead.
    db.exec(`
      ALTER TABLE part RENAME TO old_part;
      CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT) WITHOUT ROWID;
      INSERT INTO part SELECT * FROM old_part;
      DROP TABLE old_part;
    `);
    const withoutRowid = readUsage(filename, range);
    assert.notEqual(withoutRowid.status, 'unavailable'); if (withoutRowid.status === 'unavailable') return;
    assert.deepEqual(withoutRowid.skills, [{ name: 'must-not-replace-first', loads: 0, failedLoads: 1, sessions: 1 }]);
  });
});

test('V2 skill candidates reconcile before content expansion while retaining cross-range completions', async () => {
  await fixture((db, filename) => {
    db.exec(`
      CREATE INDEX fixture_v2_time ON session_message(session_id, time_created, id);
      CREATE INDEX fixture_v2_type ON session_message(session_id, type, id);
    `);
    session(db, 'root', from - 10_000); session(db, 'fork', from + 5000, null, 'root');
    const content = (id: string, completed: number) => [{ type: 'tool', id, name: 'skill', state: { status: 'completed', input: { id } }, time: { completed } }];
    message(db, 'continued', 'root', from - 5000, 'build', 'assistant', 'v2', { content: content('continued', from) });
    // V1 migration preserves the message's table update time independently of
    // the part's completion. An inline skill can cross `from` with an old owner.
    message(db, 'tie', 'root', from - 5000, 'build', 'assistant', 'both', { content: content('tie-must-lose', from) });
    db.prepare('UPDATE message SET time_updated = ? WHERE id = ?').run(from + 1000, 'tie');
    db.prepare('UPDATE session_message SET time_updated = ? WHERE id = ?').run(from + 1000, 'tie');
    message(db, 'copied', 'fork', from + 1000, 'build', 'assistant', 'v2', { content: content('copied', from + 6000) });
    message(db, 'future', 'root', to, 'build', 'assistant', 'v2', { content: content('future', from + 6000) });
    const result = readUsage(filename, range);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.skills, [{ name: 'continued', loads: 1, failedLoads: 0, sessions: 1 }]);
    assert.equal(result.summary.steps, 0);
    assert.match(result.warnings.join(' '), /native creation lifecycle/);
  });
});

test('split and inline tools compose by owner and ordinal, then count skill completion or delegation creation', async () => {
  await fixture(async (db, filename) => {
    db.exec(`CREATE TABLE session_part(message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, call_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT, PRIMARY KEY(message_id,ordinal));`);
    session(db, 'root', from - 10000); session(db, 'other'); session(db, 'fork', from + 500, null, 'root');
    const skill = (id: string, name: string, completed: number, status = 'completed') => ({
      type: 'tool', id, name: 'skill', state: { status, input: { id: name }, output: 'PRIVATE SKILL OUTPUT' }, time: { completed },
    });
    const insert = db.prepare('INSERT INTO session_part VALUES(?,?,?,?,?,?,?,?)');
    const part = (message: string, ordinal: number, tool: ReturnType<typeof skill | typeof delegationTool>, owner = 'root') =>
      insert.run(message, owner, ordinal, 'tool', String(tool.id), from - 2, to + 100, JSON.stringify(tool));

    // Only the part changed. An envelope time_updated lower bound loses the
    // completion at `from`; using the part table timestamps loses its period.
    message(db, 'split', 'root', from - 5000, 'build', 'assistant', 'v2', { content: [] });
    part('split', 0, skill('same', 'split', from));
    part('split', 1, skill('later', 'late-failure', to, 'error'));
    part('split', 2, delegationTool('call', 'split-delegate', from));
    part('split', 3, delegationTool('before', 'previous-delegate', from - 1));

    message(db, 'mixed', 'root', from + 1, 'plan', 'assistant', 'both', { content: [
      delegationTool('call', 'inline-duplicate'), delegationTool('unique', 'inline-delegate', to),
      skill('same', 'inline-duplicate', from + 4), skill('extra', 'inline', from + 4),
      delegationTool('same', 'PRIVATE CROSS-KIND DELEGATE'), skill('call', 'PRIVATE CROSS-KIND SKILL', from + 4),
      skill('other-tool', 'PRIVATE BLOCKED SKILL', from + 4),
    ] });
    db.prepare("UPDATE session_message SET time_updated=? WHERE id='mixed'").run(to + 1);
    skillPart(db, 'superseded', 'mixed', 'root');
    taskPart(db, 'superseded-task', 'mixed', 'root');
    part('mixed', 9, skill('same', 'higher-ordinal', from + 4));
    part('mixed', 8, delegationTool('call', 'higher-ordinal', from + 3));
    part('mixed', 1, skill('same', 'split', from + 3, 'error'));
    part('mixed', 0, delegationTool('call', 'first-delegate', from + 2));
    part('mixed', 2, skill('wrong', 'wrong-session', from + 2), 'other');
    part('mixed', 3, { ...delegationTool('other-tool', 'PRIVATE UNTRACKED LABEL'), name: 'PRIVATE UNTRACKED TOOL' });
    message(db, 'tie', 'root', from + 1, 'plan', 'assistant', 'both');
    message(db, 'copied', 'fork', from + 1, 'plan', 'assistant', 'v2');
    message(db, 'user', 'root', from + 1, null, 'user', 'v2');
    for (const [message, owner] of [['tie', 'root'], ['copied', 'fork'], ['user', 'root']]) {
      part(message, 0, skill('ignored', 'excluded', from + 1000), owner);
      part(message, 1, delegationTool('ignored', 'excluded', from + 1000), owner);
    }

    const current = readUsage(filename, range);
    assert.ok(current.status !== 'unavailable');
    assert.equal(current.summary.steps, 2); assert.equal(current.summary.tokens.total, 84);
    assert.deepEqual(current.skills, [
      { name: 'inline', loads: 1, failedLoads: 0, sessions: 1 },
      { name: 'split', loads: 1, failedLoads: 1, sessions: 1 },
    ]);
    const incoming = (result: typeof current) => result.delegations.nodes.filter(n => n.countBasis === 'incoming').map(n => [n.agent, n.statuses.completed]).sort();
    assert.equal(current.delegations.totalAttempts, 2);
    assert.deepEqual(incoming(current), [['first-delegate', 1], ['split-delegate', 1]]);
    assert.match(current.warnings.join(' '), /Duplicate V2 skill/);
    assert.match(current.delegations.warnings.join(' '), /Duplicate delegation/);
    const next = readUsage(filename, { ...range, from: to, to: to + 1000 });
    assert.ok(next.status !== 'unavailable');
    assert.deepEqual(next.skills, [{ name: 'late-failure', loads: 0, failedLoads: 1, sessions: 1 }]);
    assert.equal(next.summary.steps, 0); assert.equal(next.delegations.totalAttempts, 1);
    assert.deepEqual(incoming(next), [['inline-delegate', 1]]);

    const target = new DatabaseSync(filename + '.projected');
    try {
      projectUsageMetadata(db, target);
      const plan = target.prepare('EXPLAIN QUERY PLAN ' + v2SkillRangeSQL).all(from, to);
      assert.match(JSON.stringify(plan), /SEARCH inspector_v2_skill USING INDEX inspector_v2_skill_completed \(completed>\? AND completed<\?\)/);
      assert.doesNotMatch(JSON.stringify(plan), /SCAN |TEMP B-TREE/);
      assert.equal(target.prepare('SELECT count(*) n FROM inspector_v2_skill').get()!.n, 4, 'one terminal row per winning skill, no duplicate call metadata');
    } finally { target.close(); }
    assert.doesNotMatch((await readFile(filename + '.projected')).toString(), /PRIVATE/);
  });
});

test('delivered V2 user messages count each attached skill ID once, not prompt text or enqueued requests', async () => {
  await fixture(async (db, filename) => {
    session(db, 'root'); session(db, 'child', from - 1000, 'root'); session(db, 'fork', from + 500, null, 'root');
    const attachment = { id: 'PRIVATE ATTACHMENT ID', name: 'research', text: 'PRIVATE PREPARED SKILL', mention: { value: 'PRIVATE MENTION' } };
    const extra = { text: 'PRIVATE PROMPT @unattached', skills: [attachment, { ...attachment, name: 'LOSING DUPLICATE LABEL' }, { ...attachment, id: 'second-id' }] };
    message(db, 'delivered', 'root', from, null, 'user', 'both', extra);
    db.prepare("UPDATE session_message SET time_updated=? WHERE id='delivered'").run(from + 1);
    message(db, 'other-owner', 'child', from + 2, null, 'user', 'v2', { skills: [attachment] });
    const losing = { skills: [{ ...attachment, name: 'LOSING OWNER LABEL' }] };
    message(db, 'superseded', 'root', from, null, 'user', 'both', losing);
    message(db, 'fork-copy', 'fork', from, null, 'user', 'v2', losing);
    message(db, 'future', 'root', to, null, 'user', 'v2', extra);
    message(db, 'not-user', 'root', from + 2, 'plan', 'assistant', 'v2', extra);
    db.prepare('INSERT INTO event VALUES(?,?,?,?,?)').run('queued', 'root', 'session.inbox.enqueued.1', from, JSON.stringify({ item: { type: 'user', payload: extra } }));
    const result = readUsage(filename, range);
    assert.ok(result.status !== 'unavailable');
    assert.deepEqual(result.skills, [{ name: 'research', loads: 3, failedLoads: 0, sessions: 2 }]);
    const target = new DatabaseSync(filename + '.projected');
    try { projectUsageMetadata(db, target); } finally { target.close(); }
    assert.doesNotMatch((await readFile(filename + '.projected')).toString(), /PRIVATE|LOSING (DUPLICATE|OWNER) LABEL/);
  });
});

test('generate-only durable usage counts at event creation under Unknown with no session activity or assistant steps', async () => {
  await fixture((db, filename) => {
    session(db, 'root');
    const insert = db.prepare('INSERT INTO event VALUES(?,?,?,?,?)');
    insert.run('created', 'root', 'session.created.1', from - 1000, JSON.stringify({ sessionID: 'root', location: {} }));
    for (const created of [from - 1, from, to]) insert.run(String(created), 'root', 'session.usage.recorded.1', created,
      JSON.stringify({ source: 'generate', tokens, agent: 'unverified', model: { providerID: 'unverified', id: 'unverified' } }));
    const result = readUsage(filename, { ...range, timezone: 'UTC' });
    assert.equal(result.status, 'available');
    const recorded = { input: 10, output: 20, reasoning: 3, cacheRead: 4, cacheWrite: 5, total: 42 };
    assert.deepEqual(result.summary, { activeSessions: 0, newSessions: 0, subagentSessions: 0, steps: 0, tokens: recorded });
    assert.deepEqual(result.topSessionsByTokens, [
      { id: usageKey('root'), title: null, project: null, steps: 0, tokens: 42 },
    ]);
    assert.deepEqual(result.activity, [{ date: '2026-10-01', ...result.summary }]);
    assert.deepEqual(result.agents, [{ name: 'Unknown', sessions: 1, steps: 0, tokens: recorded }]);
    assert.deepEqual(result.models, [{ provider: null, model: null, sessions: 1, steps: 0, tokens: recorded }]);
  });
});

test('legacy compaction assistants and V2 durable compaction usage count once', async () => {
  await fixture((db, filename) => {
    session(db, 'root'); message(db, 'legacy-summary', 'root', from + 1000, 'compaction', 'assistant', 'legacy');
    message(db, 'native', 'root', from + 2000, null, 'compaction', 'v2', { status: 'completed', tokens });
    db.prepare('INSERT INTO event VALUES(?,?,?,?,?)').run('usage', 'root', 'session.usage.recorded.1', from + 3000, JSON.stringify({ source: 'compaction', tokens, text: 'PRIVATE' }));
    const result = readUsage(filename, range);
    assert.notEqual(result.status, 'unavailable'); if (result.status === 'unavailable') return;
    assert.equal(result.status, 'partial'); // No stable projection-to-usage ID exists.
    assert.equal(result.summary.steps, 1); assert.equal(result.summary.tokens.total, 84);
    assert.equal(result.agents.find(agent => agent.name === 'Unknown')?.tokens.total, 42);
  });
  await fixture((db, filename) => {
    session(db, 'root');
    message(db, 'imported-compaction', 'root', from + 1000, null, 'compaction', 'v2', { status: 'completed', tokens });
    db.prepare('INSERT INTO event VALUES(?,?,?,?,?)').run('unrelated', 'root', 'session.usage.recorded.1', to + 1000, JSON.stringify({ source: 'compaction', tokens }));
    const result = readUsage(filename, { from, to: from + 86_400_000, timezone: 'UTC' });
    assert.equal(result.status, 'partial');
    assert.equal(result.summary.tokens.total, 0);
    assert.match(result.warnings.join(' '), /compaction/i);
    // Even an identical tuple in the requested period does not prove which
    // projection it belongs to. Count the durable record once and retain doubt.
    db.prepare('UPDATE event SET created = ? WHERE id = ?').run(from + 2000, 'unrelated');
    const sameDay = readUsage(filename, range);
    assert.equal(sameDay.status, 'partial');
    assert.equal(sameDay.summary.tokens.total, 42);
  });
});

test('V2-only history retains tool and explicit loads, fork filtering, and reports migration loss', async () => {
  await fixture((db, filename) => {
    session(db, 'root'); session(db, 'fork', from + 5000, null, 'root');
    message(db, 'copied', 'fork', from + 1000, 'build', 'assistant', 'v2');
    message(db, 'work', 'fork', from + 6000, 'historical-agent', 'assistant', 'v2', { content: [
      { type: 'tool', id: 'call', name: 'skill', state: { status: 'completed', input: { id: 'native-id' } }, time: { completed: from + 7000 } },
    ] });
    message(db, 'activation', 'root', from + 3000, null, 'skill', 'v2', { skill: 'explicit-id', name: 'explicit' });
    message(db, 'lost-summary', 'root', from + 4000, null, 'compaction', 'v2', { status: 'completed', tokens: undefined });
    db.exec('DROP TABLE part; DROP TABLE message; DROP TABLE session');
    const result = readUsage(filename, range);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.formats, ['v2']); assert.equal(result.summary.steps, 1);
    assert.equal(result.summary.tokens.total, 42);
    assert.match(result.warnings.join(' '), /migrated compactions/);
    assert.deepEqual(result.skills.map(entry => entry.name).sort(), ['explicit', 'native-id']);
    db.prepare('DELETE FROM session_message WHERE id = ?').run('lost-summary');
    db.prepare('INSERT INTO event VALUES(?,?,?,?,?)').run('later-title', 'fork', 'session.usage.recorded.1', to + 1000, JSON.stringify({ source: 'title', tokens }));
    const imported = readUsage(filename, range);
    assert.equal(imported.status, 'partial');
    assert.equal(imported.summary.tokens.total, 42);
    assert.match(imported.warnings.join(' '), /title/i);
    db.prepare('INSERT INTO event VALUES(?,?,?,?,?)').run('root-created', 'root', 'session.created.1', from - 1000, JSON.stringify({ sessionID: 'root', projectID: 'fixture', location: { directory: '/fixture' } }));
    db.prepare('INSERT INTO event VALUES(?,?,?,?,?)').run('fork-created', 'fork', 'session.forked.2', from + 5000, JSON.stringify({ sessionID: 'fork', parentID: 'root', boundary: { type: 'after', messageID: 'base' } }));
    const native = readUsage(filename, range);
    assert.equal(native.status, 'available');
    assert.equal(native.summary.tokens.total, 42);
  });
  await fixture((db, filename) => {
    session(db, 'imported', from - 2000);
    message(db, 'old-assistant', 'imported', from - 1000, 'build', 'assistant', 'v2');
    db.prepare('INSERT INTO event VALUES(?,?,?,?,?)').run('title-only', 'imported', 'session.usage.recorded.1', from + 1000, JSON.stringify({ source: 'title', tokens }));
    const eventOnly = readUsage(filename, range);
    assert.equal(eventOnly.status, 'partial');
    assert.equal(eventOnly.summary.steps, 0); assert.equal(eventOnly.summary.tokens.total, 42);
    assert.match(eventOnly.warnings.join(' '), /native creation lifecycle/);
    db.prepare('DELETE FROM event WHERE id = ?').run('title-only');
    for (const status of ['completed', 'error', 'running', 'outside']) {
      db.prepare('UPDATE session_message SET time_updated = ?, data = ? WHERE id = ?').run(from + 2000, JSON.stringify({ content: [
        { type: 'tool', id: 'load', name: 'skill', state: { status: status === 'outside' ? 'completed' : status, input: { id: 'continued-skill' } }, time: { completed: status === 'outside' ? to : from + 1000 } },
      ] }), 'old-assistant');
      const skillOnly = readUsage(filename, range);
      const contributes = status === 'completed' || status === 'error';
      assert.equal(skillOnly.status, contributes ? 'partial' : 'available', status);
      assert.equal(skillOnly.summary.steps, 0); assert.equal(skillOnly.summary.tokens.total, 0);
      assert.equal(skillOnly.skills.length, contributes ? 1 : 0, status);
      if (contributes) {
        assert.equal(skillOnly.skills[0].loads, status === 'completed' ? 1 : 0);
        assert.equal(skillOnly.skills[0].failedLoads, status === 'error' ? 1 : 0);
        assert.match(skillOnly.warnings.join(' '), /native creation lifecycle/);
      }
    }
  });
});

test('continued sessions and half-open boundaries assign usage to each period and creation to its day', async () => {
  await fixture((db, filename) => {
    session(db, 'root', from + 1000); session(db, 'child', from - 1000, 'root');
    message(db, 'first', 'root', from + 86_400_000, 'build', 'assistant', 'legacy');
    message(db, 'boundary', 'root', to, 'plan', 'assistant', 'legacy');
    message(db, 'child-resumed', 'child', to, 'research', 'assistant', 'legacy');
    const first = readUsage(filename, { from, to, timezone: 'UTC' });
    const second = readUsage(filename, { from: to, to: to + 86_400_000, timezone: 'UTC' });
    assert.notEqual(first.status, 'unavailable'); assert.notEqual(second.status, 'unavailable');
    if (first.status === 'unavailable' || second.status === 'unavailable') return;
    assert.equal(first.summary.steps, 1); assert.equal(second.summary.steps, 2);
    assert.equal(first.summary.newSessions, 1); assert.equal(second.summary.newSessions, 0);
    assert.equal(second.summary.subagentSessions, 1);
    assert.equal(first.activity[0].date, '2026-10-01'); assert.equal(first.activity[0].newSessions, 1); assert.equal(first.activity[0].steps, 0);
    assert.equal(first.activity[1].date, '2026-10-02'); assert.equal(first.activity[1].steps, 1);
    session(db, 'empty', from + 2000);
    session(db, 'copied-only', from + 3000, null, 'root');
    message(db, 'copied-before-creation', 'copied-only', from + 1000);
    for (const format of ['both', 'legacy', 'v2']) {
      if (format === 'legacy') db.exec('DELETE FROM session_message');
      if (format === 'v2') {
        db.exec('DELETE FROM message');
        message(db, 'first-v2', 'root', from + 86_400_000, 'build', 'assistant', 'v2');
        message(db, 'copied-v2', 'copied-only', from + 1000, 'build', 'assistant', 'v2');
      }
      const createdDay = readUsage(filename, { from, to: from + 86_400_000, timezone: 'UTC' });
      const workDay = readUsage(filename, { from: from + 86_400_000, to: from + 2 * 86_400_000, timezone: 'UTC' });
      assert.notEqual(createdDay.status, 'unavailable'); assert.notEqual(workDay.status, 'unavailable');
      if (createdDay.status === 'unavailable' || workDay.status === 'unavailable') return;
      assert.equal(createdDay.summary.newSessions, 1, format);
      assert.equal(createdDay.summary.activeSessions, 0, format);
      assert.equal(createdDay.activity[0].date, '2026-10-01', format);
      assert.equal(createdDay.activity[0].newSessions, 1, format);
      assert.equal(workDay.summary.newSessions, 0, format);
      assert.equal(workDay.summary.activeSessions, 1, format);
    }
  });
});

test('live WAL remains readable without changing journaling; malformed records stay sanitized', async () => {
  await fixture(async (db, filename) => {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    session(db, 'root'); message(db, 'live', 'root', from + 1000, 'build', 'assistant', 'legacy');
    db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run('malformed', 'root', from + 2000, from + 2000, '{PRIVATE PROMPT /secret/path');
    message(db, 'without-source', 'root', from + 3000, null, 'compaction', 'v2', { status: 'completed', tokens });
    const walBefore = await stat(filename + '-wal');
    const result = readUsage(filename, range);
    assert.equal(result.status, 'partial');
    assert.equal(result.summary.steps, 1); assert.equal(result.summary.tokens.total, 42);
    assert.match(result.warnings.join(' '), /Malformed/); assert.match(result.warnings.join(' '), /Compaction projection-to-event correspondence/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret\/path|without-source/);
    assert.equal((await stat(filename + '-wal')).mtimeMs, walBefore.mtimeMs);
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  });
});

test('unavailable and partial do not silently invent missing counters; reader does not write the fixture', async () => {
  await fixture(async (db, filename) => {
    session(db, 'root'); message(db, 'missing', 'root', from + 1000, null, 'assistant', 'legacy', { tokens: undefined });
    const before = await stat(filename);
    const result = readUsage(filename, range);
    assert.equal(result.status, 'partial');
    assert.match(result.warnings.join(' '), /missing or invalid token/);
    assert.equal((await stat(filename)).mtimeMs, before.mtimeMs);
    assert.equal(readUsage(path.join(path.dirname(filename), 'missing.db'), range).status, 'unavailable');
    await assert.rejects(stat(path.join(path.dirname(filename), 'missing.db')));
    const previous = process.env.OPENCODE_INSPECTOR_DB;
    try {
      delete process.env.OPENCODE_INSPECTOR_DB;
      assert.equal(await resolveUsageDatabase(path.dirname(filename)), undefined);
      process.env.OPENCODE_INSPECTOR_DB = filename;
      assert.equal(await resolveUsageDatabase(path.dirname(filename)), filename);
    } finally { if (previous === undefined) delete process.env.OPENCODE_INSPECTOR_DB; else process.env.OPENCODE_INSPECTOR_DB = previous; }
  });
});

test('range validation and HTTP privacy guards reject invalid and path-selecting requests', async () => {
  for (const query of [
    {}, { from: '', to: String(to), timezone: 'UTC' }, { from: 'NaN', to: String(to), timezone: 'UTC' },
    { from: String(from), to: String(from), timezone: 'UTC' }, { from: '1e20', to: '1e21', timezone: 'UTC' },
    { from: String(from), to: String(from + 33 * 86_400_000), timezone: 'UTC' },
    { from: String(from), to: String(to), timezone: 'Invalid/Zone' }, { from: String(from), to: String(to), timezone: '+01:00' },
    { from: [String(from)], to: String(to), timezone: 'UTC' },
  ]) assert.equal(parseUsageRange(query), undefined);
  assert.deepEqual(parseUsageRange({ from: String(from), to: String(to), timezone: range.timezone }), range);
  assert.equal(parseUsageRange({ from: String(from), to: String(to), timezone: range.timezone, granularity: 'hour' }), undefined);
  assert.equal(parseUsageRange({ from: String(from), to: String(to), timezone: range.timezone, granularity: 'minute' }), undefined);
  for (const [granularity, limit] of [
    ['hour', 26 * 3_600_000], ['day', 32 * 86_400_000], ['week', 100 * 86_400_000], ['month', Date.UTC(2070, 0, 1)],
  ] as const) {
    assert.deepEqual(parseUsageRange({ from: '0', to: String(limit), timezone: 'UTC', granularity }),
      { from: 0, to: limit, timezone: 'UTC', granularity });
    assert.equal(parseUsageRange({ from: '0', to: String(limit + 1), timezone: 'UTC', granularity }), undefined);
  }
  await fixture(async (db, filename) => {
    for (const id of ['first', 'second', 'excluded']) {
      session(db, id);
      message(db, `${id}-step`, id);
    }
    db.exec(`CREATE TABLE project(id TEXT PRIMARY KEY, name TEXT);
      INSERT INTO project VALUES ('first-project', 'First'), ('second-project', 'Second');
      ALTER TABLE session ADD COLUMN project_id TEXT;
      UPDATE session SET project_id=id || '-project' WHERE id IN ('first', 'second');`);
    const app = createApp({ root: path.resolve('examples/demo'), usageDatabase: filename, usageCacheDirectory: path.join(path.dirname(filename), 'cache') });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const get = (url: string, headers = {}, method = 'GET') => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: (server.address() as { port: number }).port, path: url, method, headers: { host: '127.0.0.1:4317', ...headers } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode!, body }));
      }); req.on('error', reject); req.end();
    });
    try {
      const url = `/API/usage?from=${from}&to=${to}&timezone=UTC`;
      const baseRange = { from, to, timezone: 'UTC' };
      const [first, second] = [usageKey('first-project'), usageKey('second-project')].sort();
      const unionSuffix = `&project=${second}&project=${first}`;
      const unionRange = { ...baseRange, projects: [first, second] };
      const starting = await get(url + unionSuffix);
      assert.equal(starting.status, 200);
      assert.equal(JSON.parse(starting.body).index.state, 'indexing');
      assert.deepEqual(JSON.parse(starting.body).range, unionRange);
      assert.equal((await get(url + '&db=/etc/passwd')).status, 400);
      for (const suffix of ['&refresh=0', '&refresh=true', '&refresh=1&refresh=1', '&refresh[]=1']) assert.equal((await get(url + suffix)).status, 400);
      for (const project of ['', '%2Fetc%2Fpasswd', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '%0A']) {
        assert.equal((await get(url + '&project=' + project)).status, 400);
        assert.equal((await get(url + '&project=unattributed&project=' + project)).status, 400);
      }
      for (const suffix of ['&project[]=unattributed', '&projects=unattributed', '&project=unattributed'.repeat(51),
        '&project=unattributed'.repeat(50) + '&'.repeat(1000) + 'project=unattributed']) {
        assert.equal((await get(url + suffix)).status, 400);
      }
      assert.equal((await get('/api/usage?from=invalid')).status, 400);
      assert.equal((await get(url, { origin: 'http://evil.test' })).status, 403);
      assert.equal((await get(url, { host: 'evil.test' })).status, 403);
      assert.equal((await get(url, { 'sec-fetch-site': 'cross-site' })).status, 403);
      for (const method of ['POST', 'HEAD']) assert.equal((await get(url, {}, method)).status, 405);
      const settled = async (suffix = '') => {
        for (let i = 0; i < 400; i++) {
          const response = await get(url + suffix), dto = JSON.parse(response.body);
          if (!['indexing', 'refreshing'].includes(dto.index.state)) return response;
          await delay(20);
        }
        throw new Error('Index did not settle');
      };
      const unscoped = JSON.parse((await settled()).body);
      assert.equal(unscoped.index.state, 'ready');
      assert.equal(unscoped.summary.steps, 3);
      assert.deepEqual(unscoped.topSessionsByTokens, unscoped.topSessions);
      assert.deepEqual(unscoped.topSessions.map((row: { tokens: number }) => row.tokens), [42, 42, 42]);
      assert.deepEqual(unscoped.projects.map((project: { name: string }) => project.name), ['First', 'Second', 'Unattributed']);
      const all = await get(`/api/usage?from=0&to=${to}&timezone=UTC&granularity=month`);
      assert.equal(all.status, 200);
      const parsedAll = JSON.parse(all.body);
      assert.deepEqual(parsedAll.range, { from: 0, to, timezone: 'UTC', granularity: 'month' });
      assert.equal(parsedAll.index.state, 'ready', 'changing granularity does not rebuild the index');
      for (const project of ['unattributed', first]) {
        const scoped = await get(url + '&project=' + project);
        assert.equal(scoped.status, 200);
        assert.deepEqual(JSON.parse(scoped.body).range, { ...baseRange, project });
      }
      const repeated = await get(url + '&project=unattributed'.repeat(50));
      assert.equal(repeated.status, 200);
      assert.deepEqual(JSON.parse(repeated.body).range, { ...baseRange, project: 'unattributed' });
      const union = await get(url + unionSuffix);
      assert.equal(union.status, 200);
      const selected = JSON.parse(union.body);
      assert.deepEqual(selected.range, unionRange);
      assert.equal(selected.index.state, 'ready', 'changing project scope does not rebuild the index');
      assert.equal(selected.index.indexedAt, unscoped.index.indexedAt);
      assert.equal(selected.summary.steps, 2);
      assert.equal(selected.summary.tokens.total, 84);
      assert.deepEqual(selected.projects, unscoped.projects);
      assert.deepEqual(await get(url + `&project=${first}&project=${second}&project=${first}`), union);
      db.exec('DROP TABLE session; DROP TABLE session_v2');
      assert.equal(JSON.parse((await get(url)).body).index.sourceChanged, true);
      await get(url + unionSuffix + '&refresh=1');
      const response = await settled(unionSuffix);
      const retained = JSON.parse(response.body);
      assert.equal(retained.status, 'partial');
      assert.equal(retained.index.state, 'failed');
      assert.equal(retained.index.indexedAt, selected.index.indexedAt);
      assert.deepEqual(retained.range, unionRange);
      assert.deepEqual(retained.summary, selected.summary);
      assert.deepEqual(retained.projects, unscoped.projects);
      assert.doesNotMatch(response.body, /usage\.db|SELECT|sqlite|\/Users\//);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await app.locals.closeUsage();
    }
  });
});
