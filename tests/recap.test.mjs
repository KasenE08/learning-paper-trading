import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
const R = await import('../js/recap.js');

// 260 daily bars, steadily rising, starting 2025-11-03
const start = Date.parse('2025-11-03T14:30:00Z') / 1000;
const bars = Array.from({ length: 260 }, (_, i) => { const c = 100 + i * 0.4; return [start + i * 86400, c - 0.2, c + 1, c - 1, c, 1000]; });
const spy = bars.map(b => [b[0], 500, 500, 500, 500 + (b[0] - start) / 86400 * 0.1, 0]);

test('recap uses the last completed close before entry (no peeking) and summarizes the hold', () => {
  const entryBar = 240, exitBar = 250;
  const opened = (bars[entryBar][0] + 2 * 3600) * 1000; // 11:30 ET on that day: that day's close isn't known yet
  const closed = (bars[exitBar][0] + 7 * 3600) * 1000;  // 4:30 PM ET: that day's close is known
  const fills = [
    { id: 'a', side: 'buy', qty: 10, price: bars[entryBar][1], time: opened },
    { id: 'b', side: 'sell', qty: 10, price: bars[exitBar][4], time: closed },
  ];
  const trip = { symbol: 'TEST', opened, closed, holdDays: (closed - opened) / 864e5, realized: 39.5, returnPct: 3.9, fills: ['a', 'b'] };
  const r = R.buildRecap(trip, fills, bars, spy);
  assert.equal(r.entryAsOf, new Date(bars[entryBar - 1][0] * 1000).toISOString().slice(0, 10), 'entry indicators as of the previous close');
  assert.equal(r.exitAsOf, new Date(bars[exitBar][0] * 1000).toISOString().slice(0, 10));
  assert.ok(r.pricePct > 0 && r.bestPct >= r.pricePct && r.worstPct < 0.5);
  assert.ok(r.spyPct > 0);
  const text = r.entry.map(x => x.text).join(' ');
  assert.match(text, /RSI was \d+/); assert.match(text, /200-day average/); assert.match(text, /MACD was (above|below)/);
  const html = R.recapHtml(r);
  assert.match(html, /WHEN YOU BOUGHT/); assert.match(html, /WHAT HAPPENED/); assert.match(html, /Not financial advice/);
  assert.doesNotMatch(html, /you should|buy now|sell now/i);
});
