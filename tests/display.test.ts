import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configText, shortModel } from '../src/display.js';

test('model labels and other text fields tolerate malformed configured values', () => {
  for (const value of [42, false, null, [], { model: 'demo/model' }, { toString: null }]) {
    assert.equal(configText(value), 'Unsupported value');
    assert.equal(shortModel(value), 'Unsupported value');
  }
  assert.equal(configText(undefined), 'Unknown');
  assert.equal(configText(undefined, 'configured'), 'configured');
  assert.equal(shortModel(undefined), 'Model unknown');
  assert.equal(shortModel('demo/model'), 'model');
  assert.equal(configText('balanced'), 'balanced');
});
