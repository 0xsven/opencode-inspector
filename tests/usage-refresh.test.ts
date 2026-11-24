import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageRequestUrl } from '../src/App.js';

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
