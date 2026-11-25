import * as store from './store.js';
import * as api from './api.js';
import * as fmt from './format.js';
import { marketState, SESSION } from './market.js';
import { createCandleChart, TIMEFRAMES, INTERVAL_LABEL } from './chart.js';
import { CHART_REFRESH_MS, DEFAULT_SYMBOL, MIN_BALANCE, MAX_BALANCE, APP_VERSION, RELAY_URL } from './config.js';
import * as E from './engine.js';
import * as trader from './trader.js';
import { openTicket } from './ticket.js';
import { $, BR, sheet, closeSheet, toast } from './ui.js';

const app = $('#app');
const ui = { tab: 'home', sub: null, chart: null, meta: null, lastChartLoad: 0 };

// ---------------------------------------------------------------- boot
let started = false;
function boot() {
  if (!store.get().account) return renderOnboarding();
  renderShell();
  if (started) return;
  started = true;
  startClock();
  trader.onUpdate(onTraderUpdate);
  trader.start(() => [symbol()]);
}

function onTraderUpdate(ev) {
  if (ui.tab === 'home') {
    renderQuote(); renderAccount();
    const q = trader.getQuote(symbol());
    if (q) ui.chart?.live(q);
    if (ev.kind === 'quotes' && marketState().session !== SESSION.CLOSED && Date.now() - ui.lastChartLoad > CHART_REFRESH_MS) loadChart();
  }
  if (ui.tab === 'portfolio' && !document.querySelector('.scrim')) renderPortfolio($('#main'));
  const fills = ev.kind === 'quotes' ? ev.fills : ev.kind === 'catchup' ? ev.events.filter(x => x.kind === 'fill').map(x => x.fill) : [];
  const splitCancels = ev.kind === 'catchup' ? ev.events.filter(x => x.kind === 'split' && x.canceled?.length) : [];
  if (splitCancels.length) {
    const x = splitCancels[0];
    return toast(`${x.symbol} had a ${x.numerator}-for-${x.denominator} stock split. ${x.canceled.length} open order(s) were canceled; see Portfolio → Activity to re-enter them.`, 7000);
  }
  if (fills?.length) {
    const f = fills[0];
    toast(`${fills.length > 1 ? fills.length + ' orders filled. ' : ''}${f.side === 'buy' ? 'Bought' : 'Sold'} ${+f.qty.toFixed(3)} ${f.symbol} at $${fmt.price(f.price)}${ev.kind === 'catchup' ? ' while the app was closed' : ''}.`, 5000);
  }
}

// ---------------------------------------------------------------- onboarding
function renderOnboarding() {
  app.innerHTML = `
  <div class="onb">
    <img src="icons/apple-touch-icon.png" alt="">
    <h1 class="w">LEARN PAPER TRADING</h1>
    <div class="tag-line">Practice investing with pretend money and real market prices.</div>
    <div class="card">
      <p><b class="c">› NOT FINANCIAL ADVICE</b></p>
      <p>This is a simulator for learning. No real money is used and nothing here tells you what to buy or sell.
      Prices come from Yahoo Finance and can be delayed or wrong. Your data stays on this phone only.</p>
    </div>
    <div class="lbl">Starting balance</div>
    <label class="field"><span class="pre">$</span><input id="bal" inputmode="decimal" autocomplete="off" placeholder="10,000" aria-label="Starting balance"></label>
    <div class="hint" id="balHint">Any amount you like. You set this once.</div>
    <button class="btn cy" id="start" disabled>START TRADING</button>
  </div>`;
  const input = $('#bal'), hint = $('#balHint'), btn = $('#start');
  const parse = () => { const v = parseFloat(input.value.replace(/[$,\s]/g, '')); return isFinite(v) ? Math.round(v * 100) / 100 : NaN; };
  input.addEventListener('input', () => {
    const v = parse(), ok = v >= MIN_BALANCE && v <= MAX_BALANCE;
    btn.disabled = !ok;
    hint.className = 'hint' + (input.value && !ok ? ' err' : '');
    hint.textContent = !input.value ? 'Any amount you like. You set this once.'
      : ok ? `You'll start with ${fmt.money(v)} in cash.` : v > MAX_BALANCE ? `That's too large to track to the cent (max ${fmt.money(MAX_BALANCE)}).` : 'Enter an amount above $0.';
  });
  btn.addEventListener('click', () => {
    const v = parse();
    sheet(`<h3>CONFIRM STARTING BALANCE</h3>
      <p>Start with <b class="w">${fmt.money(v)}</b>? This can't be changed later. Only a full reset (which wipes everything) lets you pick again.</p>
      <div class="btns"><button class="btn" data-close style="border-color:var(--line-hi)">BACK</button><button class="btn cy" id="ok">START</button></div>`,
      el => $('#ok', el).addEventListener('click', () => { closeSheet(); store.createAccount(v); boot(); }));
  });
}

// ---------------------------------------------------------------- shell
function renderShell() {
  app.innerHTML = `
    <div class="status" id="status"></div>
    <main id="main"></main>
    <nav id="nav">
      <button data-tab="home">◈ HOME</button><button data-tab="search">⌕ SEARCH</button>
      <button data-tab="portfolio">▤ PORTFOLIO</button><button data-tab="menu">≡ MENU</button>
    </nav>`;
  $('#nav').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab); });
  go('home');
}

function go(tab, sub = null) {
  ui.tab = tab; ui.sub = sub;
  document.querySelectorAll('#nav [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  if (ui.chart) { ui.chart.destroy(); ui.chart = null; }
  const main = $('#main');
  main.onclick = null;
  ({ home: renderHome, search: renderSearch, portfolio: renderPortfolio, menu: renderMenu })[tab](main);
  main.scrollTop = 0;
}

const symbol = () => store.get().settings.symbol || DEFAULT_SYMBOL;
const timeframe = () => store.get().settings.range || '1D';
const interval = () => { const tf = TIMEFRAMES[timeframe()], saved = store.get().settings.intervals[timeframe()]; return tf.intervals.includes(saved) ? saved : tf.def; };

// ---------------------------------------------------------------- home
function renderHome(main) {
  main.innerHTML = `
  <section class="screen">
    <div class="frame acct">${BR}
      <div class="lbl">Account value</div>
      <div class="big w" id="acctVal">${fmt.money(trader.summary().total)}</div>
      <div class="row sub"><span class="flat" id="dayPl">■ ${fmt.signedMoney(0)} (${fmt.pct(0)})</span><span class="lbl">Today</span></div>
    </div>
    <div class="frame chartbox">${BR}
      <div class="row">
        <div><button class="tk w" id="tkBtn">${fmt.esc(symbol())}<span class="caret">▾</span></button><div class="nm" id="tkName">&nbsp;</div></div>
        <div class="px"><div id="pxMain" class="w">—</div><div class="chg" id="pxChg">&nbsp;</div></div>
      </div>
      <div class="ext" id="pxExt"></div>
      <div class="legend" id="legend"></div>
      <div class="chart" id="chart"></div>
      <div class="tf" id="tf">
        ${Object.keys(TIMEFRAMES).map(k => `<button data-tf="${k}" class="${k === timeframe() ? 'on' : ''}">${k}</button>`).join('')}
        <button class="iv" id="ivBtn" aria-label="Candle size">${interval()} ▾</button>
      </div>
    </div>
    <div class="btns"><button class="btn buy" id="buy">BUY</button><button class="btn sell" id="sell">SELL</button></div>
    <div id="tipSlot"></div>
  </section>`;

  $('#tkBtn').addEventListener('click', () => go('search'));
  $('#tf').addEventListener('click', e => {
    const b = e.target.closest('[data-tf]'); if (!b) return;
    store.update(s => { s.settings.range = b.dataset.tf; });
    $('#tf').querySelectorAll('[data-tf]').forEach(x => x.classList.toggle('on', x === b));
    $('#ivBtn').textContent = interval() + ' ▾';
    loadChart();
  });
  $('#ivBtn').addEventListener('click', () => {
    const tf = TIMEFRAMES[timeframe()];
    sheet(`<h3>CANDLE SIZE · ${timeframe()}</h3>${tf.intervals.map(i => `<button class="opt ${i === interval() ? 'on' : ''}" data-iv="${i}">${INTERVAL_LABEL[i]}</button>`).join('')}`,
      el => el.addEventListener('click', e => {
        const b = e.target.closest('[data-iv]'); if (!b) return;
        store.update(s => { s.settings.intervals[timeframe()] = b.dataset.iv; });
        closeSheet(); $('#ivBtn').textContent = interval() + ' ▾'; loadChart();
      }));
  });
  $('#buy').addEventListener('click', () => {
    const q = trader.getQuote(symbol());
    if (q?.type && q.type !== 'EQUITY') return toast(`${symbol()} is an ${q.type === 'ETF' ? 'ETF' : 'fund'}. This app trades individual stocks only.`);
    openTicket({ symbol: symbol(), name: q?.name || ui.meta?.name, side: 'buy' });
  });
  $('#sell').addEventListener('click', () => {
    if (E.position(store.get(), symbol()).qty <= 0) return toast(`You don't own any ${symbol()}. This is a cash account, so you can only sell shares you own.`);
    openTicket({ symbol: symbol(), name: trader.getQuote(symbol())?.name || ui.meta?.name, side: 'sell' });
  });

  renderTip();
  ui.chart = createCandleChart($('#chart'), { onHover: showLegend });
  renderQuote(); renderAccount();
  loadChart();
  trader.freshQuote(symbol());
}

function renderAccount() {
  const el = $('#acctVal'); if (!el) return;
  const sm = trader.summary();
  el.textContent = fmt.money(sm.total);
  const d = $('#dayPl');
  d.className = fmt.tone(sm.day);
  d.textContent = `${fmt.arrow(sm.day)} ${fmt.signedMoney(sm.day)} (${fmt.pct(sm.dayPct)})`;
}

function showLegend(d) {
  const el = $('#legend'); if (!el) return;
  el.innerHTML = d ? `O <b>${fmt.price(d.open)}</b> H <b>${fmt.price(d.high)}</b> L <b>${fmt.price(d.low)}</b> C <b class="${d.close >= d.open ? 'up' : 'down'}">${fmt.price(d.close)}</b>`
    : `<span>Touch the chart to read any candle</span>`;
}

function chartMsg(html) {
  const box = $('#chart'); if (!box) return;
  box.querySelector('.chart-msg')?.remove();
  if (html) box.insertAdjacentHTML('beforeend', `<div class="chart-msg"><div>${html}</div></div>`);
}

let chartSeq = 0;
async function loadChart() {
  if (!ui.chart) return;
  const seq = ++chartSeq, sym = symbol(), tf = TIMEFRAMES[timeframe()], iv = interval();
  showLegend(null);
  chartMsg('<span class="spin"></span>');
  try {
    const data = await api.chart(sym, tf.range, iv, tf.prepost);
    if (seq !== chartSeq || !ui.chart) return;
    ui.meta = data.meta; ui.lastChartLoad = Date.now();
    $('#tkName').textContent = data.meta.name || '';
    if (!data.bars.length) return chartMsg('No price data for this timeframe.');
    ui.chart.setData(data.bars, iv);
    chartMsg(null);
    const q = trader.getQuote(sym);
    if (q) ui.chart.live(q);
  } catch (e) {
    if (seq !== chartSeq) return;
    if (e.code === 'NO_RELAY') chartMsg(`The data relay isn't set up yet.<br><button id="setRelay">SET UP DATA RELAY</button>`);
    else chartMsg(`Couldn't load the chart.<br><span class="d">${fmt.esc(e.message)}</span><br><button id="retry">RETRY</button>`);
    $('#setRelay')?.addEventListener('click', () => go('menu', 'relay'));
    $('#retry')?.addEventListener('click', loadChart);
  }
}

function renderQuote() {
  const q = trader.getQuote(symbol()); if (!q || q.error || !$('#pxMain')) return;
  const chg = q.price - q.previousClose, chgPct = q.previousClose ? (chg / q.previousClose) * 100 : 0;
  $('#pxMain').textContent = fmt.price(q.price);
  const c = $('#pxChg'); c.className = 'chg ' + fmt.tone(chg); c.textContent = `${fmt.arrow(chg)} ${Math.abs(chg).toFixed(2)} ${fmt.pct(chgPct)}`;
  if (q.name) $('#tkName').textContent = q.name;
  const ext = $('#pxExt');
  if (q.extended && q.last != null && Math.abs(q.last - q.price) > 1e-9) {
    const fresh = q.lastTime > q.regularTime; // an extended-hours trade newer than the last regular close
    const label = isPreMarket(q) ? 'PRE-MARKET' : 'AFTER-HOURS';
    const d = q.last - q.price, dp = q.price ? (d / q.price) * 100 : 0;
    ext.innerHTML = fresh ? `<span class="d">${label}</span> <span class="w">${fmt.price(q.last)}</span> <span class="${fmt.tone(d)}">${fmt.pct(dp)}</span>` : '';
  } else ext.innerHTML = '';
}
const isPreMarket = q => { const s = marketState(new Date(q.lastTime * 1000)).session; return s === SESSION.PRE; };

function startClock() {
  const tick = () => {
    const el = $('#status'); if (!el) return;
    const now = new Date(), m = marketState(now), open = m.session !== SESSION.CLOSED;
    const left = m.next - now;
    const when = left < 24 * 3600e3 ? `${m.nextLabel.toUpperCase()} ${fmt.countdown(left)}` : `PRE-MKT ${fmt.etWhen(m.next)}`;
    const name = m.holiday ? `CLOSED · ${m.holiday.toUpperCase()}` : m.label.toUpperCase() + (m.early && open ? ' · EARLY CLOSE' : '');
    el.innerHTML = `<span class="${open ? 'c' : 'closed'}"><span class="dot"></span>${name}</span><span class="d">${when}</span>`;
  };
  tick(); setInterval(tick, 1000);
}

// ---------------------------------------------------------------- search
function renderSearch(main) {
  main.innerHTML = `
  <section class="screen">
    <div class="head"><h2 class="w">SEARCH</h2></div>
    <label class="field"><span class="pre">⌕</span><input id="q" type="search" placeholder="Company name or ticker" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="search"></label>
    <div id="results"></div>
  </section>`;
  const input = $('#q'), out = $('#results');
  const showRecent = () => {
    const r = store.get().recentSearches;
    out.innerHTML = r.length ? `<div class="sect">RECENT</div><div class="list">${r.map(itemHtml).join('')}</div>`
      : `<div class="empty">Type a company name (like “apple”) or a ticker symbol (like “AAPL”).<br>Results include US-listed stocks.</div>`;
  };
  let timer, seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return showRecent();
    out.innerHTML = `<div class="empty"><span class="spin"></span></div>`;
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const res = await api.search(q);
        if (my !== seq) return;
        const stocks = res.results.filter(r => r.type === 'EQUITY'); // stocks only (no ETFs, funds, futures)
        out.innerHTML = stocks.length ? `<div class="list">${stocks.map(itemHtml).join('')}</div>` : `<div class="empty">No US stocks match “${fmt.esc(q)}”.</div>`;
      } catch (e) {
        if (my !== seq) return;
        out.innerHTML = e.code === 'NO_RELAY' ? `<div class="empty">Search needs the data relay.<br><br><button class="btn cy" id="setRelay">SET UP DATA RELAY</button></div>`
          : `<div class="empty">Search failed: ${fmt.esc(e.message)}</div>`;
        $('#setRelay')?.addEventListener('click', () => go('menu', 'relay'));
      }
    }, 300);
  });
  out.addEventListener('click', e => {
    const b = e.target.closest('[data-sym]'); if (!b) return;
    store.addRecent({ symbol: b.dataset.sym, name: b.dataset.name, exchange: b.dataset.ex, type: b.dataset.type });
    store.update(s => { s.settings.symbol = b.dataset.sym; });
    go('home');
  });
  showRecent();
  setTimeout(() => input.focus(), 50);
}
const itemHtml = r => `<button class="item" data-sym="${fmt.esc(r.symbol)}" data-name="${fmt.esc(r.name)}" data-ex="${fmt.esc(r.exchange || '')}" data-type="${fmt.esc(r.type || '')}">
  <span class="sym w">${fmt.esc(r.symbol)}</span><span class="mid"><div>${fmt.esc(r.name)}</div><small>${fmt.esc(r.exchange || '')}</small></span></button>`;

// ---------------------------------------------------------------- portfolio (Phase 4 adds P&L history, win rate, S&P 500)
function renderPortfolio(main) {
  const st = store.get(), sm = trader.summary(), now = Date.now();
  const orders = E.openOrders(st);
  const pendDiv = st.trading.divs.pending;
  const vio = E.violationsInYear(st, now);
  const expiry = o => !o.expiresAt ? 'after entry fills' : o.tif === 'gtc' && !o.ext ? 'GTC · until ' + new Date(o.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : o.ext ? (o.ext === 'pre' ? 'pre-market only' : 'after-hours only') : 'Day';
  main.innerHTML = `
  <section class="screen">
    <div class="head"><h2 class="w">PORTFOLIO</h2></div>
    <div class="frame acct">${BR}
      <div class="lbl">Account value</div>
      <div class="big w">${fmt.money(sm.total)}</div>
      <div class="row sub"><span class="${fmt.tone(sm.day)}">${fmt.arrow(sm.day)} ${fmt.signedMoney(sm.day)} (${fmt.pct(sm.dayPct)})</span><span class="lbl">Today</span></div>
    </div>
    ${sm.restricted ? `<div class="msg gfv">⚠ Restricted until ${fmt.day(st.trading.restrictedUntil)}: after ${E.RULES.GFV_LIMIT} good-faith violations, you can only buy with settled cash.</div>` : ''}
    <div class="card">
      <div class="kv"><span class="d">Buying power</span><span class="c">${fmt.money(sm.buyingPower)}</span></div>
      <div class="kv"><span class="d">Settled cash</span><span class="w">${fmt.money(sm.settled)}</span></div>
      ${sm.unsettled.map(u => `<div class="kv"><span class="d">Unsettled · settles ${fmt.day(u.settles)}</span><span class="w">${fmt.money(u.amount)}</span></div>`).join('')}
      ${pendDiv.map(d => `<div class="kv"><span class="d">Dividend ${fmt.esc(d.symbol)} · pays ~${fmt.day(d.payDate)}</span><span class="up">${fmt.money(d.amount)}</span></div>`).join('')}
      <div class="kv"><span class="d">Good-faith violations (12 mo)</span><span class="${vio ? 'c' : 'w'}">${vio} / ${E.RULES.GFV_LIMIT}</span></div>
    </div>
    <div class="sect">POSITIONS</div>
    <div class="list">${sm.rows.length ? sm.rows.map(r => `
      <button class="item" data-sym="${fmt.esc(r.symbol)}">
        <span class="sym w">${fmt.esc(r.symbol)}</span>
        <span class="mid"><div>${+r.qty.toFixed(3)} sh · avg ${fmt.price(r.avg)}</div><small>${r.hasQuote ? 'last ' + fmt.price(r.price) : 'waiting for price…'}</small></span>
        <span class="rt"><div class="w">${fmt.money(r.value)}</div><small class="${fmt.tone(r.unrealized)}">${fmt.signedMoney(r.unrealized)}</small></span>
      </button>`).join('') : '<div class="empty">No positions yet. Find a stock in Search, then tap BUY.</div>'}</div>
    <div class="sect">OPEN ORDERS</div>
    <div class="list">${orders.length ? orders.map(o => `
      <div class="item">
        <span class="mid"><div class="${o.side === 'buy' ? 'up' : 'down'}">${fmt.esc(E.describe(o))}</div><small>${o.status === 'pending' ? 'waits for bracket entry' : expiry(o)}${o.type === 'trailing_stop' ? ` · stop now ${fmt.price(o.side === 'sell' ? o.hwm - (o.trail.kind === '%' ? o.hwm * o.trail.value / 100 : o.trail.value) : o.lwm + (o.trail.kind === '%' ? o.lwm * o.trail.value / 100 : o.trail.value))}` : ''}${o.triggered ? ' · stop triggered' : ''}</small></span>
        <button class="cancel" data-cancel="${o.id}">CANCEL</button>
      </div>`).join('') : '<div class="empty">No open orders.</div>'}</div>
    <div class="sect">ACTIVITY</div>
    <div class="list">${st.trading.activity.slice(0, 15).map(a => `
      <div class="item act"><span class="mid"><div>${activityText(a)}</div><small>${new Date(a.time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small></span></div>`).join('') || '<div class="empty">Nothing yet.</div>'}</div>
    <div class="empty">P&amp;L history, win rate and the S&amp;P 500 comparison arrive in Phase 4.</div>
  </section>`;
  main.onclick = e => {
    const c = e.target.closest('[data-cancel]');
    if (c) {
      const o = st.trading.orders.find(x => x.id === c.dataset.cancel);
      return sheet(`<h3>CANCEL ORDER</h3><p class="w">${fmt.esc(E.describe(o))}</p>${o.group ? '<p class="d">Linked orders in this group are canceled too.</p>' : ''}
        <div class="btns"><button class="btn" data-close style="border-color:var(--line-hi)">KEEP</button><button class="btn cy" id="doCancel">CANCEL ORDER</button></div>`,
        el => $('#doCancel', el).addEventListener('click', () => { trader.cancel(o.id); closeSheet(); toast('Order canceled.'); renderPortfolio(main); }));
    }
    const p = e.target.closest('[data-sym]');
    if (p) { store.update(s => { s.settings.symbol = p.dataset.sym; }); go('home'); }
  };
}

function activityText(a) {
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

// ---------------------------------------------------------------- menu
function renderMenu(main) {
  if (ui.sub === 'relay') return renderRelay(main);
  if (ui.sub === 'about') return renderAbout(main);
  const connected = !!api.relayUrl();
  main.innerHTML = `
  <section class="screen">
    <div class="head"><h2 class="w">MENU</h2></div>
    <div class="list">
      <button class="item" data-sub="relay"><span class="mid"><div class="w">Data relay</div><small>${connected ? 'Connected to your Cloudflare Worker' : 'Not set up — needed for live prices'}</small></span><span class="${connected ? 'c' : 'd'}">${connected ? '●' : '○'}</span></button>
      <button class="item" data-sub="about"><span class="mid"><div class="w">About &amp; disclaimer</div><small>Not financial advice · credits</small></span><span class="d">›</span></button>
    </div>
    <div class="empty">Reset, import and export arrive in Phase 4.<br>v${APP_VERSION}</div>
  </section>`;
  main.onclick = e => { const b = e.target.closest('[data-sub]'); if (b) go('menu', b.dataset.sub); };
}

function renderRelay(main) {
  const cur = store.get().settings.relayUrl || RELAY_URL;
  main.innerHTML = `
  <section class="screen">
    <button class="back" id="back">‹ MENU</button>
    <div class="head"><h2 class="w">DATA RELAY</h2></div>
    <div class="card"><p>Prices come from Yahoo Finance through your own free Cloudflare Worker. Paste its address below (it looks like <span class="w">https://lpt-relay.&lt;you&gt;.workers.dev</span>).</p></div>
    <label class="field"><input id="relay" type="url" inputmode="url" placeholder="https://…workers.dev" value="${fmt.esc(cur)}" autocapitalize="off" spellcheck="false"></label>
    <div class="btns" style="grid-template-columns:1fr"><button class="btn cy" id="save">SAVE &amp; TEST</button></div>
    <div class="card" id="relayResult" hidden></div>
  </section>`;
  $('#back').addEventListener('click', () => go('menu'));
  $('#save').addEventListener('click', async () => {
    let v = $('#relay').value.trim().replace(/\/+$/, '');
    const local = /^(http:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?$/i.test(v);
    if (v && local && !/^http:/i.test(v)) v = 'http://' + v;
    else if (v && !local && !/^https:\/\//i.test(v)) v = 'https://' + v.replace(/^http:\/\//i, '');
    store.update(s => { s.settings.relayUrl = v; });
    const out = $('#relayResult'); out.hidden = false;
    if (!v) { out.innerHTML = 'Relay address cleared.'; return; }
    out.innerHTML = '<span class="spin"></span> Testing…';
    try {
      const r = await api.quotes([DEFAULT_SYMBOL]);
      const q = r.quotes[DEFAULT_SYMBOL];
      out.innerHTML = q && !q.error ? `<span class="c">● CONNECTED</span><br>${DEFAULT_SYMBOL} last price: <span class="w">${fmt.price(q.price)}</span>` : `Relay answered, but with an error: ${fmt.esc(q?.error || 'unknown')}`;
    } catch (e) { out.innerHTML = `<span class="c">⚠ Couldn't connect.</span><br>${fmt.esc(e.message)}. Check the address and that the Worker is deployed.`; }
  });
}

function renderAbout(main) {
  main.innerHTML = `
  <section class="screen">
    <button class="back" id="back">‹ MENU</button>
    <div class="head"><h2 class="w">ABOUT</h2></div>
    <div class="card">
      <p><b class="c">› NOT FINANCIAL ADVICE</b></p>
      <p>Learn Paper Trading is an educational simulator. All money is pretend. Nothing in this app — including charts, indicators,
      tips or recaps — is a recommendation to buy, sell or hold any security. Market data comes from Yahoo Finance via an unofficial
      endpoint and may be delayed, incomplete or wrong. Simulated fills will differ from real ones.</p>
      <p>All your data is stored only on this device.</p>
    </div>
    <div class="card">
      <p>Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView</a> Lightweight Charts™ (Apache 2.0).<br>
      Font: JetBrains Mono (SIL OFL 1.1).</p>
      <p class="d">Version ${APP_VERSION}</p>
    </div>
  </section>`;
  $('#back').addEventListener('click', () => go('menu'));
}

// ---------------------------------------------------------------- tips (Phase 5 replaces this with the full hint system)
const STARTER_TIPS = [
  { id: 'candles', text: 'Green candle = price closed higher than it opened. Red = lower.' },
  { id: 'search', text: 'Tap the ticker above the chart to look up any US stock.' },
  { id: 'touch', text: 'Touch and drag on the chart to read any candle’s open, high, low and close.' },
];
function renderTip() {
  const slot = $('#tipSlot'); if (!slot) return;
  const t = STARTER_TIPS.find(x => !store.get().dismissedTips[x.id]);
  slot.innerHTML = t ? `<div class="tip"><span class="c">› TIP</span> ${t.text}<button class="x" aria-label="Dismiss tip">✕</button></div>` : '';
  slot.querySelector('.x')?.addEventListener('click', () => { store.update(s => { s.dismissedTips[t.id] = Date.now(); }); renderTip(); });
}

// ---------------------------------------------------------------- service worker
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

boot();
