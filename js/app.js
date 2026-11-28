import * as store from './store.js';
import * as api from './api.js';
import * as fmt from './format.js';
import { marketState, SESSION } from './market.js';
import { createCandleChart, TIMEFRAMES, INTERVAL_LABEL } from './chart.js';
import { CHART_REFRESH_MS, DEFAULT_SYMBOL, MIN_BALANCE, MAX_BALANCE, APP_VERSION, RELAY_URL } from './config.js';
import * as E from './engine.js';
import * as trader from './trader.js';
import { openTicket } from './ticket.js';
import { renderPortfolio, refreshPortfolio } from './portfolio.js';
import { exportBackup, importFlow, resetFlow } from './backup.js';
import * as learn from './learn.js';
import { applyTextScale, pullToRefresh } from './ux.js';
import { startUpdates } from './update.js';
import { afterFills } from './recap.js';
import { DEFAULTS as IND_DEFAULTS } from './indicators.js';
import { $, BR, sheet, closeSheet, toast } from './ui.js';

const app = $('#app');
const ui = { tab: 'home', sub: null, chart: null, meta: null, lastChartLoad: 0 };

// ---------------------------------------------------------------- boot
let started = false;
function boot() {
  applyTextScale(store.get().settings.textSize || 'auto');
  if (!store.get().account) return renderOnboarding();
  renderShell();
  if (started) return;
  started = true;
  learn.onChange(() => renderTip()); // listen before the clock can pick the first hint
  trader.onUpdate(onTraderUpdate);
  startClock();
  trader.start(() => [symbol()]);
}

function onTraderUpdate(ev) {
  renderNet();
  if (ui.tab === 'home') {
    renderQuote(); renderAccount();
    const q = trader.getQuote(symbol());
    if (q) ui.chart?.live(q);
    if (ev.kind === 'quotes' && marketState().session !== SESSION.CLOSED && Date.now() - ui.lastChartLoad > CHART_REFRESH_MS) loadChart();
  }
  if (ui.tab === 'portfolio' && !document.querySelector('.scrim')) refreshPortfolio($('#main'));
  const fills = ev.kind === 'quotes' ? ev.fills : ev.kind === 'catchup' ? ev.events.filter(x => x.kind === 'fill').map(x => x.fill) : ev.kind === 'order' ? ev.result?.fills || [] : [];
  if (fills?.length) afterFills(fills, { summary: trader.summary });
  if (ev.kind === 'catchup' && ev.events.some(x => x.kind === 'dividend')) learn.emit('dividend');
  const splitCancels = ev.kind === 'catchup' ? ev.events.filter(x => x.kind === 'split' && x.canceled?.length) : [];
  if (splitCancels.length) {
    const x = splitCancels[0];
    return toast(`${x.symbol} had a ${x.numerator}-for-${x.denominator} stock split. ${x.canceled.length} open order(s) were canceled; see Portfolio → Activity to re-enter them.`, 7000);
  }
  if (fills?.length && ev.kind !== 'order') {
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
    <div class="netbar" id="netbar" role="status" aria-live="polite" hidden></div>
    <main id="main"></main>
    <nav id="nav">
      <button data-tab="home">◈ HOME</button><button data-tab="search">⌕ SEARCH</button>
      <button data-tab="portfolio">▤ PORTFOLIO</button><button data-tab="menu">≡ MENU</button>
    </nav>`;
  $('#nav').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab); });
  pullToRefresh($('#main'), async () => {
    await trader.catchUp();
    await trader.poll();
    if (ui.tab === 'home') await loadChart(true);
    if (ui.tab === 'portfolio') renderPortfolio($('#main'), { go });
  });
  go('home');
  renderNet();
}

/** Banner when offline or when the price source isn't answering. */
function renderNet() {
  const el = $('#netbar'); if (!el) return;
  const n = trader.netStatus();
  const at = n.lastQuoteAt ? new Date(n.lastQuoteAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
  if (n.state === 'ok') { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = n.state === 'offline'
    ? `⚠ OFFLINE · ${at ? 'showing prices from ' + at : 'no prices yet'} · orders need a connection`
    : `⚠ PRICES DELAYED · the data source isn't responding, retrying${at ? ' · last update ' + at : ''}`;
}

function go(tab, sub = null) {
  ui.tab = tab; ui.sub = sub;
  document.querySelectorAll('#nav [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  if (ui.chart) { ui.chart.destroy(); ui.chart = null; }
  const main = $('#main');
  main.onclick = null;
  ({ home: renderHome, search: renderSearch, portfolio: m => renderPortfolio(m, { go }), menu: renderMenu })[tab](main);
  main.scrollTop = 0;
}

const symbol = () => store.get().settings.symbol || DEFAULT_SYMBOL;
const timeframe = () => store.get().settings.range || '1D';
const chartStyle = () => store.get().settings.chartStyle || 'candles';
const extOn = () => !!store.get().settings.ext; // pre/after-hours candles on intraday charts (off by default)
const interval = () => { const tf = TIMEFRAMES[timeframe()], saved = store.get().settings.intervals[timeframe()]; return tf.intervals.includes(saved) ? saved : tf.def; };

// ---------------------------------------------------------------- home
function renderHome(main) {
  main.innerHTML = `
  <section class="screen home">
    <div class="acctbar"><span class="lbl">Account</span><b class="w" id="acctVal">${fmt.money(trader.summary().total)}</b><span class="flat" id="dayPl">■ ${fmt.signedMoney(0)} (${fmt.pct(0)})</span></div>
    <div class="frame chartbox">${BR}
      <div class="qrow">
        <div class="qleft"><button class="tk w" id="tkBtn" aria-label="Change stock. Current: ${fmt.esc(symbol())}">${fmt.esc(symbol())}<span class="caret">▾</span></button><div class="nm" id="tkName">&nbsp;</div></div>
        <div class="px"><div><span id="pxMain" class="w">—</span> <span class="chg" id="pxChg"></span></div><div class="ext" id="pxExt"></div></div>
      </div>
      <div class="chart" id="chart" role="img" aria-label="Price chart"><div class="legend" id="legend"></div></div>
      <div class="ipane" id="paneRsi" hidden><span class="plbl">RSI</span></div>
      <div class="ipane" id="paneMacd" hidden><span class="plbl">MACD</span></div>
      <div class="tf" id="tf">
        ${Object.keys(TIMEFRAMES).map(k => `<button data-tf="${k}" class="${k === timeframe() ? 'on' : ''}">${k}</button>`).join('')}
        <button class="iv st ${extOn() ? 'on' : ''}" id="extBtn" aria-label="Show pre-market and after-hours" ${TIMEFRAMES[timeframe()].prepost ? '' : 'hidden'}>EXT</button>
        <button class="iv" id="indBtn" aria-label="Indicators">IND</button>
        <button class="iv" id="styleBtn" aria-label="Chart style">${chartStyle() === 'line' ? 'LINE' : 'CNDL'}</button>
        <button class="iv" id="ivBtn" aria-label="Candle size">${interval()} ▾</button>
      </div>
    </div>
    <div class="btns"><button class="btn buy" id="buy">BUY</button><button class="btn sell" id="sell">SELL</button></div>
    <div id="tipSlot" aria-live="polite"></div>
  </section>`;

  $('#tkBtn').addEventListener('click', () => go('search'));
  $('#tf').addEventListener('click', e => {
    const b = e.target.closest('[data-tf]'); if (!b) return;
    store.update(s => { s.settings.range = b.dataset.tf; });
    $('#tf').querySelectorAll('[data-tf]').forEach(x => x.classList.toggle('on', x === b));
    $('#ivBtn').textContent = interval() + ' ▾';
    $('#extBtn').hidden = !TIMEFRAMES[timeframe()].prepost;
    loadChart();
  });
  $('#indBtn').addEventListener('click', openIndicators);
  $('#extBtn').addEventListener('click', () => {
    store.update(s => { s.settings.ext = !extOn(); });
    $('#extBtn').classList.toggle('on', extOn());
    if (extOn()) learn.emit('ext');
    loadChart(true);
  });
  $('#styleBtn').addEventListener('click', () => {
    const next = chartStyle() === 'line' ? 'candles' : 'line';
    if (next === 'line') learn.emit('style:line');
    store.update(s => { s.settings.chartStyle = next; });
    $('#styleBtn').textContent = next === 'line' ? 'LINE' : 'CNDL';
    ui.chart?.setStyle(next); showLegend(null);
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
    if (E.position(store.get(), symbol()).qty <= 0) return learn.emit('sell:none'), toast(`You don't own any ${symbol()}. This is a cash account, so you can only sell shares you own.`);
    openTicket({ symbol: symbol(), name: trader.getQuote(symbol())?.name || ui.meta?.name, side: 'sell' });
  });

  renderTip();
  ui.chart = createCandleChart($('#chart'), { onHover: showLegend, style: chartStyle(), rsiEl: $('#paneRsi'), macdEl: $('#paneMacd') });
  applyIndicators();
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
  if (d && d.open == null) { el.innerHTML = `Close <b class="w">${fmt.price(d.close)}</b>`; return; }
  el.innerHTML = d ? `O <b>${fmt.price(d.open)}</b> H <b>${fmt.price(d.high)}</b> L <b>${fmt.price(d.low)}</b> C <b class="${d.close >= d.open ? 'up' : 'down'}">${fmt.price(d.close)}</b>`
    : `<span>Touch &amp; drag to read prices</span>`;
}

function chartMsg(html) {
  const box = $('#chart'); if (!box) return;
  box.querySelector('.chart-msg')?.remove();
  if (html) box.insertAdjacentHTML('beforeend', `<div class="chart-msg"><div>${html}</div></div>`);
}

let chartSeq = 0;
// Recent charts are kept (memory + a few on the phone) so switching tabs is instant and charts show offline.
const CKEY = 'lpt.charts';
const chartCache = new Map(Object.entries((() => { try { return JSON.parse(localStorage.getItem(CKEY) || '{}'); } catch { return {}; } })()));
function cacheChart(key, data) {
  chartCache.delete(key); chartCache.set(key, { data, at: Date.now() });
  const keep = [...chartCache].slice(-4);
  try { localStorage.setItem(CKEY, JSON.stringify(Object.fromEntries(keep))); } catch { /* storage full: memory only */ }
}
function drawChart(data, iv, sym) {
  ui.meta = data.meta;
  $('#tkName').textContent = data.meta.name || '';
  if (!data.bars.length) return chartMsg('No price data for this timeframe.');
  ui.chart.setData(data.bars, iv, data.meta.chartPreviousClose, TIMEFRAMES[timeframe()].prepost && extOn());
  $('#chart').setAttribute('aria-label', `${sym} price chart, ${timeframe()}, ${data.bars.length} candles. Last close ${fmt.price(data.bars.at(-1)[4])}.`);
  chartMsg(null);
  const q = trader.getQuote(sym);
  if (q && !q.stale) ui.chart.live(q);
}
async function loadChart(force = false) {
  if (!ui.chart) return;
  const seq = ++chartSeq, sym = symbol(), tf = TIMEFRAMES[timeframe()], iv = interval();
  const pre = tf.prepost && extOn();
  const key = `${sym}|${tf.range}|${iv}|${pre ? 'x' : 'r'}`, hit = chartCache.get(key);
  showLegend(null);
  if (hit) { drawChart(hit.data, iv, sym); if (!force && Date.now() - hit.at < 20000) { ui.lastChartLoad = hit.at; return; } }
  else chartMsg('<span class="spin"></span>');
  try {
    const data = await api.chart(sym, tf.range, iv, pre);
    if (seq !== chartSeq || !ui.chart) return;
    cacheChart(key, data);
    if (seq !== chartSeq || !ui.chart) return;
    ui.lastChartLoad = Date.now();
    drawChart(data, iv, sym);
  } catch (e) {
    if (seq !== chartSeq || hit) return; // keep showing the cached chart
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
  if (Math.abs(chgPct) >= 8) learn.emit('bigmove');
  const c = $('#pxChg'); c.className = 'chg ' + fmt.tone(chg); c.textContent = `${fmt.arrow(chg)} ${Math.abs(chg).toFixed(q.price < 1 ? 4 : 2)} ${fmt.pct(chgPct)}`;
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

// Session-based hints (once per session per day), plus the calm hint pacing tick.
const sessionSeen = new Set();
function sessionHints(now, m) {
  if (ui.tab !== 'home') return;
  const day = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  let ev = null;
  if (m.session === SESSION.PRE) ev = 'session:pre';
  else if (m.session === SESSION.POST) ev = 'session:post';
  else if (m.session === SESSION.CLOSED) ev = 'session:closed';
  else if (m.session === SESSION.REGULAR) {
    const left = m.next - now, open = m.next - now > (m.early ? 3.5 : 6.5) * 3600e3 - 15 * 60e3;
    if (left <= 15 * 60e3) ev = 'session:closing'; else if (open) ev = 'session:open';
  }
  if (ev && !sessionSeen.has(day + ev)) { sessionSeen.add(day + ev); learn.emit(ev); }
  learn.tick();
}

function startClock() {
  const tick = () => {
    const el = $('#status'); if (!el) return;
    const now = new Date(), m = marketState(now), open = m.session !== SESSION.CLOSED;
    const left = m.next - now;
    const when = left < 24 * 3600e3 ? `${m.nextLabel.toUpperCase()} ${fmt.countdown(left)}` : `PRE-MKT ${fmt.etWhen(m.next)}`;
    const name = m.holiday ? `CLOSED · ${m.holiday.toUpperCase()}` : m.label.toUpperCase() + (m.early && open ? ' · EARLY CLOSE' : '');
    el.innerHTML = `<span class="${open ? 'c' : 'closed'}"><span class="dot"></span>${name}</span><span class="d">${when}</span>`;
    if (now.getSeconds() === 0 || !sessionSeen.size) sessionHints(now, m);
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
      <button class="item" data-act="text"><span class="mid"><div class="w">Text size</div><small>${textSizeLabel()}</small></span><span class="d">›</span></button>
      <button class="item" data-sub="about"><span class="mid"><div class="w">About &amp; disclaimer</div><small>Not financial advice · credits</small></span><span class="d">›</span></button>
    </div>
    <div class="sect">YOUR DATA · STORED ONLY ON THIS PHONE</div>
    <div class="list">
      <button class="item" data-act="export"><span class="mid"><div class="w">Export backup</div><small>Save your whole account as a .json file</small></span><span class="d">↑</span></button>
      <button class="item" data-act="import"><span class="mid"><div class="w">Import backup</div><small>Replace this account with a .json backup</small></span><span class="d">↓</span></button>
      <button class="item" data-act="reset"><span class="mid"><div class="down">Reset account</div><small>Erase everything and choose a new starting balance</small></span><span class="d">›</span></button>
    </div>
    <div class="empty">v${APP_VERSION}</div>
  </section>`;
  main.onclick = async e => {
    const b = e.target.closest('[data-sub]'); if (b) return go('menu', b.dataset.sub);
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'export') { const r = await exportBackup(); if (r !== 'canceled') toast('Backup saved.'); }
    if (a.dataset.act === 'import') importFlow();
    if (a.dataset.act === 'reset') resetFlow();
    if (a.dataset.act === 'text') textSizeSheet();
  };
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

// ---------------------------------------------------------------- text size
const TEXT_SIZES = [['auto', 'Match iPhone setting'], ['1', 'Standard'], ['1.15', 'Large'], ['1.3', 'Extra large']];
const textSizeLabel = () => TEXT_SIZES.find(([k]) => k === (store.get().settings.textSize || 'auto'))[1];
function textSizeSheet() {
  const cur = store.get().settings.textSize || 'auto';
  sheet(`<h3>TEXT SIZE</h3>${TEXT_SIZES.map(([k, l]) => `<button class="opt ${k === cur ? 'on' : ''}" data-ts="${k}">${l}</button>`).join('')}
    <p class="d small" style="margin-top:12px">“Match iPhone setting” follows Settings → Display &amp; Brightness → Text Size.</p>`, el => el.addEventListener('click', e => {
    const b = e.target.closest('[data-ts]'); if (!b) return;
    store.update(s => { s.settings.textSize = b.dataset.ts; });
    applyTextScale(b.dataset.ts);
    closeSheet(); go('menu');
  }));
}

// ---------------------------------------------------------------- hints (learning layer)
function renderTip() {
  const slot = $('#tipSlot'); if (!slot) return;
  const h = learn.current();
  slot.innerHTML = h ? `<div class="tip ${h.kind === 'mistake' ? 'warn' : ''}" role="button" aria-expanded="false"><span class="c">${h.kind === 'mistake' ? '⚠ HEADS-UP' : '› TIP'}</span> ${fmt.esc(h.text)}<button class="x" aria-label="Dismiss tip">✕</button></div>` : '';
  slot.querySelector('.x')?.addEventListener('click', e => { e.stopPropagation(); learn.dismiss(); });
  // one line by default (keeps the chart big); tap to read the whole tip
  slot.querySelector('.tip')?.addEventListener('click', e => { const t = e.currentTarget; t.classList.toggle('open'); t.setAttribute('aria-expanded', t.classList.contains('open')); });
}

// ---------------------------------------------------------------- indicators
const IND_LIST = [['volume', 'Volume', 'Shares traded per candle'], ['ma', 'Moving averages', 'Average price lines on the chart'], ['rsi', 'RSI', 'Momentum, 0–100, in a pane below'], ['macd', 'MACD', 'Trend momentum, in a pane below']];
const indSettings = () => ({ volume: false, ma: false, rsi: false, macd: false, maPeriods: IND_DEFAULTS.maPeriods, rsiPeriod: IND_DEFAULTS.rsiPeriod, macdParams: IND_DEFAULTS.macd, ...(store.get().settings.ind || {}) });
function applyIndicators() {
  const c = indSettings();
  const r = $('#paneRsi'), m = $('#paneMacd');
  if (r) { r.hidden = !c.rsi; r.querySelector('.plbl').textContent = `RSI ${c.rsiPeriod}`; }
  if (m) { m.hidden = !c.macd; m.querySelector('.plbl').textContent = `MACD ${c.macdParams.join('·')}`; }
  $('#indBtn')?.classList.toggle('on', c.volume || c.ma || c.rsi || c.macd);
  ui.chart?.setIndicators(c);
}
function setInd(patch) { store.update(s => { s.settings.ind = { ...indSettings(), ...patch }; }); applyIndicators(); }

function openIndicators() {
  const c = indSettings();
  sheet(`<h3>INDICATORS</h3>
    <p class="d small">Indicators summarize past prices. They never say what to buy or sell.</p>
    ${IND_LIST.map(([k, label, sub]) => `
      <div class="indrow">
        <label class="toggle"><input type="checkbox" data-ind="${k}" ${c[k] ? 'checked' : ''}><span></span><div><div class="w">${label}</div><small class="d">${sub}</small></div></label>
        <button class="gear" data-set="${k}" ${c[k] && k !== 'volume' ? '' : 'hidden'} aria-label="${label} settings">⚙</button>
      </div>`).join('')}
    <button class="btn wide" data-close style="margin-top:14px">DONE</button>`, el => {
    el.addEventListener('change', e => {
      const k = e.target.dataset.ind; if (!k) return;
      if (e.target.checked && !learn.isExplained(k)) { e.target.checked = false; return explain(k); }
      setInd({ [k]: e.target.checked });
      if (e.target.checked) learn.emit('ind:any');
      el.querySelector(`[data-set="${k}"]`)?.toggleAttribute('hidden', !e.target.checked || k === 'volume');
    });
    el.addEventListener('click', e => { const g = e.target.closest('[data-set]'); if (g) indSettingsSheet(g.dataset.set); });
  });
}

function explain(k) {
  const x = learn.EXPLAIN[k];
  sheet(`<h3>${fmt.esc(x.title.toUpperCase())}</h3>${x.body.map(p => `<p class="w">${fmt.esc(p)}</p>`).join('')}
    <p class="d small">Not financial advice. Indicators describe the past; they can't predict prices.</p>
    <div class="btns"><button class="btn" id="exBack" style="border-color:var(--line-hi)">BACK</button><button class="btn cy" id="exOn">TURN ON</button></div>`, el => {
    $('#exBack', el).addEventListener('click', openIndicators);
    $('#exOn', el).addEventListener('click', () => { learn.markExplained(k); setInd({ [k]: true }); learn.emit('ind:any'); openIndicators(); });
  });
}

function indSettingsSheet(k) {
  const c = indSettings();
  const field = (id, label, val) => `<div class="lbl" style="margin-top:10px">${label}</div><label class="field" style="margin:6px 0 0"><input id="${id}" inputmode="numeric" value="${val}"></label>`;
  const body = k === 'ma' ? field('sMa', 'Periods (up to 3, comma-separated)', c.maPeriods.join(', '))
    : k === 'rsi' ? field('sRsi', 'Period', c.rsiPeriod)
    : field('sF', 'Fast', c.macdParams[0]) + field('sS', 'Slow', c.macdParams[1]) + field('sG', 'Signal', c.macdParams[2]);
  sheet(`<h3>${k.toUpperCase()} SETTINGS</h3>${body}<div id="sErr" class="msg err" hidden></div>
    <div class="btns" style="margin-top:14px"><button class="btn" id="sStd" style="border-color:var(--line-hi)">STANDARD</button><button class="btn cy" id="sSave">SAVE</button></div>`, el => {
    const ok = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    $('#sStd', el).addEventListener('click', () => { setInd(k === 'ma' ? { maPeriods: IND_DEFAULTS.maPeriods } : k === 'rsi' ? { rsiPeriod: IND_DEFAULTS.rsiPeriod } : { macdParams: IND_DEFAULTS.macd }); openIndicators(); });
    $('#sSave', el).addEventListener('click', () => {
      const err = t => { const e = $('#sErr', el); e.hidden = false; e.textContent = '⚠ ' + t; };
      if (k === 'ma') {
        const v = $('#sMa', el).value.split(/[,\s]+/).filter(Boolean).map(Number);
        if (!v.length || v.length > 3 || !v.every(n => ok(n, 2, 400))) return err('Enter 1–3 whole numbers between 2 and 400.');
        setInd({ maPeriods: v });
      } else if (k === 'rsi') {
        const v = Number($('#sRsi', el).value);
        if (!ok(v, 2, 100)) return err('Enter a whole number between 2 and 100.');
        setInd({ rsiPeriod: v });
      } else {
        const v = ['#sF', '#sS', '#sG'].map(id => Number($(id, el).value));
        if (!v.every(n => ok(n, 2, 200)) || v[0] >= v[1]) return err('Whole numbers 2–200, with Fast smaller than Slow.');
        setInd({ macdParams: v });
      }
      openIndicators();
    });
  });
}

// ---------------------------------------------------------------- service worker
// Updates: "Update available" pop-up on open (see update.js).
startUpdates();

boot();
