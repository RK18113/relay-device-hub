import test from 'node:test';
import assert from 'node:assert/strict';
import { watts, powerPlot } from '../client/power.js';

test('power graphs distinguish missing data from real zero and separate measurement scopes', () => {
  const points = [0, null, 20, 30].map((value, i) => ({ receivedAt: new Date(i * 30000).toISOString(), power: { system: { watts: value, scope: i === 3 ? 'wall' : 'battery' } } }));
  const plot = powerPlot(points, 'system', 'battery');
  assert.equal(plot.readings.length, 2); assert.equal(plot.peak, 20); assert.equal(plot.segments.length, 2);
  assert.equal(watts(null), 'Unavailable'); assert.equal(watts(0), '0.0 W');
});
