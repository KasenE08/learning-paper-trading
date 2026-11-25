import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/engine.js';

// Reference times (UTC). Nov 2026 is EST (UTC-5).
const T = iso => Date.parse(iso);
const TUE_1000 = T('2026-11-24T15:00:00Z');   // Tue 10:00 ET, regular
const TUE_1600 = T('2026-11-24T21:00:00Z');   // Tue 16:00 ET, close
const TUE_1800 = T('2026-11-24T23:00:00Z');   // Tue 18:00 ET, after-hours
const WED_0800 = T('2026-11-25T13:00:00Z');   // Wed 8:00 ET, pre-market
const WED_0930 = T('2026-11-25T14:30:00Z');   // Wed 9:30 ET, open
const WED_1000 = T('2026-11-25T15:00:00Z');
const FRI_1000 = T('2026-11-27T15:00:00Z');   // Fri after Thanksgiving (early close 1pm)

function acct(cash = 10000) {
  return { account: { startingBalance: cash, settled: cash, unsettled: [], createdAt: T('2026-11-01T12:00:00Z') }, trading: E.freshTrading() };
}
const bar = (t, o, h, l, c) => ({ t, o, h, l, c });
function buy(s, input, now, price) {
  const r = E.submit(s, { side: 'buy', type: 'market', tif: 'day', symbol: 'AAPL', ...input }, { now, price });
  if (r.ok) E.processTick(s, input.symbol || 'AAPL', price, now);
  return r;
}
function sell(s, input, now, price) {
  const r = E.submit(s, { side: 'sell', type: 'market', tif: 'day', symbol: 'AAPL', ...input }, { now, price });
  if (r.ok) E.processTick(s, input.symbol || 'AAPL', price, now);
  return r;
}

test('market buy in regular hours fills right away at the ask (last + spread)', () => {
  const s = acct();
  const r = buy(s, { qty: 10 }, TUE_1000, 100);
  assert.ok(r.ok, r.errors.join());
  const f = s.trading.fills[0];
  assert.equal(f.price, 100.03); // half spread = max(100*0.00025, 0.005) = 0.025 → 100.025 → 100.03
  assert.equal(E.position(s, 'AAPL').qty, 10);
  assert.equal(s.account.settled, 10000 - 1000.3);
});

test('market order outside hours waits and fills at the next open price', () => {
  const s = acct();
  const r = buy(s, { qty: 5 }, TUE_1800, 100);
  assert.ok(r.ok);
  assert.ok(r.warnings.some(w => w.code === 'queued'));
  assert.equal(s.trading.fills.length, 0);
  E.processBar(s, 'AAPL', bar(WED_0800, 101, 101, 101, 101), WED_0800 + 60000); // pre-market: no fill
  assert.equal(s.trading.fills.length, 0);
  E.processBar(s, 'AAPL', bar(WED_0930, 103, 104, 102, 103.5), WED_0930 + 60000);
  assert.equal(s.trading.fills[0].price, 103.03);
});

test('fractional rules (Fidelity-style)', () => {
  const s = acct();
  assert.ok(E.preview(s, { symbol: 'AAPL', side: 'buy', type: 'market', qty: 0.5 }, { now: TUE_1000, price: 100 }).ok);
  assert.match(E.preview(s, { symbol: 'AAPL', side: 'buy', type: 'market', qty: 0.0005 }, { now: TUE_1000, price: 100 }).errors.join(), /3 decimal/);
  assert.match(E.preview(s, { symbol: 'AAPL', side: 'buy', type: 'stop', qty: 0.5, stop: 110 }, { now: TUE_1000, price: 100 }).errors.join(), /whole shares/);
  assert.match(E.preview(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 0.5, limit: 99, ext: true }, { now: TUE_1800, price: 100 }).errors.join(), /regular hours/);
  assert.match(E.preview(s, { symbol: 'AAPL', side: 'buy', type: 'market', qty: 0.005 }, { now: TUE_1000, price: 100 }).errors.join(), /at least \$1/);
  assert.match(E.preview(s, { symbol: 'AAPL', side: 'buy', type: 'limit', notional: 50, limit: 99 }, { now: TUE_1000, price: 100 }).errors.join(), /market orders only/);
  const r = buy(s, { notional: 100 }, TUE_1000, 300);
  assert.ok(r.ok, r.errors.join());
  assert.equal(s.trading.fills[0].qty, 0.333); // floor to 0.001 shares
});

test('limit buy fills only at the limit or better; gaps fill at the open', () => {
  const s = acct();
  E.submit(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 10, limit: 95, tif: 'gtc' }, { now: TUE_1000, price: 100 });
  E.processBar(s, 'AAPL', bar(TUE_1000 + 60000, 99, 99.5, 96, 97));
  assert.equal(s.trading.fills.length, 0);
  E.processBar(s, 'AAPL', bar(TUE_1000 + 120000, 96, 96, 94.9, 95));
  assert.equal(s.trading.fills[0].price, 95);
  const s2 = acct();
  E.submit(s2, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 10, limit: 95, tif: 'gtc' }, { now: TUE_1000, price: 100 });
  E.processBar(s2, 'AAPL', bar(WED_0930, 90, 91, 89, 90.5));
  assert.equal(s2.trading.fills[0].price, 90.02, 'gap down: fills at the better open price');
});

test('stops: validation, trigger, and gap-through fills', () => {
  const s = acct();
  assert.match(E.preview(s, { symbol: 'AAPL', side: 'buy', type: 'stop', qty: 1, stop: 99 }, { now: TUE_1000, price: 100 }).errors.join(), /above the current price/);
  buy(s, { qty: 10 }, TUE_1000, 100);
  assert.match(E.preview(s, { symbol: 'AAPL', side: 'sell', type: 'stop', qty: 10, stop: 101 }, { now: TUE_1000, price: 100 }).errors.join(), /below the current price/);
  E.submit(s, { symbol: 'AAPL', side: 'sell', type: 'stop', qty: 10, stop: 95, tif: 'gtc' }, { now: TUE_1000, price: 100 });
  E.processBar(s, 'AAPL', bar(WED_0930, 92, 93, 91, 92));
  const f = s.trading.fills[0];
  assert.equal(f.side, 'sell');
  assert.equal(f.price, 91.98, 'gapped below the stop: fills near the open, not at the stop');
});

test('stop-limit sell: triggers but will not sell below the limit', () => {
  const s = acct();
  buy(s, { qty: 10 }, TUE_1000, 100);
  E.submit(s, { symbol: 'AAPL', side: 'sell', type: 'stop_limit', qty: 10, stop: 95, limit: 94, tif: 'gtc' }, { now: TUE_1000, price: 100 });
  E.processBar(s, 'AAPL', bar(WED_0930, 90, 91, 89, 90));
  assert.equal(s.trading.fills.length, 1, 'triggered, but price is below the limit');
  E.processBar(s, 'AAPL', bar(WED_0930 + 60000, 92, 94.5, 92, 94.2));
  assert.equal(s.trading.fills[0].price, 94);
});

test('trailing stop follows the high, then sells', () => {
  const s = acct();
  buy(s, { qty: 10 }, TUE_1000, 100);
  E.submit(s, { symbol: 'AAPL', side: 'sell', type: 'trailing_stop', qty: 10, trail: { kind: '%', value: 5 }, tif: 'gtc' }, { now: TUE_1000, price: 100 });
  E.processBar(s, 'AAPL', bar(TUE_1000 + 60000, 100, 110, 100, 110));
  assert.equal(s.trading.orders.find(o => o.type === 'trailing_stop').hwm, 110);
  E.processBar(s, 'AAPL', bar(TUE_1000 + 120000, 108, 108, 106, 107)); // stop at 104.5: no
  assert.equal(s.trading.fills.length, 1);
  E.processBar(s, 'AAPL', bar(TUE_1000 + 180000, 105, 105, 104, 104.2));
  assert.equal(s.trading.fills[0].price, 104.47);
});

test('bracket: entry fills, take-profit fills, stop-loss is canceled', () => {
  const s = acct();
  const r = E.submit(s, { symbol: 'AAPL', side: 'buy', type: 'bracket', entryType: 'market', qty: 10, takeProfit: 110, stopLoss: 95, tif: 'gtc' }, { now: TUE_1000, price: 100 });
  assert.ok(r.ok, r.errors.join());
  assert.equal(r.orders.length, 3);
  E.processTick(s, 'AAPL', 100, TUE_1000);
  assert.deepEqual(s.trading.orders.filter(o => o.group?.role !== 'entry').map(o => o.status), ['open', 'open']);
  assert.equal(E.availableShares(s, 'AAPL'), 0, 'both exits reserve the same 10 shares once');
  E.processBar(s, 'AAPL', bar(TUE_1000 + 60000, 105, 111, 105, 110.5));
  const tp = s.trading.orders.find(o => o.group?.role === 'tp'), sl = s.trading.orders.find(o => o.group?.role === 'sl');
  assert.equal(tp.status, 'filled'); assert.equal(sl.status, 'canceled');
  assert.equal(E.position(s, 'AAPL').qty, 0);
  assert.ok(s.trading.fills[0].realized > 90);
});

test('bracket price checks', () => {
  const s = acct();
  const r = E.preview(s, { symbol: 'AAPL', side: 'buy', type: 'bracket', entryType: 'market', qty: 1, takeProfit: 99, stopLoss: 101 }, { now: TUE_1000, price: 100 });
  assert.match(r.errors.join(), /Take-profit must be above/);
  assert.match(r.errors.join(), /Stop-loss must be below/);
});

test('OCO on an existing position: one fills, the other cancels', () => {
  const s = acct();
  buy(s, { qty: 10 }, TUE_1000, 100);
  const r = E.submit(s, { symbol: 'AAPL', side: 'sell', type: 'oco', qty: 10, takeProfit: 105, stopLoss: 97, tif: 'gtc' }, { now: TUE_1000, price: 100 });
  assert.ok(r.ok, r.errors.join());
  assert.equal(E.availableShares(s, 'AAPL'), 0);
  E.processBar(s, 'AAPL', bar(TUE_1000 + 60000, 99, 99, 96, 96.5));
  assert.deepEqual(s.trading.orders.filter(o => o.group?.kind === 'oco').map(o => o.status).sort(), ['canceled', 'filled']);
});

test('day orders expire at the close; GTC lasts 180 days', () => {
  const s = acct();
  E.submit(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, limit: 90, tif: 'day' }, { now: TUE_1000, price: 100 });
  E.submit(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, limit: 90, tif: 'gtc' }, { now: TUE_1000, price: 100 });
  E.expire(s, TUE_1600);
  assert.deepEqual(s.trading.orders.map(o => o.status).sort(), ['expired', 'open']);
  E.expire(s, TUE_1000 + 181 * 864e5);
  assert.deepEqual(s.trading.orders.map(o => o.status), ['expired', 'expired']);
});

test('extended hours: limit only, own session, expires at session end', () => {
  const s = acct();
  assert.match(E.preview(s, { symbol: 'AAPL', side: 'buy', type: 'market', qty: 1, ext: true }, { now: WED_0800, price: 100 }).errors.join(), /must be limit/);
  const r = E.submit(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 2, limit: 101, ext: true }, { now: WED_0800, price: 100 });
  assert.ok(r.ok, r.errors.join());
  assert.equal(r.orders[0].ext, 'pre');
  E.processBar(s, 'AAPL', bar(WED_0800 + 60000, 100, 100, 100, 100));
  assert.equal(s.trading.fills[0].price, 100.1, 'wider spread in pre-market (4x)');
  // regular order placed pre-market does not fill until the open
  E.submit(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, limit: 101 }, { now: WED_0800, price: 100 });
  E.processBar(s, 'AAPL', bar(WED_0800 + 120000, 100, 100, 100, 100));
  assert.equal(s.trading.fills.length, 1);
  // ext order placed during regular hours targets after-hours
  const r2 = E.submit(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, limit: 50, ext: true }, { now: WED_1000, price: 100 });
  assert.equal(r2.orders[0].ext, 'post');
  E.expire(s, T('2026-11-26T01:00:00Z')); // Wed 20:00 ET
  assert.equal(r2.orders[0].status, 'expired');
});

test('no short selling; can only sell what is free', () => {
  const s = acct();
  assert.match(E.preview(s, { symbol: 'AAPL', side: 'sell', type: 'market', qty: 1 }, { now: TUE_1000, price: 100 }).errors.join(), /can't short/);
  buy(s, { qty: 5 }, TUE_1000, 100);
  E.submit(s, { symbol: 'AAPL', side: 'sell', type: 'limit', qty: 3, limit: 120, tif: 'gtc' }, { now: TUE_1000, price: 100 });
  assert.match(E.preview(s, { symbol: 'AAPL', side: 'sell', type: 'market', qty: 3 }, { now: TUE_1000, price: 100 }).errors.join(), /up to 2 shares/);
});

test('buying power: open buy orders hold cash', () => {
  const s = acct(1000);
  assert.ok(E.submit(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 8, limit: 100, tif: 'gtc' }, { now: TUE_1000, price: 101 }).ok);
  assert.equal(E.buyingPower(s, TUE_1000), 200);
  assert.match(E.preview(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 3, limit: 100 }, { now: TUE_1000, price: 101 }).errors.join(), /Not enough buying power/);
  E.cancel(s, s.trading.orders[0].id, TUE_1000);
  assert.equal(E.buyingPower(s, TUE_1000), 1000);
});

test('T+1 settlement, skipping Thanksgiving', () => {
  const s = acct();
  buy(s, { qty: 10 }, TUE_1000, 100);
  sell(s, { qty: 10 }, WED_1000, 100);
  assert.equal(s.account.unsettled[0].settles, '2026-11-27');
  E.settle(s, T('2026-11-26T15:00:00Z'));
  assert.equal(s.account.unsettled.length, 1);
  const before = s.account.settled;
  E.settle(s, FRI_1000);
  assert.equal(s.account.unsettled.length, 0);
  assert.ok(s.account.settled > before);
});

test('regulatory fees on sales', () => {
  assert.deepEqual(E.sellFees(100, 10000), { sec: 0, taf: 0.02, total: 0.02 });
  assert.equal(E.sellFees(1e6, 1e8).taf, 8.3, 'TAF is capped');
  const s = acct();
  buy(s, { qty: 100 }, TUE_1000, 50);
  sell(s, { qty: 100 }, TUE_1000 + 60000, 50);
  assert.equal(s.trading.fills[0].fees, 0.02);
});

test('good-faith violation: warned, recorded, avoided by waiting a day', () => {
  const s = acct(1100);
  buy(s, { qty: 10, symbol: 'MSFT' }, TUE_1000, 100);         // all settled cash
  sell(s, { qty: 10, symbol: 'MSFT' }, WED_1000, 100);        // proceeds settle Fri (holiday)
  buy(s, { qty: 9, symbol: 'AAPL' }, WED_1000, 100);          // bought with unsettled cash
  assert.equal(E.position(s, 'AAPL').lots[0].fundSettle, '2026-11-27');
  const pv = E.preview(s, { symbol: 'AAPL', side: 'sell', type: 'market', qty: 9 }, { now: WED_1000 + 60000, price: 101 });
  assert.ok(pv.warnings.some(w => w.code === 'gfv'));
  // waiting until the funds settle avoids it
  const s2 = structuredClone(s);
  E.settle(s2, FRI_1000);
  assert.ok(!E.preview(s2, { symbol: 'AAPL', side: 'sell', type: 'market', qty: 9 }, { now: FRI_1000, price: 101 }).warnings.some(w => w.code === 'gfv'));
  sell(s2, { qty: 9 }, FRI_1000, 101);
  assert.equal(s2.trading.violations.length, 0);
  // selling early records a violation
  sell(s, { qty: 9 }, WED_1000 + 60000, 101);
  assert.equal(s.trading.violations.length, 1);
  assert.ok(s.trading.fills[0].gfv);
});

test('buy using unsettled cash shows a heads-up', () => {
  const s = acct(1100);
  buy(s, { qty: 10, symbol: 'MSFT' }, TUE_1000, 100);
  sell(s, { qty: 10, symbol: 'MSFT' }, TUE_1000 + 60000, 100);
  const pv = E.preview(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 5, limit: 100 }, { now: TUE_1000 + 120000, price: 100 });
  assert.ok(pv.ok);
  assert.ok(pv.warnings.some(w => w.code === 'unsettled'));
});

test('3 violations in 12 months restrict buying to settled cash for 90 days', () => {
  const s = acct(1000);
  let t = TUE_1000;
  for (let i = 0; i < 3; i++) {
    const day = T('2026-12-01T15:00:00Z') + i * 7 * 864e5; // Tuesdays in December
    assert.ok(buy(s, { qty: 9, symbol: 'MSFT' }, day, 100).ok);
    sell(s, { qty: 9, symbol: 'MSFT' }, day + 60000, 100);
    assert.ok(buy(s, { qty: 8, symbol: 'AAPL' }, day + 120000, 100).ok);
    sell(s, { qty: 8 }, day + 180000, 100);
    E.settle(s, day + 2 * 864e5);
    t = day;
  }
  assert.equal(s.trading.violations.length, 3);
  assert.ok(s.trading.restrictedUntil);
  assert.ok(E.isRestricted(s, t + 864e5));
  // while restricted, unsettled sale proceeds don't count toward buying power
  buy(s, { qty: 5, symbol: 'MSFT' }, t + 7 * 864e5, 100);
  sell(s, { qty: 5, symbol: 'MSFT' }, t + 7 * 864e5 + 60000, 100);
  assert.ok(s.account.unsettled.length > 0);
  const bp = E.buyingPower(s, t + 7 * 864e5 + 120000);
  assert.equal(bp, s.account.settled);
});

test('forward split (Fidelity/FINRA): below-market orders adjusted, above-market canceled, once', () => {
  const s = acct();
  buy(s, { qty: 20 }, TUE_1000, 100);
  const sellLimit = E.submit(s, { symbol: 'AAPL', side: 'sell', type: 'limit', qty: 5, limit: 150, tif: 'gtc' }, { now: TUE_1000, price: 100 }).orders[0];
  const sellStop = E.submit(s, { symbol: 'AAPL', side: 'sell', type: 'stop', qty: 5, stop: 90, tif: 'gtc' }, { now: TUE_1000, price: 100 }).orders[0];
  const buyLimit = E.submit(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 3, limit: 80, tif: 'gtc' }, { now: TUE_1000, price: 100 }).orders[0];
  const buyStop = E.submit(s, { symbol: 'AAPL', side: 'buy', type: 'stop', qty: 3, stop: 120, tif: 'gtc' }, { now: TUE_1000, price: 100 }).orders[0];
  const trail = E.submit(s, { symbol: 'AAPL', side: 'sell', type: 'trailing_stop', qty: 5, trail: { kind: '$', value: 8 }, tif: 'gtc' }, { now: TUE_1000, price: 100 }).orders[0];
  const split = [{ date: WED_0930 / 1000, numerator: 4, denominator: 1 }];
  const applied = E.applySplits(s, 'AAPL', split, WED_1000);
  assert.equal(E.applySplits(s, 'AAPL', split, WED_1000).length, 0, 'only once');
  const p = E.position(s, 'AAPL');
  assert.equal(p.qty, 80);
  assert.ok(Math.abs(p.cost - 2000.6) < 0.01, 'cost basis unchanged');
  assert.equal(sellLimit.status, 'canceled');
  assert.equal(buyStop.status, 'canceled');
  assert.deepEqual([sellStop.qty, sellStop.stop], [20, 22.5]);
  assert.deepEqual([buyLimit.qty, buyLimit.limit], [12, 20]);
  assert.deepEqual([trail.qty, trail.trail.value, trail.hwm], [20, 2, 25]);
  assert.equal(applied[0].canceled.length, 2);
  assert.match(s.trading.activity.find(a => a.kind === 'canceled').text, /stock split — re-enter/);
});

test('3-for-2 split rounds whole-share orders down', () => {
  const s = acct();
  buy(s, { qty: 3 }, TUE_1000, 100);
  const o = E.submit(s, { symbol: 'AAPL', side: 'sell', type: 'stop', qty: 3, stop: 90, tif: 'gtc' }, { now: TUE_1000, price: 100 }).orders[0];
  E.applySplits(s, 'AAPL', [{ date: WED_0930 / 1000, numerator: 3, denominator: 2 }], WED_1000);
  assert.equal(E.position(s, 'AAPL').qty, 4.5);
  assert.equal(o.qty, 4);
  assert.equal(o.stop, 60);
});

test('reverse split cancels every open order', () => {
  const s = acct();
  buy(s, { qty: 20 }, TUE_1000, 10);
  const a = E.submit(s, { symbol: 'AAPL', side: 'sell', type: 'stop', qty: 20, stop: 9, tif: 'gtc' }, { now: TUE_1000, price: 10 }).orders[0];
  const b = E.submit(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 5, limit: 8, tif: 'gtc' }, { now: TUE_1000, price: 10 }).orders[0];
  E.applySplits(s, 'AAPL', [{ date: WED_0930 / 1000, numerator: 1, denominator: 10 }], WED_1000);
  assert.equal(E.position(s, 'AAPL').qty, 2);
  assert.deepEqual([a.status, b.status], ['canceled', 'canceled']);
});

test('split cancels a whole OCO when one leg must be canceled', () => {
  const s = acct();
  buy(s, { qty: 10 }, TUE_1000, 100);
  const r = E.submit(s, { symbol: 'AAPL', side: 'sell', type: 'oco', qty: 10, takeProfit: 110, stopLoss: 95, tif: 'gtc' }, { now: TUE_1000, price: 100 });
  E.applySplits(s, 'AAPL', [{ date: WED_0930 / 1000, numerator: 2, denominator: 1 }], WED_1000);
  assert.deepEqual(r.orders.map(o => o.status), ['canceled', 'canceled']);
});

test('dividends: owners before the ex-date get paid ~2 weeks later', () => {
  const s = acct();
  buy(s, { qty: 10 }, TUE_1000, 100);
  buy(s, { qty: 5 }, WED_1000, 100); // bought on the ex-date: not eligible
  const added = E.applyDividends(s, 'AAPL', [{ date: WED_0930 / 1000, amount: 0.26 }], WED_1000);
  assert.equal(added.length, 1);
  assert.equal(added[0].qty, 10);
  assert.equal(added[0].amount, 2.6);
  assert.equal(added[0].payDate, '2026-12-09');
  assert.equal(E.applyDividends(s, 'AAPL', [{ date: WED_0930 / 1000, amount: 0.26 }], WED_1000).length, 0, 'only once');
  const before = s.account.settled;
  E.settle(s, T('2026-12-09T15:00:00Z'));
  assert.equal(s.account.settled, Math.round((before + 2.6) * 100) / 100);
});

test('stocks only: ETFs cannot be bought', () => {
  const s = acct();
  assert.match(E.preview(s, { symbol: 'SPY', side: 'buy', type: 'market', qty: 1, tradable: false }, { now: TUE_1000, price: 700 }).errors.join(), /Only stocks/);
});

test('price increments', () => {
  const s = acct();
  assert.match(E.preview(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, limit: 99.995 }, { now: TUE_1000, price: 100 }).errors.join(), /whole cents/);
  assert.ok(E.preview(s, { symbol: 'PENY', side: 'buy', type: 'limit', qty: 100, limit: 0.1234 }, { now: TUE_1000, price: 0.12 }).ok);
});

test('migrates a Phase 2 account', () => {
  const s = E.migrate({ account: { startingBalance: 5000, cash: 5000, createdAt: 1 } });
  assert.equal(s.account.settled, 5000);
  assert.deepEqual(s.account.unsettled, []);
  assert.ok(s.trading.orders);
});

test('a live price never jumps over unreplayed history', () => {
  const s = acct();
  E.submit(s, { symbol: 'AAPL', side: 'buy', type: 'limit', qty: 10, limit: 95, tif: 'gtc' }, { now: TUE_1000, price: 100 });
  const f = E.processTick(s, 'AAPL', 99, TUE_1000 + 3 * 3600e3, 120000);
  assert.equal(f.gap, true);
  assert.equal(s.trading.orders[0].checkedTo, TUE_1000, 'left for the replay');
  E.processBar(s, 'AAPL', bar(TUE_1000 + 3600e3, 96, 96, 94, 95), TUE_1000 + 3600e3 + 60000);
  assert.equal(s.trading.fills[0].price, 95);
});
