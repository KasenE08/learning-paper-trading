// Post-trade recap: what the indicators showed when you bought and sold, and what happened in between.
import * as store from './store.js';
import * as api from './api.js';
import * as fmt from './format.js';
import * as A from './analytics.js';
import * as I from './indicators.js';
import * as learn from './learn.js';
import { etDate } from './market.js';
import { $, sheet } from './ui.js';

const dayKey = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
// a daily bar's close is known at 4:00 PM ET on its day
const closeTime = t => { const [y, m, d] = dayKey(t * 1000).split('-').map(Number); return etDate(y, m, d, 960).getTime(); };

/** Index of the last daily bar whose close was already known at time `ms` (no peeking ahead). */
export function barAsOf(bars, ms) {
  let idx = -1;
  for (let i = 0; i < bars.length; i++) if (closeTime(bars[i][0]) <= ms) idx = i;
  return idx;
}

/**
 * Pure recap builder.
 * trip: from analytics.roundTrips; fills: the trip's fills; bars/spy: daily [t,o,h,l,c,v] (unix sec)
 */
export function buildRecap(trip, fills, bars, spy, cfg = I.DEFAULTS) {
  const buys = fills.filter(f => f.side === 'buy'), sells = fills.filter(f => f.side === 'sell');
  const avg = (list) => list.reduce((x, f) => x + f.price * f.qty, 0) / list.reduce((x, f) => x + f.qty, 0);
  const entryPx = avg(buys), exitPx = avg(sells);
  const closes = bars.map(b => b[4]), vols = bars.map(b => b[5] || 0);
  const ei = barAsOf(bars, trip.opened), xi = barAsOf(bars, trip.closed);
  // price path while you held (daily highs/lows from the entry day to the exit day)
  const during = bars.filter(b => closeTime(b[0]) >= trip.opened - 16 * 3600e3 && closeTime(b[0]) - 6.5 * 3600e3 <= trip.closed);
  // closing prices (not intraday highs/lows): stray prints in daily data can't distort them
  const hi = during.length ? Math.max(...during.map(b => b[4]), exitPx) : exitPx, lo = during.length ? Math.min(...during.map(b => b[4]), exitPx) : exitPx;
  const si = barAsOf(spy, trip.opened), sx = barAsOf(spy, trip.closed);
  return {
    symbol: trip.symbol, opened: trip.opened, closed: trip.closed, holdDays: trip.holdDays,
    realized: trip.realized, returnPct: trip.returnPct,
    entryPx, exitPx, pricePct: (exitPx / entryPx - 1) * 100,
    bestPct: (hi / entryPx - 1) * 100, worstPct: (lo / entryPx - 1) * 100,
    spyPct: si >= 0 && sx >= 0 ? (spy[sx][4] / spy[si][4] - 1) * 100 : null,
    entry: ei >= 0 ? I.describeAt(closes, vols, ei, cfg) : [],
    exit: xi >= 0 ? I.describeAt(closes, vols, xi, cfg) : [],
    entryAsOf: ei >= 0 ? dayKey(bars[ei][0] * 1000) : null,
    exitAsOf: xi >= 0 ? dayKey(bars[xi][0] * 1000) : null,
  };
}

export const recapKey = trip => trip.fills[0];

/** Fetch data and build (or load) the recap for a closed trip. */
export async function getRecap(trip) {
  const key = recapKey(trip), saved = learn.recapFor(key);
  if (saved) return saved;
  const s = store.get(), fills = s.trading.fills.filter(f => trip.fills.includes(f.id));
  const from = trip.opened / 1000 - 400 * 86400, to = trip.closed / 1000 + 86400;
  const [d, sp] = await Promise.all([api.chartPeriod(trip.symbol, '1d', from, to), api.chartPeriod('SPY', '1d', from, to)]);
  const cfg = indCfg();
  const r = buildRecap(trip, fills, d.bars, sp.bars, cfg);
  learn.saveRecap(key, r);
  return r;
}
function indCfg() {
  const i = store.get().settings.ind || {};
  return { maPeriods: i.maPeriods || I.DEFAULTS.maPeriods, rsiPeriod: i.rsiPeriod || I.DEFAULTS.rsiPeriod, macd: i.macdParams || I.DEFAULTS.macd };
}

/** Show the recap sheet (loads data if needed). */
export async function showRecap(trip) {
  const el = sheet(`<h3>TRADE RECAP · ${fmt.esc(trip.symbol)}</h3><div class="empty"><span class="spin"></span></div>`, null, 'ticket recap');
  try {
    const r = await getRecap(trip);
    if (!document.body.contains(el)) return;
    el.innerHTML = recapHtml(r);
  } catch (e) {
    el.innerHTML = `<h3>TRADE RECAP · ${fmt.esc(trip.symbol)}</h3><div class="empty">Couldn't load price history for the recap (${fmt.esc(e.message)}). Try again from Portfolio → History.</div><button class="btn wide" data-close>CLOSE</button>`;
  }
}

const d = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const ymdShort = s => (s ? fmt.day(s) : '');
function facts(list) {
  return list.length ? `<ul class="facts">${list.map(x => `<li>${fmt.esc(x.text)}</li>`).join('')}</ul>` : '<p class="d small">Not enough price history for indicators.</p>';
}
export function recapHtml(r) {
  const hold = r.holdDays < 1 ? `${Math.max(1, Math.round(r.holdDays * 24))} hours` : `${r.holdDays.toFixed(r.holdDays < 10 ? 1 : 0)} days`;
  return `
    <h3>TRADE RECAP · ${fmt.esc(r.symbol)}</h3>
    <div class="d small">${d(r.opened)} → ${d(r.closed)} · held ${hold}</div>
    <div class="rbig ${fmt.tone(r.realized)}">${fmt.signedMoney(r.realized)} <span>(${fmt.pct(r.returnPct)})</span></div>
    <div class="sect0">WHEN YOU BOUGHT${r.entryAsOf ? ` · as of ${ymdShort(r.entryAsOf)} close` : ''}</div>
    ${facts(r.entry)}
    <div class="sect0">WHAT HAPPENED</div>
    <ul class="facts">
      <li>The price went from ${fmt.price(r.entryPx)} to ${fmt.price(r.exitPx)} (<span class="${fmt.tone(r.pricePct)}">${fmt.pct(r.pricePct)}</span>).</li>
      <li>While you held it, the highest close was <span class="${fmt.tone(r.bestPct)}">${fmt.pct(r.bestPct)}</span> and the lowest was <span class="${fmt.tone(r.worstPct)}">${fmt.pct(r.worstPct)}</span> from your entry price.</li>
      ${r.spyPct != null ? `<li>The S&amp;P 500 moved <span class="${fmt.tone(r.spyPct)}">${fmt.pct(r.spyPct)}</span> over about the same days.</li>` : ''}
    </ul>
    <div class="sect0">WHEN YOU SOLD${r.exitAsOf ? ` · as of ${ymdShort(r.exitAsOf)} close` : ''}</div>
    ${facts(r.exit)}
    <p class="d small">Indicators describe what already happened; they don't predict what comes next. Not financial advice.</p>
    <button class="btn wide" data-close>CLOSE</button>`;
}

/** After fills: emit learning events and pop up a recap for a position that just closed. */
let lastRecapShown = null;
export function afterFills(fills, { summary } = {}) {
  if (!fills?.length) return;
  const s = store.get();
  for (const f of fills) {
    learn.emit(f.side === 'buy' ? 'fill:buy' : 'fill:sell');
    if (f.gfv) learn.emit('gfv');
  }
  if (s.trading.restrictedUntil && fills.some(f => f.gfv)) learn.emit('restricted');
  if (summary && fills.some(f => f.side === 'buy')) {
    const sm = summary(), row = sm.rows.find(r => r.symbol === fills.find(f => f.side === 'buy').symbol);
    if (row && sm.total > 0 && row.value / sm.total > 0.4) learn.emit('concentration');
  }
  const ids = new Set(fills.map(f => f.id));
  const trip = A.roundTrips(s).find(t => t.fills.some(id => ids.has(id)));
  if (trip && lastRecapShown !== recapKey(trip)) {
    lastRecapShown = recapKey(trip);
    learn.emit(trip.win ? 'close:win' : 'close:loss');
    if (!trip.win && trip.holdDays < 1) learn.emit('quickloss');
    if (!document.querySelector('.scrim')) showRecap(trip);
    else setTimeout(() => { if (!document.querySelector('.scrim')) showRecap(trip); }, 4000);
  }
}
