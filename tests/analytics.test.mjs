import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/engine.js';
import * as A from '../js/analytics.js';

const T = iso => Date.parse(iso);
const MON = T('2026-11-23T15:00:00Z'), TUE = T('2026-11-24T15:00:00Z'), WED = T('2026-11-25T15:00:00Z');
const acct = (cash = 10000, created = T('2026-11-20T23:00:00Z')) => ({ account: { startingBalance: cash, settled: cash, unsettled: [], createdAt: created }, trading: E.freshTrading() });
function trade(s, side, sym, qty, price, now) {
  const r = E.submit(s, { symbol: sym, side, type: 'market', qty, tif: 'day' }, { now, price });
  assert.ok(r.ok, r.errors.join());
  E.processTick(s, sym, price, now);
}

test('round trips: partial sells roll into one closed position', () => {
  const s = acct();
  trade(s, 'buy', 'AAPL', 10, 100, MON);
  trade(s, 'sell', 'AAPL', 4, 110, TUE);
  trade(s, 'sell', 'AAPL', 6, 120, WED);
  trade(s, 'buy', 'MSFT', 5, 200, MON);
  trade(s, 'sell', 'MSFT', 5, 190, TUE);
  trade(s, 'buy', 'NVDA', 2, 100, WED); // still open: not counted
  const trips = A.roundTrips(s);
  assert.equal(trips.length, 2);
  const aapl = trips.find(t => t.symbol === 'AAPL'), msft = trips.find(t => t.symbol === 'MSFT');
  assert.ok(aapl.win); assert.ok(!msft.win);
  // AAPL: bought 10 @100.03, sold 4 @109.97 and 6 @119.97, minus fees
  assert.equal(aapl.realized, Math.round((4 * 109.97 + 6 * 119.97 - 1000.3 - 0.02) * 100) / 100);
  assert.equal(Math.round(aapl.holdDays), 2);
  const st = A.tradeStats(trips);
  assert.equal(st.closed, 2); assert.equal(st.winRate, 50);
  assert.equal(st.best.symbol, 'AAPL'); assert.equal(st.worst.symbol, 'MSFT');
});

test('realized total includes partial sells of open positions', () => {
  const s = acct();
  trade(s, 'buy', 'AAPL', 10, 100, MON);
  trade(s, 'sell', 'AAPL', 5, 110, TUE);
  assert.equal(A.roundTrips(s).length, 0);
  assert.ok(A.realizedAll(s) > 49 && A.realizedAll(s) < 50);
});

test('round trips survive a stock split', () => {
  const s = acct();
  trade(s, 'buy', 'AAPL', 10, 100, MON);
  E.applySplits(s, 'AAPL', [{ date: TUE / 1000 - 3600, numerator: 2, denominator: 1 }], TUE);
  trade(s, 'sell', 'AAPL', 20, 55, WED);
  const trips = A.roundTrips(s);
  assert.equal(trips.length, 1);
  assert.ok(trips[0].win);
});

test('equity series rebuilds daily value and compares with SPY', () => {
  const s = acct(10000);
  trade(s, 'buy', 'AAPL', 10, 100, MON); // cost 1000.30
  const day = iso => T(iso) / 1000;
  const calendar = [[day('2026-11-20T14:30:00Z'), 500], [day('2026-11-23T14:30:00Z'), 505], [day('2026-11-24T14:30:00Z'), 510]];
  const closes = { AAPL: [[day('2026-11-23T14:30:00Z'), 102], [day('2026-11-24T14:30:00Z'), 105]] };
  const series = A.equitySeries(s, closes, calendar);
  assert.deepEqual(series.map(p => p.day), ['2026-11-20', '2026-11-23', '2026-11-24'], 'opened Fri after the close: Fri is day one');
  assert.equal(series[0].value, 10000);
  assert.equal(series[1].value, 10000 - 1000.3 + 1020);
  assert.equal(series[2].value, 10000 - 1000.3 + 1050);
  const c = A.compare(series, '2026-11-01', 10000);
  assert.ok(Math.abs(c.youPct - 0.497) < 0.001);
  assert.ok(Math.abs(c.spyPct - 2) < 1e-9, 'SPY measured from the close before the account opened');
});

test('dividends paid are kept and counted', () => {
  const s = acct();
  trade(s, 'buy', 'AAPL', 10, 100, MON);
  E.applyDividends(s, 'AAPL', [{ date: TUE / 1000, amount: 0.5 }], TUE);
  E.settle(s, T('2026-12-10T15:00:00Z'));
  assert.equal(A.dividendsPaid(s), 5);
});

test('S&P total return reinvests dividends on the ex-date', () => {
  const t = iso => Date.parse(iso) / 1000;
  const bars = [[t('2026-12-17T14:30:00Z'), 100], [t('2026-12-18T14:30:00Z'), 99], [t('2026-12-19T14:30:00Z'), 100]];
  const idx = A.totalReturnIndex(bars, [{ date: t('2026-12-18T14:30:00Z'), amount: 2 }]);
  assert.equal(idx[0][1], 100);
  assert.ok(Math.abs(idx[1][1] - 101) < 1e-9, 'price fell by the dividend, total return rose by 1%');
  assert.ok(Math.abs(idx[2][1] - 101 * 100 / 99) < 1e-9);
  assert.equal(idx[2][2], 100, 'raw close kept');
});
