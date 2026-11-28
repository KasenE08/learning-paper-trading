// Portfolio analytics: pure functions over the saved state (no network, no DOM).
import { splitFactorSince } from './engine.js';
import { ymdOf, etDate } from './market.js';

const r2 = x => Math.round(x * 100) / 100;
const EPS = 1e-6;

/**
 * Closed positions ("round trips"): from the first buy while flat until the position is fully sold.
 * Result per trip: { symbol, opened, closed, bought, sold, fees, realized, returnPct, holdDays, win, fills }
 */
export function roundTrips(s) {
  const fills = [...s.trading.fills].sort((a, b) => a.time - b.time);
  const open = new Map(), done = [];
  for (const f of fills) {
    const qty = f.qty * splitFactorSince(s, f.symbol, f.time); // restate in today's shares
    let t = open.get(f.symbol);
    if (!t) {
      if (f.side !== 'buy') continue; // sell without a tracked buy (shouldn't happen)
      t = { symbol: f.symbol, opened: f.time, qty: 0, bought: 0, sold: 0, fees: 0, realized: 0, fills: [] };
      open.set(f.symbol, t);
    }
    t.fills.push(f.id);
    if (f.side === 'buy') { t.qty += qty; t.bought += f.amount; }
    else {
      t.qty -= qty; t.sold += f.net ?? f.amount; t.fees += f.fees || 0; t.realized += f.realized || 0;
      if (t.qty <= EPS) {
        open.delete(f.symbol);
        const realized = r2(t.realized);
        done.push({ symbol: t.symbol, opened: t.opened, closed: f.time, bought: r2(t.bought), sold: r2(t.sold), fees: r2(t.fees), realized,
          returnPct: t.bought ? (realized / t.bought) * 100 : 0, holdDays: (f.time - t.opened) / 864e5, win: realized > 0, fills: t.fills });
      }
    }
  }
  return done.sort((a, b) => b.closed - a.closed);
}

export function tradeStats(trips) {
  const wins = trips.filter(t => t.win), losses = trips.filter(t => !t.win);
  const avg = a => (a.length ? a.reduce((x, t) => x + t.realized, 0) / a.length : 0);
  return {
    closed: trips.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trips.length ? (wins.length / trips.length) * 100 : null,
    avgWin: avg(wins),
    avgLoss: avg(losses),
    best: trips.length ? trips.reduce((m, t) => (t.realized > m.realized ? t : m)) : null,
    worst: trips.length ? trips.reduce((m, t) => (t.realized < m.realized ? t : m)) : null,
    avgHoldDays: trips.length ? trips.reduce((x, t) => x + t.holdDays, 0) / trips.length : null,
    realized: r2(trips.reduce((x, t) => x + t.realized, 0)),
  };
}

/** All realized P&L from every sell (including partial sells of positions still open), net of fees. */
export const realizedAll = s => r2(s.trading.fills.reduce((x, f) => x + (f.side === 'sell' ? f.realized || 0 : 0), 0));
export const dividendsPaid = s => r2((s.trading.divs.paid || []).reduce((x, d) => x + d.amount, 0));
export const feesPaid = s => r2(s.trading.fills.reduce((x, f) => x + (f.fees || 0), 0));

/**
 * Daily account value rebuilt from the fill history and daily closes.
 * closes: { [symbol]: [[unixSec, close], ...] } (split-adjusted daily bars, like Yahoo's)
 * calendar: [[unixSec, close], ...] for SPY — sets the trading days and the benchmark.
 * Returns [{ day:'YYYY-MM-DD', value, spy }] from the account's first day onward.
 */
export function equitySeries(s, closes, calendar, now = Date.now()) {
  const start = s.account.createdAt, startDay = ymdOf(start);
  const fills = [...s.trading.fills].sort((a, b) => a.time - b.time);
  const paid = [...(s.trading.divs.paid || [])].sort((a, b) => a.payDate.localeCompare(b.payDate));
  const lastClose = {}, idx = {};
  const bySym = Object.fromEntries(Object.entries(closes).map(([k, v]) => [k, [...v].sort((a, b) => a[0] - b[0])]));
  const out = [];
  let cash = s.account.startingBalance, fi = 0, di = 0;
  const qty = {};
  let spyBase = null;
  for (const [t, spyClose, spyPx = spyClose] of [...calendar].sort((a, b) => a[0] - b[0])) {
    const day = ymdOf(t * 1000);
    if (day < startDay) { spyBase = spyClose; continue; }
    const [y, m, d] = day.split('-').map(Number);
    const end = etDate(y, m, d, 24 * 60 - 1).getTime();
    while (fi < fills.length && fills[fi].time <= end) {
      const f = fills[fi++];
      const q = f.qty * splitFactorSince(s, f.symbol, f.time);
      if (f.side === 'buy') { cash -= f.amount; qty[f.symbol] = (qty[f.symbol] || 0) + q; }
      else { cash += f.net ?? f.amount; qty[f.symbol] = (qty[f.symbol] || 0) - q; }
    }
    while (di < paid.length && paid[di].payDate <= day) cash += paid[di++].amount;
    let holdings = 0;
    for (const [sym, q] of Object.entries(qty)) {
      if (Math.abs(q) < EPS) continue;
      const bars = bySym[sym] || [];
      idx[sym] ??= 0;
      while (idx[sym] < bars.length && ymdOf(bars[idx[sym]][0] * 1000) <= day) lastClose[sym] = bars[idx[sym]++][1];
      holdings += q * (lastClose[sym] ?? 0);
    }
    if (spyBase == null) spyBase = spyClose; // account opened before this data starts
    out.push({ day, value: r2(cash + holdings), spy: spyClose, spyPx, spyBase });
  }
  return out;
}

/**
 * Total-return index for a fund: daily closes with each dividend reinvested on its ex-date.
 * bars: [[unixSec, close], ...]; dividends: [{date (unixSec, ex-date), amount}]
 * Returns [[unixSec, totalReturnValue, close], ...] (value starts equal to the first close).
 */
export function totalReturnIndex(bars, dividends = []) {
  const sorted = [...bars].sort((a, b) => a[0] - b[0]);
  const divByDay = new Map();
  for (const d of dividends) { const k = ymdOf(d.date * 1000); divByDay.set(k, (divByDay.get(k) || 0) + d.amount); }
  const out = [];
  let tr = null, prevClose = null;
  for (const [t, close] of sorted) {
    if (tr == null) tr = close;
    else tr *= (close + (divByDay.get(ymdOf(t * 1000)) || 0)) / prevClose;
    out.push([t, tr, close]);
    prevClose = close;
  }
  return out;
}

/**
 * Rebase a series to % change from the first point in range.
 * Returns { you:[{time,value}], spy:[{time,value}], youPct, spyPct } for a line chart.
 */
export function compare(series, fromDay, startingBalance) {
  const pts = series.filter(p => p.day >= fromDay);
  if (!pts.length) return { you: [], spy: [], youPct: 0, spyPct: 0 };
  const first = series.indexOf(pts[0]);
  // baseline: the previous day's close (or the starting balance / pre-start SPY close on day one)
  const prev = first > 0 ? series[first - 1] : null;
  const v0 = prev ? prev.value : startingBalance, s0 = prev ? prev.spy : pts[0].spyBase;
  const you = pts.map(p => ({ time: p.day, value: (p.value / v0 - 1) * 100 }));
  const spy = pts.map(p => ({ time: p.day, value: (p.spy / s0 - 1) * 100 }));
  return { you, spy, youPct: you.at(-1).value, spyPct: spy.at(-1).value };
}

/** Start day for a range chip. */
export function rangeStart(range, now = Date.now(), createdAt = 0) {
  const day = ms => ymdOf(ms);
  switch (range) {
    case '1W': return day(now - 7 * 864e5);
    case '1M': return day(now - 30 * 864e5);
    case '3M': return day(now - 91 * 864e5);
    case 'YTD': return ymdOf(now).slice(0, 4) + '-01-01';
    default: return day(createdAt);
  }
}
