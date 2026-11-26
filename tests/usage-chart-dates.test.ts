import assert from 'node:assert/strict';
import test from 'node:test';
import { usageHourOfDayLabels } from '../src/usage-chart-dates';

test('hour-of-day labels keep 24 wall-clock hours and honor the locale hour cycle', () => {
  const twelve = usageHourOfDayLabels('en-US-u-hc-h12');
  const twentyFour = usageHourOfDayLabels('en-US-u-hc-h23');
  assert.equal(twelve.length, 24);
  assert.equal(new Set(twelve.map(({ heading }) => heading)).size, 24);
  assert.deepEqual(twelve[0], { dateTime: '00:00', label: '12 AM', heading: '12:00 AM' });
  assert.deepEqual(twelve[12], { dateTime: '12:00', label: '12 PM', heading: '12:00 PM' });
  assert.deepEqual(twelve[23], { dateTime: '23:00', label: '11 PM', heading: '11:00 PM' });
  assert.deepEqual(twentyFour[0], { dateTime: '00:00', label: '00', heading: '00:00' });
  assert.deepEqual(twentyFour[23], { dateTime: '23:00', label: '23', heading: '23:00' });
});

test('explicit hour cycles override the locale and h23 keeps midnight at 00', () => {
  const twelve = usageHourOfDayLabels('en-US-u-hc-h23', 'h12');
  const twentyFour = usageHourOfDayLabels('en-US-u-hc-h12', 'h23');
  assert.deepEqual(twelve[0], { dateTime: '00:00', label: '12 AM', heading: '12:00 AM' });
  assert.deepEqual(twelve[12], { dateTime: '12:00', label: '12 PM', heading: '12:00 PM' });
  assert.deepEqual(twentyFour[0], { dateTime: '00:00', label: '00', heading: '00:00' });
});
