import test from 'node:test';
import assert from 'node:assert/strict';
import { thermalPlot, celsius, gpuSleeping } from '../client/temperature.js';
const at = (seconds, value) => ({ receivedAt: new Date(seconds * 1000).toISOString(), temperatureC: value });

test('missing and old temperature reports create gaps instead of zeros or continuous lines', () => {
  const result = thermalPlot([at(10, 50), at(40, null), at(70, 0), at(100, 65), at(400, 70)], 'cpu');
  assert.equal(result.segments.length, 3);
  assert.deepEqual(result.readings.map(x => x.value), [50, 0, 65, 70]);
  assert.equal(result.low, 0); assert.equal(result.peak, 70);
  assert.ok(result.segments[2][0].x > result.segments[1].at(-1).x);
});
test('GPU history and unavailable readings use actual sensor values', () => {
  const result = thermalPlot([at(10, null), { ...at(40, 90), gpu: { temperatureC: 62 } }], 'gpu');
  assert.equal(result.low, 62); assert.equal(result.peak, 62);
  assert.equal(celsius(null), 'Unavailable'); assert.equal(celsius(0), '0.0°C');
  assert.equal(gpuSleeping({ gpu: { state: 'D3cold' } }), true);
  assert.equal(gpuSleeping({ gpu: { state: 'P0' } }), false);
});
