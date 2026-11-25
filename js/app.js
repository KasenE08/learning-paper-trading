import * as store from './store.js';
import * as api from './api.js';
import * as fmt from './format.js';
import { marketState, SESSION } from './market.js';
import { createCandleChart, TIMEFRAMES, INTERVAL_LABEL } from './chart.js';
import { REFRESH_MS, CHART_REFRESH_MS, DEFAULT_SYMBOL, MIN_BALANCE, MAX_BALANCE, APP_VERSION, RELAY_URL } from './config.js';

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const BR = '<i class="br tl"></i><i class="br tr"></i><i class="br bl"></i><i class="br brr"></i>';

const ui = { tab: 'home', sub: null, chart: null, quote: null, meta: null, chartErr: null, loading: false, lastChartLoad: 0 };

// ---------------------------------------------------------------- boot
function boot() {
  if (!store.get().account) return renderOnboarding();
  renderShell();
  startClock();
  startPolling();
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
    <div class="hint" id="balHint">Any amount from ${fmt.money(MIN_BALANCE)} to ${fmt.money(MAX_BALANCE)}. You set this once.</div>
    <button class="btn cy" id="start" disabled>START TRADING</button>
  </div>`;
  const input = $('#bal'), hint = $('#balHint'), btn = $('#start');
  const parse = () => { const v = parseFloat(input.value.replace(/[$,\s]/g, '')); return isFinite(v) ? Math.round(v * 100) / 100 : NaN; };
  input.addEventListener('input', () => {
    const v = parse(), ok = v >= MIN_BALANCE && v <= MAX_BALANCE;
    btn.disabled = !ok;
    hint.className = 'hint' + (input.value && !ok ? ' err' : '');
    hint.textContent = !input.value ? `Any amount from ${fmt.money(MIN_BALANCE)} to ${fmt.money(MAX_BALANCE)}. You set this once.`
      : ok ? `You'll start with ${fmt.money(v)} in cash.` : `Enter between ${fmt.money(MIN_BALANCE)} and ${fmt.money(MAX_BALANCE)}.`;
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
  const acct = store.get().account;
  main.innerHTML = `
  <section class="screen">
    <div class="frame acct">${BR}
      <div class="lbl">Account value</div>
      <div class="big w" id="acctVal">${fmt.money(acct.cash)}</div>
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
  const soon = () => toast('Placing orders arrives in Phase 3 (trading engine).');
  $('#buy').addEventListener('click', soon);
  $('#sell').addEventListener('click', soon);

  renderTip();
  ui.chart = createCandleChart($('#chart'), { onHover: showLegend });
  if (ui.quote && ui.quote.symbol === symbol()) renderQuote();
  loadChart();
  refreshQuote();
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
    if (ui.quote && ui.quote.symbol === sym) ui.chart.live(ui.quote);
  } catch (e) {
    if (seq !== chartSeq) return;
    if (e.code === 'NO_RELAY') chartMsg(`The data relay isn't set up yet.<br><button id="setRelay">SET UP DATA RELAY</button>`);
    else chartMsg(`Couldn't load the chart.<br><span class="d">${fmt.esc(e.message)}</span><br><button id="retry">RETRY</button>`);
    $('#setRelay')?.addEventListener('click', () => go('menu', 'relay'));
    $('#retry')?.addEventListener('click', loadChart);
  }
}

function renderQuote() {
  const q = ui.quote; if (!q || q.error || !$('#pxMain')) return;
  const chg = q.price - q.previousClose, chgPct = q.previousClose ? (chg / q.previousClose) * 100 : 0;
  $('#pxMain').textContent = fmt.price(q.price);
  const c = $('#pxChg'); c.className = 'chg ' + fmt.tone(chg); c.textContent = `${fmt.arrow(chg)} ${fmt.price(Math.abs(chg))} ${fmt.pct(chgPct)}`;
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

let quoteBusy = false, lastQuoteAt = 0;
async function refreshQuote() {
  if (quoteBusy || !api.relayUrl()) return;
  quoteBusy = true; lastQuoteAt = Date.now();
  const sym = symbol();
  try {
    const res = await api.quotes([sym]);
    const q = res.quotes[sym];
    if (q && !q.error && sym === symbol()) {
      ui.quote = q;
      renderQuote();
      ui.chart?.live(q);
    }
  } catch { /* chart area already shows relay errors */ }
  finally { quoteBusy = false; }
}

// ---------------------------------------------------------------- polling & clock
function startPolling() {
  setInterval(() => {
    if (document.hidden || ui.tab !== 'home') return;
    const open = marketState().session !== SESSION.CLOSED;
    if (open) {
      refreshQuote();
      if (Date.now() - ui.lastChartLoad > CHART_REFRESH_MS) loadChart();
    } else if (Date.now() - lastQuoteAt > 5 * 60000) refreshQuote(); // closed: every 5 min
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ui.tab === 'home') { refreshQuote(); loadChart(); } });
}

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
      : `<div class="empty">Type a company name (like “apple”) or a ticker symbol (like “AAPL”).<br>Results include US-listed stocks and ETFs.</div>`;
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
        out.innerHTML = res.results.length ? `<div class="list">${res.results.map(itemHtml).join('')}</div>` : `<div class="empty">No US stocks match “${fmt.esc(q)}”.</div>`;
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
    ui.quote = null;
    go('home');
  });
  showRecent();
  setTimeout(() => input.focus(), 50);
}
const itemHtml = r => `<button class="item" data-sym="${fmt.esc(r.symbol)}" data-name="${fmt.esc(r.name)}" data-ex="${fmt.esc(r.exchange || '')}" data-type="${fmt.esc(r.type || '')}">
  <span class="sym w">${fmt.esc(r.symbol)}</span><span class="mid"><div>${fmt.esc(r.name)}</div><small>${fmt.esc(r.exchange || '')}</small></span>${r.type === 'ETF' ? '<span class="tag">ETF</span>' : ''}</button>`;

// ---------------------------------------------------------------- portfolio (Phase 4 fills this in)
function renderPortfolio(main) {
  const a = store.get().account;
  main.innerHTML = `
  <section class="screen">
    <div class="head"><h2 class="w">PORTFOLIO</h2></div>
    <div class="card">
      <div class="kv"><span class="d">Cash</span><span class="w">${fmt.money(a.cash)}</span></div>
      <div class="kv"><span class="d">Starting balance</span><span class="w">${fmt.money(a.startingBalance)}</span></div>
      <div class="kv"><span class="d">Account opened</span><span class="w">${new Date(a.createdAt).toLocaleDateString()}</span></div>
    </div>
    <div class="empty">No positions yet.<br>Positions, P&amp;L, trade history and the S&amp;P 500 comparison arrive in Phase 4.</div>
  </section>`;
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

// ---------------------------------------------------------------- overlays
function sheet(html, init) {
  closeSheet();
  const s = document.createElement('div');
  s.className = 'scrim'; s.innerHTML = `<div class="sheet" role="dialog">${html}</div>`;
  s.addEventListener('click', e => { if (e.target === s || e.target.closest('[data-close]')) closeSheet(); });
  document.body.appendChild(s);
  init?.($('.sheet', s));
}
function closeSheet() { document.querySelector('.scrim')?.remove(); }
let toastTimer;
function toast(msg) {
  document.querySelector('.toast')?.remove(); clearTimeout(toastTimer);
  const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = `<span class="c">›</span> ${fmt.esc(msg)}`;
  document.body.appendChild(t); toastTimer = setTimeout(() => t.remove(), 3200);
}

// ---------------------------------------------------------------- service worker
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

boot();
