import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../js/indicators.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('SMA', () => {
  assert.deepEqual(I.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('EMA seeded with SMA', () => {
  const e = I.ema([1, 2, 3, 4, 5], 3); // k = 0.5
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.ok(close(e[2], 2)); assert.ok(close(e[3], 3)); assert.ok(close(e[4], 4));
});

test('RSI matches the classic Wilder example', () => {
  // Wilder / StockCharts example closes: first RSI (14) ≈ 70.53, next ≈ 66.32
  const c = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439];
  const r = I.rsi(c, 14);
  assert.equal(r[13], null);
  assert.ok(close(r[14], 70.53, 0.05), String(r[14]));
  assert.ok(close(r[15], 66.32, 0.05), String(r[15]));
  assert.equal(I.rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14)[15], 100, 'only gains → 100');
});

test('MACD line, signal and histogram line up', () => {
  const c = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5 + i * 0.2);
  const m = I.macd(c);
  assert.equal(m.line[24], null); assert.ok(m.line[25] != null);
  assert.equal(m.signal[32], null); assert.ok(m.signal[33] != null);
  assert.ok(close(m.hist[40], m.line[40] - m.signal[40]));
});

test('describeAt gives facts plus common meaning, never advice', () => {
  const up = Array.from({ length: 220 }, (_, i) => 100 + i * 0.5);
  const vol = up.map((_, i) => (i === 219 ? 3000 : 1000));
  const d = I.describeAt(up, vol, 219);
  const text = d.map(x => x.text).join(' ');
  assert.match(text, /RSI was 100: above 70, a level many traders call "overbought"/);
  assert.match(text, /above its 200-day average/);
  assert.match(text, /Volume was 3\.0× its 20-day average, heavier/);
  assert.doesNotMatch(text, /\b(buy|sell|should)\b/i);
});
