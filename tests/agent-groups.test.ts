import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupAgents } from '../src/agent-groups';
import type { Entry } from '../src/types';

const entry = (name: string, mode?: unknown): Entry => ({ id: name, name, category: 'Agents', description: '', data: mode === undefined ? {} : { mode }, sources: [], provenance: {} });

test('groups explicit modes, built-in defaults, all, internal and unknown agents', () => {
  const groups = groupAgents([
    entry('build', 'subagent'), entry('plan'), entry('general'), entry('scout'), entry('custom', 'all'),
    entry('compaction'), entry('unknown'), entry('bad', 'invalid'), entry('title', 'primary'),
  ]);
  assert.deepEqual(groups.get('Main agents')?.map(item => item.id), ['plan', 'custom', 'title']);
  assert.deepEqual(groups.get('Subagents')?.map(item => item.id), ['build', 'general', 'scout', 'custom']);
  assert.deepEqual(groups.get('Internal agents')?.map(item => item.id), ['compaction']);
  assert.deepEqual(groups.get('Other agents')?.map(item => item.id), ['unknown', 'bad']);
});

test('built-in defaults use identity rather than display names and do not replace invalid modes', () => {
  const groups = groupAgents([
    { ...entry('plan'), name: 'Planning assistant' },
    { ...entry('custom'), name: 'plan' },
    entry('explore', null),
  ]);
  assert.deepEqual(groups.get('Main agents')?.map(item => item.id), ['plan']);
  assert.deepEqual(groups.get('Other agents')?.map(item => item.id), ['custom', 'explore']);
});
