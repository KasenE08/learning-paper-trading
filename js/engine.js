// Trading engine: pure functions over the saved state. No network, no DOM.
// Models a US cash brokerage account (Fidelity-style rules): long only, no margin,
// T+1 settlement, good-faith violations, fractional shares, extended hours.
import {
  ymdOf, ymdAddTradingDays, ymdAddDays, onOrAfterTradingDay, brokerSessionAt,
  currentOrNextRegular, targetExtendedSession, etParts,
} from './market.js';
import { day as fmtDay } from './format.js';

export const RULES = {
  QTY_DECIMALS: 3,          // fractional shares down to 0.001
  MIN_NOTIONAL: 1,          // $1 minimum for fractional / dollar-based orders
  GTC_DAYS: 180,
  HALF_SPREAD_PCT: 0.00025, // simulated half bid/ask spread (regular hours)
  MIN_HALF_SPREAD: 0.005,
  EXT_SPREAD_MULT: 4,       // spreads are wider in extended hours
  MARKET_BUY_BUFFER: 1.05,  // buying power held for market-type buys (price can move)
  SEC_FEE_PER_MILLION: 0,   // SEC Section 31 rate ($0.00/M since May 2025). Update if the SEC changes it.
  TAF_PER_SHARE: 0.000166,  // FINRA Trading Activity Fee on shares sold
  TAF_MAX: 8.30,
  GFV_LIMIT: 3,             // violations in 12 months before a restriction
  RESTRICT_DAYS: 90,
  DIV_PAY_DELAY_DAYS: 14,   // estimated pay date after the ex-date
};

export const TYPES = { market: 'Market', limit: 'Limit', stop: 'Stop', stop_limit: 'Stop limit', trailing_stop: 'Trailing stop', bracket: 'Bracket', oco: 'OCO' };

// ---------------------------------------------------------------- helpers
const r2 = x => Math.round(x * 100) / 100;
const q3 = x => Math.round(x * 1000) / 1000;
const floor3 = x => Math.floor(x * 1000 + 1e-6) / 1000;
export const roundPrice = p => (p >= 1 ? Math.round(p * 100) / 100 : Math.round(p * 10000) / 10000);
const isWhole = q => Math.abs(q - Math.round(q)) < 1e-9;
const uid = (() => { let n = 0; return p => `${p}${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 5)}`; })();
const validTick = p => (p >= 1 ? Math.abs(p * 100 - Math.round(p * 100)) < 1e-6 : Math.abs(p * 10000 - Math.round(p * 10000)) < 1e-6);

export function halfSpread(price, session) {
  const hs = Math.max(price * RULES.HALF_SPREAD_PCT, RULES.MIN_HALF_SPREAD);
  return session === 'regular' ? hs : hs * RULES.EXT_SPREAD_MULT;
}
export function sellFees(qty, proceeds) {
  const sec = Math.ceil(proceeds * RULES.SEC_FEE_PER_MILLION / 1e6 * 100) / 100;
  const taf = Math.min(RULES.TAF_MAX, Math.ceil(qty * RULES.TAF_PER_SHARE * 100) / 100);
  return { sec, taf, total: r2(sec + taf) };
}

// ---------------------------------------------------------------- state
export function freshTrading() {
  return { positions: {}, orders: [], fills: [], activity: [], violations: [], restrictedUntil: null, divs: { done: {}, pending: [] }, splits: {}, lastSync: {} };
}
/** Upgrade older saved state (Phase 2 accounts had only `cash`). */
export function migrate(s) {
  const a = s.account;
  if (a && a.settled == null) { a.settled = a.cash ?? a.startingBalance; a.unsettled = []; delete a.cash; }
  s.trading = { ...freshTrading(), ...(s.trading || {}) };
  return s;
}

export const unsettledTotal = s => r2((s.account.unsettled || []).reduce((t, u) => t + u.amount, 0));
export const totalCash = s => r2(s.account.settled + unsettledTotal(s));
export const isRestricted = (s, now) => !!s.trading.restrictedUntil && ymdOf(now) < s.trading.restrictedUntil;

export function position(s, sym) {
  const p = s.trading.positions[sym];
  if (!p || !p.lots.length) return { qty: 0, cost: 0, avg: 0, lots: [] };
  const qty = q3(p.lots.reduce((t, l) => t + l.qty, 0));
  const cost = p.lots.reduce((t, l) => t + l.qty * l.price, 0);
  return { qty, cost: r2(cost), avg: qty ? cost / qty : 0, lots: p.lots, name: p.name };
}
export const openOrders = (s, sym) => s.trading.orders.filter(o => (o.status === 'open' || o.status === 'pending') && (!sym || o.symbol === sym));

function buyReserve(o) {
  if (o.side !== 'buy' || o.status !== 'open') return 0;
  if (o.notional) return o.notional;
  const px = o.type === 'limit' || o.type === 'stop_limit' ? o.limit : (o.type === 'stop' ? Math.max(o.stop, o.refPrice) : o.refPrice) * RULES.MARKET_BUY_BUFFER;
  return r2(px * o.qty);
}
export const reservedCash = s => r2(s.trading.orders.reduce((t, o) => t + buyReserve(o), 0));
export function buyingPower(s, now) {
  const base = isRestricted(s, now) ? s.account.settled : totalCash(s);
  return Math.max(0, r2(base - reservedCash(s)));
}
/** Shares already promised to open sell orders (an OCO pair counts once). */
export function reservedShares(s, sym, exceptGroup = null) {
  const groups = new Map();
  let t = 0;
  for (const o of openOrders(s, sym)) {
    if (o.side !== 'sell' || o.status !== 'open') continue;
    const q = o.qty ?? 0;
    if (o.group) { // OCO / bracket exits: only one leg can fill
      if (o.group.id === exceptGroup) continue;
      groups.set(o.group.id, Math.max(groups.get(o.group.id) || 0, q));
    } else t += q;
  }
  for (const v of groups.values()) t += v;
  return q3(t);
}
export const availableShares = (s, sym) => Math.max(0, q3(position(s, sym).qty - reservedShares(s, sym)));

// ---------------------------------------------------------------- settlement, restriction
/** Move settled sale proceeds into settled cash and pay due dividends. */
export function settle(s, now) {
  const today = ymdOf(now), a = s.account, ev = [];
  const keep = [];
  for (const u of a.unsettled) { if (u.settles <= today) { a.settled = r2(a.settled + u.amount); ev.push({ kind: 'settled', amount: u.amount, date: u.settles }); } else keep.push(u); }
  a.unsettled = keep;
  const pend = [];
  for (const d of s.trading.divs.pending) {
    if (d.payDate <= today) {
      a.settled = r2(a.settled + d.amount);
      log(s, { kind: 'dividend', symbol: d.symbol, amount: d.amount, perShare: d.perShare, qty: d.qty, exDate: d.exDate, time: now });
      ev.push({ kind: 'dividend', ...d });
    } else pend.push(d);
  }
  s.trading.divs.pending = pend;
  return ev;
}

function log(s, entry) { s.trading.activity.unshift({ id: uid('a'), ...entry }); if (s.trading.activity.length > 500) s.trading.activity.length = 500; }

// ---------------------------------------------------------------- order validation
/**
 * Check an order ticket without changing anything.
 * input: { symbol, side, type, qty?, notional?, limit?, stop?, trail?:{kind,value}, tif, ext, takeProfit?, stopLoss?, tradable?, name? }
 * ctx:   { now (ms), price (last trade), session? }
 * returns { ok, errors:[], warnings:[], estimate:{ price, qty, amount, fees }, normalized }
 */
export function preview(s, input, ctx) {
  const errors = [], warnings = [], now = ctx.now, price = ctx.price;
  const o = { ...input, symbol: String(input.symbol || '').toUpperCase() };
  const session = brokerSessionAt(now);
  const num = v => (v === '' || v == null ? null : Number(v));
  o.qty = num(o.qty); o.notional = num(o.notional); o.limit = num(o.limit); o.stop = num(o.stop);
  o.takeProfit = num(o.takeProfit); o.stopLoss = num(o.stopLoss);
  if (o.trail) o.trail = { kind: o.trail.kind === '%' ? '%' : '$', value: num(o.trail.value) };

  if (!s.account) errors.push('No account.');
  if (!o.symbol) errors.push('Pick a stock first.');
  if (!(price > 0)) errors.push('No current price for this stock yet. Try again in a moment.');
  if (o.side === 'buy' && input.tradable === false) errors.push('Only stocks can be traded here (no ETFs or funds).');
  if (!['buy', 'sell'].includes(o.side)) errors.push('Choose Buy or Sell.');
  if (!TYPES[o.type]) errors.push('Choose an order type.');
  if (o.type === 'bracket' && o.side !== 'buy') errors.push('Bracket orders start with a buy.');
  if (o.type === 'oco' && o.side !== 'sell') errors.push('OCO orders are a pair of sells on shares you own.');
  if (errors.length) return { ok: false, errors, warnings, estimate: null, normalized: o };

  // quantity
  const dollars = o.notional != null;
  if (dollars) {
    if (o.type !== 'market') errors.push('Dollar amounts work with market orders only. Use shares for other order types.');
    if (!(o.notional >= RULES.MIN_NOTIONAL)) errors.push(`Minimum is $${RULES.MIN_NOTIONAL}.`);
    o.qty = null;
  } else {
    if (!(o.qty > 0)) errors.push('Enter how many shares.');
    else {
      if (q3(o.qty) !== o.qty) errors.push('Shares can have at most 3 decimal places (e.g. 0.125).');
      if (!isWhole(o.qty) && !['market', 'limit'].includes(o.type)) errors.push(`${TYPES[o.type]} orders need whole shares. Fractional shares work with market and limit orders.`);
      if (!isWhole(o.qty) && o.qty * price < RULES.MIN_NOTIONAL) errors.push(`Fractional orders must be worth at least $${RULES.MIN_NOTIONAL}.`);
    }
  }
  const fractional = dollars || (o.qty > 0 && !isWhole(o.qty));

  // prices
  const needLimit = ['limit', 'stop_limit'].includes(o.type) || (o.type === 'bracket' && o.entryType === 'limit');
  const needStop = ['stop', 'stop_limit'].includes(o.type);
  for (const [k, need, label] of [['limit', needLimit, 'limit price'], ['stop', needStop, 'stop price']]) {
    if (!need) { o[k] = null; continue; }
    if (!(o[k] > 0)) errors.push(`Enter a ${label}.`);
    else if (!validTick(o[k])) errors.push(`The ${label} must be in ${o[k] >= 1 ? 'whole cents' : '$0.0001 steps'}.`);
  }
  if (o.type === 'stop' || o.type === 'stop_limit') {
    if (o.stop > 0 && o.side === 'buy' && o.stop <= price) errors.push(`A buy stop must be above the current price (${roundPrice(price)}). Use a market or limit order to buy now.`);
    if (o.stop > 0 && o.side === 'sell' && o.stop >= price) errors.push(`A sell stop must be below the current price (${roundPrice(price)}). Use a market or limit order to sell now.`);
    if (o.type === 'stop_limit' && o.stop > 0 && o.limit > 0) {
      if (o.side === 'buy' && o.limit < o.stop) errors.push('For a buy stop limit, the limit price should be at or above the stop price.');
      if (o.side === 'sell' && o.limit > o.stop) errors.push('For a sell stop limit, the limit price should be at or below the stop price.');
    }
  }
  if (o.type === 'trailing_stop') {
    if (!o.trail || !(o.trail.value > 0)) errors.push('Enter a trail amount.');
    else if (o.trail.kind === '%' && o.trail.value >= 50) errors.push('Trail percent must be under 50%.');
    else if (o.trail.kind === '$' && o.trail.value >= price) errors.push('Trail amount must be smaller than the price.');
  }
  if (o.type === 'bracket' || o.type === 'oco') {
    const ref = o.type === 'bracket' && o.entryType === 'limit' && o.limit > 0 ? o.limit : price;
    if (!(o.takeProfit > 0) || !validTick(o.takeProfit)) errors.push('Enter a take-profit price.');
    if (!(o.stopLoss > 0) || !validTick(o.stopLoss)) errors.push('Enter a stop-loss price.');
    if (o.takeProfit > 0 && o.takeProfit <= ref) errors.push(`Take-profit must be above ${o.type === 'bracket' ? 'the entry' : 'the current'} price (${roundPrice(ref)}).`);
    if (o.stopLoss > 0 && o.stopLoss >= ref) errors.push(`Stop-loss must be below ${o.type === 'bracket' ? 'the entry' : 'the current'} price (${roundPrice(ref)}).`);
  }

  // time in force & sessions
  o.tif = o.tif === 'gtc' ? 'gtc' : 'day';
  o.ext = !!o.ext;
  if (o.ext) {
    if (o.type !== 'limit') errors.push('Extended-hours orders must be limit orders.');
    if (fractional) errors.push('Fractional shares trade only during regular hours (9:30–4:00 ET).');
    if (o.tif === 'gtc') errors.push('Extended-hours orders are good for one session only (Day).');
  }
  if (dollars && o.tif === 'gtc') errors.push('Dollar-amount orders are Day orders only.');
  if (o.type === 'market' && o.tif === 'gtc') errors.push('Market orders are Day orders only.');

  // estimate
  const estSession = o.ext ? targetExtendedSession(now).kind : 'regular';
  const hs = halfSpread(price, estSession);
  let estPrice;
  if (o.type === 'limit' || (o.type === 'bracket' && o.entryType === 'limit')) estPrice = o.limit;
  else if (o.type === 'stop') estPrice = o.stop;
  else if (o.type === 'stop_limit') estPrice = o.limit;
  else estPrice = o.side === 'buy' ? price + hs : price - hs;
  if (o.type === 'oco') estPrice = o.takeProfit;
  estPrice = roundPrice(estPrice || price);
  const estQty = dollars ? floor3(o.notional / estPrice) : o.qty;
  const amount = dollars ? o.notional : r2(estPrice * (estQty || 0));
  const fees = o.side === 'sell' ? sellFees(estQty || 0, amount) : { sec: 0, taf: 0, total: 0 };

  // money and shares
  if (o.side === 'buy') {
    const bp = buyingPower(s, now);
    const hold = dollars ? o.notional : r2((needLimit ? o.limit : Math.max(price, o.stop || 0) * RULES.MARKET_BUY_BUFFER) * (o.qty || 0));
    if (hold > bp) errors.push(isRestricted(s, now)
      ? `Not enough settled cash. Your account is restricted to settled funds until ${fmtDay(s.trading.restrictedUntil)}. Settled buying power: $${bp.toFixed(2)}.`
      : `Not enough buying power. Available: $${bp.toFixed(2)}${needLimit ? '' : ' (market-type buys hold 5% extra in case the price moves)'}.`);
    else {
      const unsettledUsed = r2(Math.max(0, Math.min(hold, totalCash(s)) - Math.max(0, s.account.settled - reservedCash(s))));
      if (unsettledUsed > 0.004) {
        const settles = [...s.account.unsettled].sort((a, b) => a.settles.localeCompare(b.settles)).at(-1)?.settles;
        warnings.push({ code: 'unsettled', text: `This buy uses about $${unsettledUsed.toFixed(2)} of unsettled cash (settles ${fmtDay(settles)}). If you sell these shares before then, it's a good-faith violation.` });
      }
    }
  } else {
    const have = position(s, o.symbol).qty;
    const avail = availableShares(s, o.symbol);
    if (have <= 0) errors.push(`You don't own any ${o.symbol}. This account can't short sell.`);
    else if (!dollars && o.qty > avail + 1e-9) errors.push(`You can sell up to ${avail} shares${avail < have ? ` (${q3(have - avail)} are already in open sell orders)` : ''}.`);
    else if (dollars && estQty > avail + 1e-9) errors.push(`That's more than the ${avail} shares you can sell (about $${r2(avail * estPrice).toFixed(2)}).`);
    else {
      const g = gfvCheck(s, o.symbol, dollars ? estQty : o.qty, now);
      if (g) warnings.push({ code: 'gfv', text: `Selling now would be a good-faith violation: some of these shares were bought with cash that settles ${fmtDay(g)}. Wait until ${fmtDay(g)} to avoid it.${violationsInYear(s, now) + 1 >= RULES.GFV_LIMIT ? ` This would be your ${violationsInYear(s, now) + 1}rd violation in 12 months, which restricts your account to settled cash for ${RULES.RESTRICT_DAYS} days.` : ''}` });
    }
  }

  // timing notes
  const reg = currentOrNextRegular(now);
  if (!o.ext && session !== 'regular') {
    const when = new Date(reg[0]).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
    warnings.push({ code: 'queued', text: `The market is closed for regular trading, so this order waits for the next open (${when} ET).${o.type === 'market' ? ' Market orders fill at the opening price, which can be very different from the last price.' : ''}` });
  }
  if (o.ext) {
    const t = targetExtendedSession(now);
    const fmt = ms => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
    warnings.push({ code: 'ext', text: `Extended-hours order for the ${t.kind === 'pre' ? 'pre-market' : 'after-hours'} session (${fmt(t.window[0])}–${fmt(t.window[1])} ET). It can't fill during regular hours and expires when that session ends. Prices move more and spreads are wider.` });
  }

  return { ok: errors.length === 0, errors, warnings, estimate: { price: estPrice, qty: estQty, amount, fees, total: o.side === 'buy' ? amount : r2(amount - fees.total) }, normalized: o };
}

/** If selling `qty` shares now would liquidate lots bought with still-unsettled cash, return that settle date. */
export function gfvCheck(s, sym, qty, now) {
  const today = ymdOf(now);
  let left = qty, worst = null;
  for (const l of position(s, sym).lots) {
    if (left <= 1e-9) break;
    const take = Math.min(l.qty, left); left -= take;
    if (l.fundSettle && today < l.fundSettle && (!worst || l.fundSettle > worst)) worst = l.fundSettle;
  }
  return worst;
}
export function violationsInYear(s, now) {
  const from = ymdAddDays(ymdOf(now), -365);
  return s.trading.violations.filter(v => v.date > from).length;
}

// ---------------------------------------------------------------- submit
/** Validate and add the order(s). Returns { ok, errors, warnings, orders }. Call processTick afterwards to fill immediately. */
export function submit(s, input, ctx) {
  const pv = preview(s, input, ctx);
  if (!pv.ok) return { ...pv, orders: [] };
  const o = pv.normalized, now = ctx.now;
  const reg = currentOrNextRegular(now);
  const base = {
    symbol: o.symbol, side: o.side, qty: o.qty, notional: o.notional ?? null, tif: o.tif, createdAt: now, activeFrom: now,
    refPrice: ctx.price, name: input.name || null, checkedTo: now,
  };
  const expiresFor = tif => (tif === 'gtc' ? now + RULES.GTC_DAYS * 864e5 : reg[1]);
  const orders = [];
  if (o.type === 'bracket') {
    const gid = uid('g');
    const entryType = o.entryType === 'limit' ? 'limit' : 'market';
    orders.push({ ...base, id: uid('o'), type: entryType, limit: entryType === 'limit' ? o.limit : null, status: 'open', expiresAt: expiresFor(entryType === 'market' ? 'day' : o.tif), tif: entryType === 'market' ? 'day' : o.tif, group: { id: gid, kind: 'bracket', role: 'entry' } });
    const child = { ...base, side: 'sell', tif: 'gtc', status: 'pending', expiresAt: null, group: { id: gid, kind: 'bracket', role: '' } };
    orders.push({ ...child, id: uid('o'), type: 'limit', limit: o.takeProfit, group: { ...child.group, role: 'tp' } });
    orders.push({ ...child, id: uid('o'), type: 'stop', stop: o.stopLoss, group: { ...child.group, role: 'sl' } });
  } else if (o.type === 'oco') {
    const gid = uid('g');
    const common = { ...base, status: 'open', expiresAt: expiresFor(o.tif), group: { id: gid, kind: 'oco', role: '' } };
    orders.push({ ...common, id: uid('o'), type: 'limit', limit: o.takeProfit, group: { ...common.group, role: 'tp' } });
    orders.push({ ...common, id: uid('o'), type: 'stop', stop: o.stopLoss, group: { ...common.group, role: 'sl' } });
  } else {
    const ord = { ...base, id: uid('o'), type: o.type, limit: o.limit ?? null, stop: o.stop ?? null, status: 'open', expiresAt: expiresFor(o.tif) };
    if (o.type === 'trailing_stop') { ord.trail = o.trail; if (o.side === 'sell') ord.hwm = ctx.price; else ord.lwm = ctx.price; }
    if (o.ext) { const t = targetExtendedSession(now); ord.ext = t.kind; ord.window = t.window; ord.activeFrom = t.window[0]; ord.expiresAt = t.window[1]; }
    orders.push(ord);
  }
  s.trading.orders.unshift(...orders);
  for (const x of orders) if (x.status === 'open' || x.group?.role === 'entry') log(s, { kind: 'placed', orderId: x.id, symbol: x.symbol, time: now, text: describe(x) });
  return { ...pv, orders };
}

export function cancel(s, orderId, now) {
  const o = s.trading.orders.find(x => x.id === orderId);
  if (!o || !(o.status === 'open' || o.status === 'pending')) return false;
  const group = o.group ? s.trading.orders.filter(x => x.group?.id === o.group.id && (x.status === 'open' || x.status === 'pending')) : [o];
  for (const x of group) { x.status = 'canceled'; x.closedAt = now; }
  log(s, { kind: 'canceled', orderId: o.id, symbol: o.symbol, time: now, text: describe(o) + (group.length > 1 ? ' (and linked orders)' : '') });
  return true;
}

// ---------------------------------------------------------------- price processing
/** Expire orders whose time is up. */
export function expire(s, now, sym = null) {
  const out = [];
  for (const o of s.trading.orders) {
    if (sym && o.symbol !== sym) continue;
    if ((o.status === 'open' || o.status === 'pending') && o.expiresAt && now >= o.expiresAt) {
      const group = o.group?.kind === 'bracket' && o.group.role === 'entry'
        ? s.trading.orders.filter(x => x.group?.id === o.group.id && (x.status === 'open' || x.status === 'pending')) : [o];
      for (const x of group) { x.status = 'expired'; x.closedAt = o.expiresAt; }
      log(s, { kind: 'expired', orderId: o.id, symbol: o.symbol, time: o.expiresAt, text: describe(o) });
      out.push(o);
    }
  }
  return out;
}

const eligible = (o, t) => {
  if (o.status !== 'open' || t < o.activeFrom) return false;
  if (o.ext) return t >= o.window[0] && t < o.window[1];
  return brokerSessionAt(t) === 'regular';
};

/**
 * Live price update: treat as a one-print bar.
 * maxGap (ms): orders not checked for longer than this are skipped (fills.gap = true)
 * so a replay of the missed bars can run first. A live print must never jump over history.
 */
export function processTick(s, sym, price, t, maxGap = 0) { return processBar(s, sym, { t, o: price, h: price, l: price, c: price }, t, maxGap); }

/**
 * Run open orders for `sym` against one bar {t (ms start), o,h,l,c, end? (ms)}.
 * Returns fills that happened.
 */
export function processBar(s, sym, bar, endT = bar.t, maxGap = 0) {
  const fills = [];
  expire(s, bar.t, sym);
  const list = s.trading.orders.filter(o => o.symbol === sym && o.status === 'open');
  for (const o of list) {
    if (o.status !== 'open' || bar.t < (o.checkedTo ?? 0)) continue;
    if (maxGap && bar.t - (o.checkedTo ?? 0) > maxGap && bar.t > o.activeFrom + maxGap) { fills.gap = true; continue; }
    if (!eligible(o, bar.t)) continue;
    o.checkedTo = endT > bar.t ? endT : bar.t + 1;
    const session = o.ext || 'regular';
    const hs = halfSpread(bar.o, session);
    let px = null;
    switch (o.type) {
      case 'market': px = o.side === 'buy' ? bar.o + hs : bar.o - hs; break;
      case 'limit':
        if (o.side === 'buy' && bar.l + hs <= o.limit) px = Math.min(o.limit, bar.o + hs);
        if (o.side === 'sell' && bar.h - hs >= o.limit) px = Math.max(o.limit, bar.o - hs);
        break;
      case 'stop':
        if (o.side === 'buy' && bar.h >= o.stop) px = Math.max(o.stop, bar.o) + hs;
        if (o.side === 'sell' && bar.l <= o.stop) px = Math.min(o.stop, bar.o) - hs;
        break;
      case 'stop_limit': {
        let start = null; // execution reference on the bar that triggers the stop
        if (!o.triggered && o.side === 'buy' && bar.h >= o.stop) { o.triggered = true; start = Math.max(o.stop, bar.o); }
        if (!o.triggered && o.side === 'sell' && bar.l <= o.stop) { o.triggered = true; start = Math.min(o.stop, bar.o); }
        if (!o.triggered) break;
        if (start != null) { // just triggered: can it fill right away within the limit?
          if (o.side === 'buy' && start + hs <= o.limit) px = start + hs;
          if (o.side === 'sell' && start - hs >= o.limit) px = start - hs;
        } else {               // already triggered earlier: behaves like a limit order
          if (o.side === 'buy' && bar.l + hs <= o.limit) px = Math.min(o.limit, bar.o + hs);
          if (o.side === 'sell' && bar.h - hs >= o.limit) px = Math.max(o.limit, bar.o - hs);
        }
        break;
      }
      case 'trailing_stop': {
        const dist = ref => (o.trail.kind === '%' ? ref * o.trail.value / 100 : o.trail.value);
        if (o.side === 'sell') {
          const stopPx = o.hwm - dist(o.hwm);
          if (bar.l <= stopPx) px = Math.min(stopPx, bar.o) - hs;
          else o.hwm = Math.max(o.hwm, bar.h);
        } else {
          const stopPx = o.lwm + dist(o.lwm);
          if (bar.h >= stopPx) px = Math.max(stopPx, bar.o) + hs;
          else o.lwm = Math.min(o.lwm, bar.l);
        }
        break;
      }
    }
    if (px == null) continue;
    const f = fill(s, o, roundPrice(Math.max(px, 0.0001)), bar.t);
    if (f) fills.push(f);
  }
  return fills;
}

/** Execute an order at a price. Returns the fill or null (if rejected). */
function fill(s, o, price, t) {
  const a = s.account;
  let qty = o.qty ?? floor3(o.notional / price);
  if (o.side === 'buy') {
    if (qty <= 0) return reject(s, o, t, 'Amount too small for one share fraction at this price.');
    const cost = r2(price * qty);
    const bp = isRestricted(s, t) ? a.settled : totalCash(s);
    if (cost > bp + 0.0001) return reject(s, o, t, `Not enough cash when it triggered (needed $${cost.toFixed(2)}).`);
    // spend settled cash first, then unsettled (earliest first)
    let need = cost, fundSettle = null;
    const useSettled = Math.min(a.settled, need); a.settled = r2(a.settled - useSettled); need = r2(need - useSettled);
    a.unsettled.sort((x, y) => x.settles.localeCompare(y.settles));
    for (const u of a.unsettled) {
      if (need <= 0) break;
      const take = Math.min(u.amount, need); u.amount = r2(u.amount - take); need = r2(need - take);
      if (take > 0 && (!fundSettle || u.settles > fundSettle)) fundSettle = u.settles;
    }
    a.unsettled = a.unsettled.filter(u => u.amount > 0.0049);
    const p = s.trading.positions[o.symbol] ||= { lots: [], name: o.name };
    p.lots.push({ id: uid('l'), qty, price, time: t, fundSettle });
    if (o.name) p.name = o.name;
    const f = record(s, o, { side: 'buy', qty, price, amount: cost, fees: 0, time: t, fundSettle });
    activateBracket(s, o, qty, t);
    return f;
  }
  // sell
  const pos = position(s, o.symbol);
  qty = Math.min(qty, pos.qty);
  if (qty <= 0) return reject(s, o, t, 'No shares left to sell.');
  const gross = r2(price * qty), fees = sellFees(qty, gross);
  const today = ymdOf(t);
  let left = qty, basis = 0, gfv = null;
  const lots = s.trading.positions[o.symbol].lots;
  while (left > 1e-9 && lots.length) {
    const l = lots[0], take = Math.min(l.qty, left);
    basis += take * l.price; left = q3(left - take); l.qty = q3(l.qty - take);
    if (l.fundSettle && today < l.fundSettle) gfv = gfv && gfv > l.fundSettle ? gfv : l.fundSettle;
    if (l.qty <= 1e-9) lots.shift();
  }
  const net = r2(gross - fees.total);
  a.unsettled.push({ amount: net, settles: ymdAddTradingDays(today, 1), src: o.id });
  const f = record(s, o, { side: 'sell', qty, price, amount: gross, fees: fees.total, net, time: t, basis: r2(basis), realized: r2(net - basis), gfv });
  if (gfv) addViolation(s, o, t, gfv);
  closeGroup(s, o, t);
  return f;
}

function record(s, o, f) {
  o.status = 'filled'; o.closedAt = f.time; o.fill = { price: f.price, qty: f.qty, time: f.time, fees: f.fees };
  const entry = { id: uid('f'), orderId: o.id, symbol: o.symbol, type: o.type, ...f };
  s.trading.fills.unshift(entry);
  log(s, { kind: 'filled', orderId: o.id, symbol: o.symbol, time: f.time, side: f.side, qty: f.qty, price: f.price, realized: f.realized ?? null, text: describe(o) });
  return entry;
}
function reject(s, o, t, reason) {
  o.status = 'rejected'; o.closedAt = t; o.reason = reason;
  log(s, { kind: 'rejected', orderId: o.id, symbol: o.symbol, time: t, text: describe(o), reason });
  closeGroup(s, o, t);
  return null;
}
function activateBracket(s, o, qty, t) {
  if (o.group?.kind !== 'bracket' || o.group.role !== 'entry') return;
  for (const c of s.trading.orders) if (c.group?.id === o.group.id && c.status === 'pending') { c.status = 'open'; c.qty = qty; c.activeFrom = t + 1; c.checkedTo = t + 1; c.expiresAt = t + RULES.GTC_DAYS * 864e5; }
}
function closeGroup(s, o, t) {
  if (!o.group) return;
  for (const x of s.trading.orders) if (x !== o && x.group?.id === o.group.id && (x.status === 'open' || x.status === 'pending')) { x.status = 'canceled'; x.closedAt = t; x.reason = 'Linked order filled'; }
}
function addViolation(s, o, t, settles) {
  const date = ymdOf(t);
  s.trading.violations.push({ date, symbol: o.symbol, orderId: o.id, fundsSettle: settles });
  log(s, { kind: 'gfv', symbol: o.symbol, time: t, text: `Good-faith violation: sold ${o.symbol} bought with cash that settled ${fmtDay(settles)}.` });
  if (violationsInYear(s, t) >= RULES.GFV_LIMIT) {
    s.trading.restrictedUntil = ymdAddDays(date, RULES.RESTRICT_DAYS);
    log(s, { kind: 'restricted', time: t, text: `${RULES.GFV_LIMIT} good-faith violations in 12 months: buying is limited to settled cash until ${fmtDay(s.trading.restrictedUntil)}.` });
  }
}

// ---------------------------------------------------------------- corporate actions
/**
 * Orders that FINRA Rule 5330 adjusts on a forward split: those priced *below* the market
 * (buy limits, sell stops, sell stop limits, trailing sell stops). Market orders only change share count.
 */
const splitAdjustable = o => o.type === 'market'
  || (o.side === 'buy' && o.type === 'limit')
  || (o.side === 'sell' && ['stop', 'stop_limit', 'trailing_stop'].includes(o.type));

/**
 * Apply stock splits [{date (sec), numerator, denominator}] to lots and open orders (Fidelity/FINRA style):
 * - forward split: below-market orders are adjusted (shares up, prices down); sell limits and buy stops are canceled
 * - reverse split: all open orders are canceled
 * - if one leg of a bracket/OCO is canceled, the whole group is canceled
 * Returns applied splits, each with the list of canceled orders.
 */
export function applySplits(s, sym, splits, now) {
  const done = s.trading.splits[sym] ||= [];
  const applied = [];
  for (const sp of splits) {
    const day = ymdOf(sp.date * 1000), key = `${day}:${sp.numerator}/${sp.denominator}`;
    if (done.some(d => d.key === key) || day > ymdOf(now) || !(sp.numerator > 0 && sp.denominator > 0)) continue;
    const ratio = sp.numerator / sp.denominator, dayStart = etDayStart(day), label = `${sp.numerator}-for-${sp.denominator}`;
    const lots = s.trading.positions[sym]?.lots || [];
    let touched = false;
    for (const l of lots) if (l.time < dayStart) { l.qty = q3(l.qty * ratio); l.price = l.price / ratio; touched = true; }

    const affected = s.trading.orders.filter(o => o.symbol === sym && (o.status === 'open' || o.status === 'pending') && o.createdAt < dayStart);
    const cancelGroups = new Set(), toCancel = new Set();
    for (const o of affected) if (ratio < 1 || !splitAdjustable(o)) { toCancel.add(o); if (o.group) cancelGroups.add(o.group.id); }
    for (const o of affected) if (o.group && cancelGroups.has(o.group.id)) toCancel.add(o);
    const canceled = [];
    for (const o of affected) {
      touched = true;
      if (toCancel.has(o)) {
        o.status = 'canceled'; o.closedAt = dayStart; o.reason = `Canceled for the ${label} stock split`;
        canceled.push(o);
        log(s, { kind: 'canceled', orderId: o.id, symbol: sym, time: dayStart, text: `${describe(o)} (${label} stock split — re-enter it if you still want it)` });
        continue;
      }
      if (o.qty) o.qty = isWhole(o.qty) && o.type !== 'market' ? Math.floor(o.qty * ratio + 1e-9) : q3(o.qty * ratio);
      for (const k of ['limit', 'stop', 'hwm', 'lwm', 'refPrice']) if (o[k]) o[k] = roundPrice(o[k] / ratio);
      if (o.trail?.kind === '$') o.trail.value = roundPrice(o.trail.value / ratio);
    }
    done.push({ key, date: day, ratio });
    if (touched) {
      const adjusted = affected.length - canceled.length;
      log(s, { kind: 'split', symbol: sym, time: dayStart, text: `${sym} ${label} stock split: shares and cost per share adjusted${adjusted ? `, ${adjusted} open order(s) adjusted` : ''}${canceled.length ? `, ${canceled.length} open order(s) canceled` : ''}.` });
      applied.push({ ...sp, day, ratio, canceled });
    }
  }
  return applied;
}

/** Shares held at the start of an ET day, from the fill history (split-adjusted to today). */
export function sharesHeldAt(s, sym, dayStart) {
  const splits = s.trading.splits[sym] || [];
  let q = 0;
  for (const f of s.trading.fills) {
    if (f.symbol !== sym || f.time >= dayStart) continue;
    const factor = splits.filter(sp => etDayStart(sp.date) > f.time).reduce((m, sp) => m * sp.ratio, 1);
    q += (f.side === 'buy' ? 1 : -1) * f.qty * factor;
  }
  return Math.max(0, q3(q));
}

/** Schedule dividend payments [{date (sec, ex-date), amount}] for shares held before each ex-date. */
export function applyDividends(s, sym, dividends, now) {
  const added = [];
  for (const d of dividends) {
    const exDate = ymdOf(d.date * 1000), key = `${sym}:${exDate}`;
    if (s.trading.divs.done[key] || exDate > ymdOf(now) || !(d.amount > 0)) continue;
    const qty = sharesHeldAt(s, sym, etDayStart(exDate));
    s.trading.divs.done[key] = true;
    if (qty <= 0) continue;
    const amount = r2(qty * d.amount);
    if (amount <= 0) continue;
    const payDate = onOrAfterTradingDay(ymdAddDays(exDate, RULES.DIV_PAY_DELAY_DAYS));
    const entry = { symbol: sym, exDate, payDate, perShare: d.amount, qty, amount };
    s.trading.divs.pending.push(entry);
    log(s, { kind: 'div-scheduled', symbol: sym, time: etDayStart(exDate), text: `${sym} dividend: $${d.amount} × ${qty} shares = $${amount.toFixed(2)}, paid about ${fmtDay(payDate)}.` });
    added.push(entry);
  }
  return added;
}

function etDayStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  // midnight New York time
  const guess = Date.UTC(y, m - 1, d, 5);
  const p = etParts(new Date(guess));
  return guess - (p.hh * 60 + p.mm) * 60000;
}

// ---------------------------------------------------------------- text
export function describe(o) {
  const q = o.qty != null ? `${o.qty} sh` : `$${o.notional}`;
  const side = o.side === 'buy' ? 'Buy' : 'Sell';
  const t = o.type;
  const p = t === 'limit' ? ` @ ${o.limit} limit` : t === 'stop' ? ` @ ${o.stop} stop` : t === 'stop_limit' ? ` stop ${o.stop} / limit ${o.limit}` : t === 'trailing_stop' ? ` trailing ${o.trail.kind === '$' ? '$' + o.trail.value : o.trail.value + '%'}` : ' at market';
  const role = o.group ? (o.group.role === 'tp' ? ' · take-profit' : o.group.role === 'sl' ? ' · stop-loss' : o.group.role === 'entry' ? ' · bracket entry' : '') : '';
  return `${side} ${q} ${o.symbol}${p}${role}`;
}
