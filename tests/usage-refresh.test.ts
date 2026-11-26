import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageRequestUrl } from '../src/usage-period.js';
import { usageWarningSummary } from '../src/usage-warnings.js';

test('only an explicit refresh sends the rebuild flag, not polling or period changes', () => {
  const consumed = { current: 0 };
  const params = new URLSearchParams({ from: '100', to: '200', timezone: 'UTC' });
  const request = (intent: number) => new URL(usageRequestUrl(params, intent, consumed), 'http://localhost');
  assert.equal(request(0).searchParams.has('refresh'), false);
  assert.equal(request(1).searchParams.get('refresh'), '1');
  assert.equal(request(1).searchParams.has('refresh'), false);
  params.set('from', '200'); params.set('to', '300');
  const changedPeriod = request(1);
  assert.equal(changedPeriod.searchParams.get('from'), '200');
  assert.equal(changedPeriod.searchParams.has('refresh'), false);
  assert.equal(request(2).searchParams.get('refresh'), '1');
  assert.equal(request(2).searchParams.has('refresh'), false);
  assert.equal(params.has('refresh'), false);
});

test('usage warnings combine token coverage and keep delegation details on the relevant page', () => {
  const delegation = [
    'Some delegation attempts have no retained child-session association; requested resumes are not treated as verified links.',
    'V2 task records may retain migrated creation timestamps or interrupted lifecycle states.',
  ];
  const warnings = [
    'Compaction projection-to-event correspondence is unverified; totals include only retained durable usage events.',
    'Some V2 history lacks its retained native creation lifecycle; imported title, compaction and generate usage coverage is unverified.',
    'Some usage records have missing or invalid token counters; totals include only known counters.',
    ...delegation,
  ];
  const overview = usageWarningSummary(warnings, delegation, 'overview');
  assert.equal(overview.length, 1);
  assert.match(overview[0], /token totals may be incomplete.*background work/i);
  const agents = usageWarningSummary(warnings, delegation, 'agents');
  assert.deepEqual(agents.slice(0, 1), overview);
  assert.equal(agents.length, 3);
  assert.match(agents[1], /links couldn’t be verified/i);
  assert.match(agents[2], /dates or statuses/i);
  assert.deepEqual(usageWarningSummary(warnings, delegation, 'skills'), []);
});

test('session totals and unknown diagnostics use scoped, safe copy', () => {
  const diagnostic = 'Some delegation sessions have invalid identities; ancestry is incomplete.';
  const unknown = 'Internal detail not suitable for display';
  assert.match(usageWarningSummary([diagnostic], [diagnostic], 'overview').join(), /subagent work.*parent session/i);
  assert.deepEqual(usageWarningSummary([diagnostic], [diagnostic], 'models'), []);
  assert.deepEqual(usageWarningSummary([unknown], [], 'overview'), ['Some usage data may be incomplete.']);
  assert.deepEqual(usageWarningSummary([unknown], [unknown], 'overview'), []);
  assert.deepEqual(usageWarningSummary([unknown], [unknown], 'agents'), ['Some delegation details may be incomplete.']);
});
