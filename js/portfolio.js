// Portfolio tab: Overview (balances, P&L, positions, open orders), Performance (vs S&P 500), History.
import * as store from './store.js';
import * as api from './api.js';
import * as fmt from './format.js';
import * as E from './engine.js';
import * as A from './analytics.js';
import * as trader from './trader.js';
import { createCompareChart } from './chart.js';
import { ymdOf } from './market.js';
import { $, BR, sheet, closeSheet, toast } from './ui.js';

const view = { tab: 'overview', range: 'ALL', hist: 'trades', chart: null };
let ctx = { go: () => {} };
const perf = { key: '', at: 0, series: null, loading: null, error: null };

export function renderPortfolio(main, context) {
  if (context) ctx = context;
  if (view.chart) { view.chart.destroy(); view.chart = null; }
  const tabs = [['overview', 'OVERVIEW'], ['performance', 'PERFORMANCE'], ['history', 'HISTORY']];
  main.innerHTML = `
  <section class="screen">
    <div class="head"><h2 class="w">PORTFOLIO</h2></div>
    <div class="seg ptabs" id="pTabs">${tabs.map(([k, l]) => `<button data-ptab="${k}" class="${view.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="pBody"></div>
  </section>`;
  const body = $('#pBody');
  ({ overview, performance, history })[view.tab](body);
  main.onclick = e => {
    const t = e.target.closest('[data-ptab]');
    if (t) { view.tab = t.dataset.ptab; return renderPortfolio(main); }
    const r = e.target.closest('[data-range]');
    if (r) { view.range = r.dataset.range; return renderPortfolio(main); }
    const h = e.target.closest('[data-hist]');
    if (h) { view.hist = h.dataset.hist; return renderPortfolio(main); }
    const c = e.target.closest('[data-cancel]');
    if (c) return confirmCancel(c.dataset.cancel, main);
    const p = e.target.closest('[data-sym]');
    if (p) { store.update(s => { s.settings.symbol = p.dataset.sym; }); ctx.go('home'); }
  };
}
/** Re-render on live updates, except mid-interaction on the performance chart. */
export function refreshPortfolio(main) { if (view.tab !== 'performance') renderPortfolio(main); }

// ---------------------------------------------------------------- overview
function overview(el) {
  const st = store.get(), sm = trader.summary(), now = Date.now();
  const orders = E.openOrders(st);
  const vio = E.violationsInYear(st, now);
  const totalRet = sm.total - st.account.startingBalance, totalPct = (totalRet / st.account.startingBalance) * 100;
  const realized = A.realizedAll(st), divs = A.dividendsPaid(st);
  const expiry = o => !o.expiresAt ? 'after entry fills' : o.tif === 'gtc' && !o.ext ? 'GTC · until ' + new Date(o.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : o.ext ? (o.ext === 'pre' ? 'pre-market only' : 'after-hours only') : 'Day';
  const trailStop = o => (o.side === 'sell' ? o.hwm - (o.trail.kind === '%' ? o.hwm * o.trail.value / 100 : o.trail.value) : o.lwm + (o.trail.kind === '%' ? o.lwm * o.trail.value / 100 : o.trail.value));
  el.innerHTML = `
    <div class="frame acct">${BR}
      <div class="lbl">Account value</div>
      <div class="big w">${fmt.money(sm.total)}</div>
      <div class="row sub"><span class="${fmt.tone(sm.day)}">${fmt.arrow(sm.day)} ${fmt.signedMoney(sm.day)} (${fmt.pct(sm.dayPct)})</span><span class="lbl">Today</span></div>
    </div>
    ${sm.restricted ? `<div class="msg gfv">⚠ Restricted until ${fmt.day(st.trading.restrictedUntil)}: after ${E.RULES.GFV_LIMIT} good-faith violations, you can only buy with settled cash.</div>` : ''}
    <div class="card">
      <div class="kv"><span class="d">Total return</span><span class="${fmt.tone(totalRet)}">${fmt.signedMoney(totalRet)} (${fmt.pct(totalPct)})</span></div>
      <div class="kv"><span class="d">Open P&amp;L (unrealized)</span><span class="${fmt.tone(sm.unrealized)}">${fmt.signedMoney(sm.unrealized)}</span></div>
      <div class="kv"><span class="d">Closed P&amp;L (realized)</span><span class="${fmt.tone(realized)}">${fmt.signedMoney(realized)}</span></div>
      <div class="kv"><span class="d">Dividends received</span><span class="${divs > 0 ? 'up' : 'w'}">${fmt.money(divs)}</span></div>
    </div>
    <div class="card">
      <div class="kv"><span class="d">Buying power</span><span class="c">${fmt.money(sm.buyingPower)}</span></div>
      <div class="kv"><span class="d">Settled cash</span><span class="w">${fmt.money(sm.settled)}</span></div>
      ${sm.unsettled.map(u => `<div class="kv"><span class="d">Unsettled · settles ${fmt.day(u.settles)}</span><span class="w">${fmt.money(u.amount)}</span></div>`).join('')}
      ${st.trading.divs.pending.map(d => `<div class="kv"><span class="d">Dividend ${fmt.esc(d.symbol)} · pays ~${fmt.day(d.payDate)}</span><span class="up">${fmt.money(d.amount)}</span></div>`).join('')}
      <div class="kv"><span class="d">Good-faith violations (12 mo)</span><span class="${vio ? 'c' : 'w'}">${vio} / ${E.RULES.GFV_LIMIT}</span></div>
    </div>
    <div class="sect">POSITIONS</div>
    <div class="list">${sm.rows.length ? sm.rows.map(r => `
      <button class="item" data-sym="${fmt.esc(r.symbol)}">
        <span class="sym w">${fmt.esc(r.symbol)}</span>
        <span class="mid"><div>${+r.qty.toFixed(3)} sh · avg ${fmt.price(r.avg)}</div><small>${r.hasQuote ? 'last ' + fmt.price(r.price) : 'waiting for price…'}</small></span>
        <span class="rt"><div class="w">${fmt.money(r.value)}</div><small class="${fmt.tone(r.unrealized)}">${fmt.signedMoney(r.unrealized)} (${fmt.pct(r.cost ? r.unrealized / r.cost * 100 : 0)})</small></span>
      </button>`).join('') : '<div class="empty">No positions yet. Find a stock in Search, then tap BUY.</div>'}</div>
    <div class="sect">OPEN ORDERS</div>
    <div class="list">${orders.length ? orders.map(o => `
      <div class="item">
        <span class="mid"><div class="${o.side === 'buy' ? 'up' : 'down'}">${fmt.esc(E.describe(o))}</div><small>${o.status === 'pending' ? 'waits for bracket entry' : expiry(o)}${o.type === 'trailing_stop' ? ` · stop now ${fmt.price(trailStop(o))}` : ''}${o.triggered ? ' · stop triggered' : ''}</small></span>
        <button class="cancel" data-cancel="${o.id}">CANCEL</button>
      </div>`).join('') : '<div class="empty">No open orders.</div>'}</div>`;
}

function confirmCancel(id, main) {
  const o = store.get().trading.orders.find(x => x.id === id);
  if (!o) return;
  sheet(`<h3>CANCEL ORDER</h3><p class="w">${fmt.esc(E.describe(o))}</p>${o.group ? '<p class="d">Linked orders in this group are canceled too.</p>' : ''}
    <div class="btns"><button class="btn" data-close style="border-color:var(--line-hi)">KEEP</button><button class="btn cy" id="doCancel">CANCEL ORDER</button></div>`,
    el => $('#doCancel', el).addEventListener('click', () => { trader.cancel(o.id); closeSheet(); toast('Order canceled.'); renderPortfolio(main); }));
}

// ---------------------------------------------------------------- performance
function performance(el) {
  const st = store.get();
  const trips = A.roundTrips(st), stats = A.tradeStats(trips);
  const ranges = ['1W', '1M', '3M', 'YTD', 'ALL'];
  el.innerHTML = `
    <div class="tf pr">${ranges.map(r => `<button data-range="${r}" class="${r === view.range ? 'on' : ''}">${r}</button>`).join('')}</div>
    <div class="vs" id="pVs"><div class="empty"><span class="spin"></span></div></div>
    <div class="cmp" id="pChart"></div>
    <div class="legend2"><span><i class="ln cy"></i>You</span><span><i class="ln wh"></i>S&amp;P 500 (SPY)</span><span class="d">incl. dividends</span></div>
    <div class="sect">YOUR TRADES</div>
    <div class="card">
      <div class="kv"><span class="d">Closed positions</span><span class="w">${stats.closed}</span></div>
      <div class="kv"><span class="d">Win rate</span><span class="w">${stats.winRate == null ? '—' : `${stats.winRate.toFixed(0)}% <span class="d">(${stats.wins}W / ${stats.losses}L)</span>`}</span></div>
      <div class="kv"><span class="d">Average win</span><span class="${stats.wins ? 'up' : 'w'}">${stats.wins ? fmt.signedMoney(stats.avgWin) : '—'}</span></div>
      <div class="kv"><span class="d">Average loss</span><span class="${stats.losses ? 'down' : 'w'}">${stats.losses ? fmt.signedMoney(stats.avgLoss) : '—'}</span></div>
      <div class="kv"><span class="d">Best</span><span class="${stats.best ? fmt.tone(stats.best.realized) : 'w'}">${stats.best ? `${fmt.esc(stats.best.symbol)} ${fmt.signedMoney(stats.best.realized)}` : '—'}</span></div>
      <div class="kv"><span class="d">Worst</span><span class="${stats.worst ? fmt.tone(stats.worst.realized) : 'w'}">${stats.worst ? `${fmt.esc(stats.worst.symbol)} ${fmt.signedMoney(stats.worst.realized)}` : '—'}</span></div>
      <div class="kv"><span class="d">Average time held</span><span class="w">${stats.avgHoldDays == null ? '—' : holdText(stats.avgHoldDays)}</span></div>
    </div>
    ${stats.closed ? '' : '<div class="empty">Win rate counts positions you have fully sold. It appears after your first closed position.</div>'}`;
  view.chart = createCompareChart($('#pChart', el));
  loadPerf().then(() => drawPerf(el)).catch(e => { const v = $('#pVs', el); if (v) v.innerHTML = `<div class="empty">Couldn't load performance history: ${fmt.esc(e.message)}</div>`; });
}

function holdText(d) { return d < 1 ? `${Math.max(1, Math.round(d * 24))} h` : `${d.toFixed(d < 10 ? 1 : 0)} days`; }

async function loadPerf() {
  const st = store.get();
  const syms = [...new Set(st.trading.fills.map(f => f.symbol))].sort();
  const key = syms.join(',') + ':' + st.trading.fills.length + ':' + st.account.createdAt;
  if (perf.series && perf.key === key && Date.now() - perf.at < 10 * 60e3) return;
  if (perf.loading && perf.key === key) return perf.loading;
  perf.key = key;
  perf.loading = (async () => {
    const from = st.account.createdAt / 1000 - 14 * 86400, to = Date.now() / 1000;
    const get = async sym => { const d = await api.chartPeriod(sym, '1d', from, to); return d.bars.map(b => [b[0], b[4]]); };
    // S&P 500 as total return: SPY closes with its dividends reinvested (fair vs your account, which counts dividends)
    const spy = await api.chartPeriod('SPY', '1d', from, to, { events: true });
    const calendar = A.totalReturnIndex(spy.bars.map(b => [b[0], b[4]]), spy.dividends || []);
    const closes = {};
    for (let i = 0; i < syms.length; i += 4) {
      const part = syms.slice(i, i + 4);
      const res = await Promise.all(part.map(get));
      part.forEach((s, j) => { closes[s] = res[j]; });
    }
    perf.series = A.equitySeries(store.get(), closes, calendar);
    perf.at = Date.now();
  })().finally(() => { perf.loading = null; });
  return perf.loading;
}

function drawPerf(el) {
  const vs = $('#pVs', el); if (!vs || !view.chart) return;
  const st = store.get();
  const series = (perf.series || []).map(p => ({ ...p }));
  // today's point uses live numbers
  const today = ymdOf(Date.now()), last = series.at(-1), spyQ = trader.getQuote('SPY');
  if (last && last.day === today) { last.value = trader.summary().total; if (spyQ && last.spyPx) last.spy = last.spy * spyQ.price / last.spyPx; }
  if (!series.length) { vs.innerHTML = '<div class="empty">Your performance line starts after your first market day. Check back after the next close.</div>'; return; }
  const c = A.compare(series, A.rangeStart(view.range, Date.now(), st.account.createdAt), st.account.startingBalance);
  view.chart.setData(c.you, c.spy);
  const diff = c.youPct - c.spyPct;
  vs.innerHTML = `
    <div class="vs-row">
      <div><div class="lbl">You</div><div class="vbig ${fmt.tone(c.youPct)}">${fmt.pct(c.youPct)}</div></div>
      <div class="r"><div class="lbl">S&amp;P 500</div><div class="vbig ${fmt.tone(c.spyPct)}">${fmt.pct(c.spyPct)}</div></div>
    </div>
    <div class="vs-diff ${fmt.tone(diff)}">${Math.abs(diff) < 0.005 ? 'Even with the S&P 500' : `${Math.abs(diff).toFixed(2)} pts ${diff > 0 ? 'ahead of' : 'behind'} the S&P 500`} · ${view.range === 'ALL' ? 'since you started' : view.range}</div>`;
}

// ---------------------------------------------------------------- history
function history(el) {
  const st = store.get();
  const tabs = [['trades', 'CLOSED'], ['fills', 'ALL FILLS'], ['activity', 'ACTIVITY']];
  const dt = t => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' });
  let list = '';
  if (view.hist === 'trades') {
    const trips = A.roundTrips(st);
    list = trips.length ? trips.map(t => `
      <button class="item" data-sym="${fmt.esc(t.symbol)}">
        <span class="sym w">${fmt.esc(t.symbol)}</span>
        <span class="mid"><div>${new Date(t.opened).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} → ${new Date(t.closed).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div><small>held ${holdText(t.holdDays)} · cost ${fmt.money(t.bought)}</small></span>
        <span class="rt"><div class="${fmt.tone(t.realized)}">${fmt.signedMoney(t.realized)}</div><small class="${fmt.tone(t.realized)}">${fmt.pct(t.returnPct)}</small></span>
      </button>`).join('') : '<div class="empty">No closed positions yet. A position closes when you sell all of its shares.</div>';
  } else if (view.hist === 'fills') {
    list = st.trading.fills.length ? st.trading.fills.map(f => `
      <div class="item act">
        <span class="mid"><div><span class="${f.side === 'buy' ? 'up' : 'down'}">${f.side === 'buy' ? 'Bought' : 'Sold'}</span> ${+f.qty.toFixed(3)} <b class="w">${fmt.esc(f.symbol)}</b> at ${fmt.price(f.price)}${f.gfv ? ' <span class="c">· GFV</span>' : ''}</div><small>${dt(f.time)} · ${E.TYPES[f.type] || 'Market'}${f.fees ? ` · fees ${fmt.money(f.fees)}` : ''}</small></span>
        <span class="rt"><div class="w">${fmt.money(f.side === 'sell' ? f.net ?? f.amount : f.amount)}</div>${f.realized != null ? `<small class="${fmt.tone(f.realized)}">${fmt.signedMoney(f.realized)}</small>` : ''}</span>
      </div>`).join('') : '<div class="empty">No trades yet.</div>';
  } else {
    list = st.trading.activity.slice(0, 150).map(a => `
      <div class="item act"><span class="mid"><div>${activityText(a)}</div><small>${dt(a.time)}</small></span></div>`).join('') || '<div class="empty">Nothing yet.</div>';
  }
  el.innerHTML = `<div class="seg sm hs">${tabs.map(([k, l]) => `<button data-hist="${k}" class="${view.hist === k ? 'on' : ''}">${l}</button>`).join('')}</div><div class="list">${list}</div>`;
}

export function activityText(a) {
  const sym = a.symbol ? `<b class="w">${fmt.esc(a.symbol)}</b> ` : '';
  switch (a.kind) {
    case 'filled': return `<span class="${a.side === 'buy' ? 'up' : 'down'}">${a.side === 'buy' ? 'Bought' : 'Sold'}</span> ${+a.qty.toFixed(3)} ${sym}at ${fmt.price(a.price)}${a.realized != null ? ` · <span class="${fmt.tone(a.realized)}">${fmt.signedMoney(a.realized)}</span>` : ''}`;
    case 'placed': return `Placed: ${fmt.esc(a.text)}`;
    case 'canceled': return `Canceled: ${fmt.esc(a.text)}`;
    case 'expired': return `Expired: ${fmt.esc(a.text)}`;
    case 'rejected': return `Rejected: ${fmt.esc(a.text)} <span class="d">(${fmt.esc(a.reason)})</span>`;
    case 'dividend': return `<span class="up">Dividend paid</span> ${sym}${fmt.money(a.amount)}`;
    case 'gfv': case 'restricted': return `<span class="c">⚠ ${fmt.esc(a.text)}</span>`;
    default: return fmt.esc(a.text || a.kind);
  }
}
