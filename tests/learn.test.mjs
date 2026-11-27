import test from 'node:test';
import assert from 'node:assert/strict';

// minimal localStorage for store.js
globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const store = await import('../js/store.js');
const L = await import('../js/learn.js');

const reset = (fills = 0) => {
  store.wipe();
  store.createAccount(10000);
  store.update(s => { s.trading.fills = Array.from({ length: fills }, (_, i) => ({ id: 'f' + i, symbol: 'X', side: 'buy', qty: 1, price: 1, amount: 1, time: i })); delete s.learn; });
};
const always = () => 0; // rand(): always pass the weight check

test('calm pacing: one hint at a time, next one only after 2 minutes', () => {
  reset();
  const t0 = 1e12;
  assert.equal(L.tick(t0, always).id, 'candles', 'first lesson');
  assert.equal(L.tick(t0 + 1000, always), null, 'slot taken');
  L.dismiss(t0 + 5000);
  assert.equal(L.tick(t0 + 60_000, always), null, 'within 2 minutes of the last one');
  assert.equal(L.tick(t0 + 5000 + 120_000, always).id, 'search');
});

test('event tips wait for the slot; mistakes jump in immediately', () => {
  reset();
  const t0 = 2e12;
  L.tick(t0, always); // candles lesson showing
  L.emit('type:limit', {}, t0 + 1000, always);
  assert.equal(L.current().id, 'candles', 'tip queued, not shown yet');
  L.emit('gfv', {}, t0 + 2000, always);
  assert.equal(L.current().id, 'm-gfv', 'mistake replaces it at once');
  L.dismiss(t0 + 3000);
  assert.equal(L.tick(t0 + 3000 + 120_000, always).id, 'type-limit', 'queued tip comes next');
});

test('each hint shows at most twice; mistakes keep showing (with a cooldown)', () => {
  reset();
  let t = 3e12;
  for (let i = 0; i < 3; i++) { L.emit('ext', {}, t, always); L.tick(t, always); L.dismiss(t); t += 200_000; }
  assert.equal(store.get().learn.seen.ext, 2);
  for (let i = 0; i < 4; i++) { L.emit('gfv', {}, t, always); L.dismiss(t); t += 11 * 60_000; }
  assert.equal(store.get().learn.seen['m-gfv'], 4);
  L.emit('gfv', {}, t, always); L.dismiss(t);
  assert.equal(L.emit('gfv', {}, t + 60_000, always), null, '10-minute cooldown');
});

test('fade-out: basic hints thin out after 20 trades and stop by 50', () => {
  const h = L.HINTS.find(x => x.id === 'candles');
  assert.equal(L.weight(h, 0), 1);
  assert.equal(L.weight(h, 20), 1);
  assert.ok(L.weight(h, 35) > 0.4 && L.weight(h, 35) < 0.6);
  assert.equal(L.weight(h, 50), 0);
  assert.equal(L.weight(L.HINTS.find(x => x.id === 'm-gfv'), 500), 1, 'mistakes never fade');
  reset(60);
  const picked = L.tick(4e12, always);
  assert.ok(!picked || picked.to > 20, 'veteran: no beginner lessons (only later-stage ones still fading)');
  reset(80);
  assert.equal(L.tick(5e12, always), null, 'by ~75+ trades, lessons are done');
});

test('later lessons unlock with experience', () => {
  const h = L.HINTS.find(x => x.id === 'win-rate');
  assert.equal(L.weight(h, 2), 0);
  assert.equal(L.weight(h, 5), 1);
});

test('no hint tells you what to buy or sell', () => {
  for (const h of L.HINTS) assert.doesNotMatch(h.text, /\byou should (buy|sell)\b|\b(buy|sell) (now|this)\b/i, h.id);
});
