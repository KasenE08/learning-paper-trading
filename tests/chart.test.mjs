import test from 'node:test';
import assert from 'node:assert/strict';
import { clampOutliers } from '../js/chart.js';

const base = Array.from({ length: 40 }, (_, i) => [1000 + i * 300, 100, 100.1, 99.9, 100.05, 0]);
test('clamps a stray wick', () => {
  const bars = base.map(b => b.slice()); bars[20][2] = 106;
  assert.equal(clampOutliers(bars)[20][2], 100.05);
});
test('repairs a stray open between adjacent bars', () => {
  const bars = base.map(b => b.slice()); bars[30] = [bars[30][0], 97.5, 100.1, 97.4, 100.02, 0];
  const r = clampOutliers(bars)[30];
  assert.equal(r[1], 100.05); assert.ok(r[3] > 99);
});
test('leaves normal bars alone', () => {
  assert.deepEqual(clampOutliers(base), base);
});
