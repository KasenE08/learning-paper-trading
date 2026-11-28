// Runtime glue between the engine (pure rules) and live data.
// - polls quotes for the chart symbol, positions and open orders
// - feeds every new price print to the engine (orders can fill while the app is open)
// - on launch/resume, replays the minute bars missed while the app was closed
// - applies stock splits and dividends for held stocks once a day
import * as store from './store.js';
import * as api from './api.js';
import * as E from './engine.js';
import { ymdOf, etParts, etDate, marketState, SESSION } from './market.js';
import { REFRESH_MS } from './config.js';

const GAP_MS = 2 * 60 * 1000; // a live price can only advance an order checked within the last 2 minutes
const quotes = new Map();
// Last known prices survive restarts, so the app opens with numbers even when offline.
const QKEY = 'lpt.quotes';
try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(QKEY) || '{}'))) quotes.set(k, { ...v, stale: true }); } catch { /* ignore */ }
const saveQuotes = () => { try { localStorage.setItem(QKEY, JSON.stringify(Object.fromEntries([...quotes].slice(-40)))); } catch { /* ignore */ } };

// Connection status for the banner: ok | offline | down (data source not answering)
let net = { state: 'ok', lastOk: Date.now(), fails: 0 };
export const netStatus = () => ({ ...net, lastQuoteAt: Math.max(0, ...[...quotes.values()].map(q => q.fetchedAt || 0)) });
function netFail(e) {
  net.fails++;
  const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || /reach/i.test(e?.message || '');
  if (offline || net.fails >= 2) net.state = offline ? 'offline' : 'down';
}
function netOk() { net = { state: 'ok', lastOk: Date.now(), fails: 0 }; }
const listeners = new Set();
let extraSymbols = () => [];
let pollBusy = false, lastPoll = 0, catchingUp = false;

export const getQuote = sym => quotes.get(sym) || null;
export function onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = what => listeners.forEach(fn => { try { fn(what); } catch (e) { console.error(e); } });

export function activeSymbols() {
  const t = store.get().trading, set = new Set(extraSymbols());
  for (const [sym, p] of Object.entries(t.positions)) if (p.lots.length) set.add(sym);
  for (const o of E.openOrders(store.get())) set.add(o.symbol);
  return [...set].filter(Boolean).slice(0, 20);
}

/** Fetch quotes; feed prices to open orders. */
export async function poll(symbols = activeSymbols()) {
  if (pollBusy || !symbols.length || !api.relayUrl()) return;
  pollBusy = true; lastPoll = Date.now();
  try {
    const res = await api.quotes(symbols);
    const now = Date.now();
    let fills = [], needCatchUp = false;
    store.update(s => {
      for (const [sym, q] of Object.entries(res.quotes)) {
        if (!q || q.error) continue;
        quotes.set(sym, { ...q, fetchedAt: now, stale: false });
        if (E.openOrders(s, sym).length && q.last > 0 && q.lastTime) {
          const f = E.processTick(s, sym, q.last, q.lastTime * 1000, GAP_MS);
          if (f.gap) needCatchUp = true;
          fills = fills.concat(f);
        }
      }
      E.expire(s, now); E.settle(s, now);
    });
    netOk(); saveQuotes();
    notify({ kind: 'quotes', fills });
    if (needCatchUp) setTimeout(catchUp, 0);
  } catch (e) { netFail(e); notify({ kind: 'error', error: e }); }
  finally { pollBusy = false; }
}

/** Make sure we have a fresh price for one symbol (used before placing an order). */
export async function freshQuote(sym) {
  const q = quotes.get(sym);
  if (q && !q.stale && Date.now() - q.fetchedAt < 4000) return q;
  pollBusy = false;
  await poll([...new Set([sym, ...activeSymbols()])].slice(0, 20));
  const fresh = quotes.get(sym);
  return fresh && !fresh.stale && Date.now() - fresh.fetchedAt < 30000 ? fresh : null; // never trade on an old price
}

/** Place an order. Fills immediately if it can. */
export function place(input, q) {
  const now = Date.now();
  let out;
  store.update(s => {
    out = E.submit(s, input, { now, price: q.last ?? q.price });
    if (out.ok) out.fills = E.processTick(s, input.symbol, q.last ?? q.price, now);
  });
  notify({ kind: 'order', result: out });
  return out;
}
export function cancel(orderId) { let ok; store.update(s => { ok = E.cancel(s, orderId, Date.now()); }); notify({ kind: 'order' }); return ok; }

/** Replay bars missed while the app was closed, then corporate actions, then housekeeping. */
export async function catchUp() {
  if (catchingUp || !api.relayUrl() || !store.get().account) return;
  catchingUp = true;
  const now = Date.now();
  const events = [];
  try {
    await corporateActions(now, events);
    const s0 = store.get();
    const bySym = new Map();
    for (const o of E.openOrders(s0)) if (o.status === 'open') bySym.set(o.symbol, Math.min(bySym.get(o.symbol) ?? Infinity, o.checkedTo ?? o.createdAt));
    for (const [sym, since] of bySym) {
      if (now - since < 60 * 1000) continue;
      const age = now - since;
      const interval = age <= 7 * 864e5 ? '1m' : age <= 59 * 864e5 ? '5m' : '1d';
      const step = { '1m': 60e3, '5m': 300e3, '1d': 864e5 }[interval];
      try {
        const data = await api.chartPeriod(sym, interval, since / 1000 - step / 1000, now / 1000, { prepost: interval !== '1d' });
        store.update(s => {
          for (const [t, o, h, l, c] of data.bars) {
            const ms = t * 1000;
            if (ms + step <= since) continue;
            events.push(...E.processBar(s, sym, { t: ms, o, h, l, c }, ms + step).map(f => ({ kind: 'fill', fill: f })));
          }
        });
      } catch (e) { events.push({ kind: 'error', symbol: sym, error: e.message }); }
    }
    store.update(s => { E.expire(s, now); E.settle(s, now); });
  } finally { catchingUp = false; }
  notify({ kind: 'catchup', events });
  return events;
}

async function corporateActions(now, events) {
  const s = store.get(), today = ymdOf(now);
  for (const [sym, p] of Object.entries(s.trading.positions)) {
    if (!p.lots.length || s.trading.lastSync[sym] === today) continue;
    const first = Math.min(...p.lots.map(l => l.time), ...s.trading.fills.filter(f => f.symbol === sym).map(f => f.time));
    try {
      const data = await api.chartPeriod(sym, '1d', first / 1000 - 3 * 86400, now / 1000, { events: true });
      store.update(st => {
        events.push(...E.applySplits(st, sym, data.splits || [], now).map(x => ({ kind: 'split', symbol: sym, ...x })));
        events.push(...E.applyDividends(st, sym, data.dividends || [], now).map(x => ({ kind: 'dividend', ...x })));
        st.trading.lastSync[sym] = today;
      });
    } catch (e) { events.push({ kind: 'error', symbol: sym, error: e.message }); }
  }
}

/** Account value, day change, per-position numbers. */
export function summary(now = Date.now()) {
  const s = store.get(), cash = E.totalCash(s);
  let value = 0, day = 0, prevValue = 0, unreal = 0, cost = 0;
  const rows = [];
  const p0 = etParts(new Date(now)), todayStart = etDate(p0.y, p0.m, p0.d, 0).getTime();
  for (const [sym, p] of Object.entries(s.trading.positions)) {
    if (!p.lots.length) continue;
    const pos = E.position(s, sym), q = quotes.get(sym);
    const px = q?.price ?? pos.avg, prev = q?.previousClose ?? px;
    const mv = pos.qty * px;
    let d = 0;
    for (const l of p.lots) d += l.qty * (px - (l.time < todayStart ? prev : l.price));
    value += mv; day += d; prevValue += mv - d; unreal += mv - pos.cost; cost += pos.cost;
    rows.push({ symbol: sym, name: p.name, qty: pos.qty, avg: pos.avg, price: px, value: mv, cost: pos.cost, unrealized: mv - pos.cost, day: d, hasQuote: !!q });
  }
  const total = cash + value;
  return { cash, settled: s.account.settled, unsettled: s.account.unsettled, positionsValue: value, total, day, dayPct: prevValue + cash ? (day / (total - day)) * 100 : 0, unrealized: unreal, rows: rows.sort((a, b) => b.value - a.value), buyingPower: E.buyingPower(s, now), restricted: E.isRestricted(s, now) };
}

/** Start the loop: poll every 5s while any session is open, every 5 min while closed. */
export function start(getExtra) {
  extraSymbols = getExtra || extraSymbols;
  catchUp().then(() => poll());
  setInterval(() => {
    if (document.hidden) return;
    const open = marketState().session !== SESSION.CLOSED; // 4:00–20:00 ET on trading days
    if (open || Date.now() - lastPoll > 5 * 60000) poll();
    else store.update(s => { E.expire(s, Date.now()); E.settle(s, Date.now()); });
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) catchUp().then(() => poll()); });
  window.addEventListener('online', () => { catchUp().then(() => poll()); });
  window.addEventListener('offline', () => { net.state = 'offline'; notify({ kind: 'net' }); });
}
