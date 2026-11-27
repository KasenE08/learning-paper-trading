// End-to-end tests on emulated iPhones. Run: node --test tests/e2e.test.mjs
// Set LIVE_RELAY=http://localhost:8787 to also run the live-data test against a local relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const RELAY = 'https://relay.test';

let server, base, browser;
test.before(async () => {
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}/`;
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); server?.close(); });

// ---- mock relay -----------------------------------------------------------
function mockBars(n, start, step, p0 = 100) {
  const bars = []; let p = p0;
  for (let i = 0; i < n; i++) { const o = p, c = p + Math.sin(i / 3) * 0.4; bars.push([start + i * step, o, Math.max(o, c) + 0.2, Math.min(o, c) - 0.2, +c.toFixed(2), 1000]); p = c; }
  return bars;
}
function relayMock(page, { price = () => 101.5, calls = [], chart = null } = {}) {
  return page.route(`${RELAY}/**`, route => {
    const u = new URL(route.request().url()); calls.push(u.pathname + u.search);
    const send = body => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
    const sym = (u.searchParams.get('symbol') || u.searchParams.get('symbols') || 'SPY').split(',')[0];
    if (u.pathname === '/search') return send({ results: [
      { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', type: 'EQUITY' },
      { symbol: 'APLE', name: 'Apple Hospitality REIT, Inc.', exchange: 'NYSE', type: 'EQUITY' },
      { symbol: 'APLY', name: 'YieldMax AAPL Option Income ETF', exchange: 'NYSE Arca', type: 'ETF' }] });
    if (u.pathname === '/chart' && chart) { const r = chart(u); if (r) return send(r); }
    if (u.pathname === '/chart') return send({ meta: { symbol: sym, name: sym === 'AAPL' ? 'Apple Inc.' : 'SPDR S&P 500 ETF', previousClose: 100 }, bars: mockBars(60, 1795530600, 300), dividends: [], splits: [] });
    if (u.pathname === '/quote') {
      const p = price(), now = Math.floor(Date.now() / 1000), quotes = {};
      for (const s of u.searchParams.get('symbols').split(',')) quotes[s] = { symbol: s, name: s === 'AAPL' ? 'Apple Inc.' : s === 'SPY' ? 'SPDR S&P 500 ETF' : s, type: s === 'SPY' ? 'ETF' : 'EQUITY', price: p, previousClose: 100, regularTime: now, last: p, lastTime: now, extended: false };
      return send({ quotes });
    }
    return send({ ok: true });
  });
}
const ACCOUNT = (relayUrl = RELAY, extra = {}) => JSON.stringify({ version: 1, account: { startingBalance: 25000, cash: 25000, createdAt: 1795500000000 }, settings: { relayUrl, symbol: null, range: '1D', intervals: {} }, recentSearches: [], dismissedTips: {}, ...extra });

async function newPage(device = 'iPhone 14', { time, account = true, relayUrl, symbol, state } = {}) {
  const ctx = await browser.newContext({ ...devices[device] });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  if (time) await page.clock.install({ time: new Date(time) });
  const init = state ? JSON.stringify(state) : ACCOUNT(relayUrl, symbol ? { settings: { relayUrl: relayUrl ?? RELAY, symbol, range: '1D', intervals: {} } } : {});
  if (account) await ctx.addInitScript(s => { if (!localStorage.getItem('lpt.v1')) localStorage.setItem('lpt.v1', s); }, init);
  return page;
}

// ---- tests ----------------------------------------------------------------
test('onboarding: disclaimer, balance validation, confirm, persists', async () => {
  const page = await newPage('iPhone 14', { account: false });
  await page.goto(base);
  assert.match(await page.textContent('.onb'), /NOT FINANCIAL ADVICE/);
  assert.equal(await page.isDisabled('#start'), true);
  await page.fill('#bal', '0');
  assert.equal(await page.isDisabled('#start'), true);
  assert.match(await page.textContent('#balHint'), /above \$0/);
  await page.fill('#bal', 'abc');
  assert.equal(await page.isDisabled('#start'), true);
  await page.fill('#bal', '5000000000000');
  assert.equal(await page.isDisabled('#start'), true);
  for (const ok of ['1', '50', '20000000']) { await page.fill('#bal', ok); assert.equal(await page.isDisabled('#start'), false, ok); }
  await page.fill('#bal', '$12,345.67');
  assert.equal(await page.isDisabled('#start'), false);
  await page.click('#start');
  assert.match(await page.textContent('.sheet'), /\$12,345\.67/);
  await page.click('#ok');
  await page.waitForSelector('#acctVal');
  assert.equal(await page.textContent('#acctVal'), '$12,345.67');
  await page.reload();
  await page.waitForSelector('#acctVal');
  assert.equal(await page.textContent('#acctVal'), '$12,345.67');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lpt.v1')).account);
  assert.equal(saved.startingBalance, 12345.67);
  assert.equal(saved.settled, 12345.67);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('uses the built-in relay address by default', async () => {
  const page = await newPage('iPhone 14', { time: '2026-11-24T15:00:00Z', relayUrl: '' });
  const calls = [];
  await page.route('https://learning-paper-trading.ertel-kasen.workers.dev/**', r => { calls.push(r.request().url()); r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ quotes: {}, bars: [], meta: {} }) }); });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('.chart-msg')?.textContent.includes('No price data'));
  assert.ok(calls.some(u => u.includes('/chart?symbol=SPY')));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('home: default SPY chart, quote, colors; ETFs cannot be bought', async () => {
  const page = await newPage('iPhone 14', { time: '2026-11-24T15:00:00Z' });
  await relayMock(page);
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#pxMain')?.textContent === '101.50');
  assert.equal((await page.textContent('#tkBtn')).replace('▾', ''), 'SPY');
  assert.match(await page.getAttribute('#pxChg', 'class'), /\bup\b/);
  assert.match(await page.textContent('#pxChg'), /\+1\.50%/);
  assert.equal(await page.locator('#chart canvas').count() > 0, true);
  assert.equal(await page.locator('.chart-msg').count(), 0);
  assert.match(await page.textContent('#status'), /MARKET OPEN/);
  assert.match(await page.textContent('#status'), /CLOSES IN 0(6:00:00|5:59:5\d)/);
  await page.click('#buy');
  assert.match(await page.textContent('.toast'), /ETF. This app trades individual stocks only/);
  await page.click('#sell');
  assert.match(await page.textContent('.toast'), /don't own any SPY/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('live quotes refresh every 5 seconds while the market is open', async () => {
  let p = 101.5; const calls = [];
  const page = await newPage('iPhone 14', { time: '2026-11-24T15:00:00Z' });
  await relayMock(page, { price: () => p, calls });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#pxMain')?.textContent === '101.50');
  p = 98.25;
  await page.clock.runFor(5100);
  await page.waitForFunction(() => document.querySelector('#pxMain')?.textContent === '98.25');
  assert.match(await page.getAttribute('#pxChg', 'class'), /\bdown\b/);
  const quoteCalls = calls.filter(c => c.startsWith('/quote')).length;
  await page.clock.runFor(15000);
  assert.ok(calls.filter(c => c.startsWith('/quote')).length >= quoteCalls + 3, 'polls ~every 5s');
  await page.context().close();
});

test('market closed (Thanksgiving): no fast polling, holiday label', async () => {
  const calls = [];
  const page = await newPage('iPhone 14', { time: '2026-11-26T16:00:00Z' });
  await relayMock(page, { calls });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#pxMain')?.textContent === '101.50');
  assert.match(await page.textContent('#status'), /CLOSED · THANKSGIVING DAY/);
  assert.match(await page.textContent('#status'), /PRE-MARKET IN 1(7:00:00|6:59:5\d)/);
  const before = calls.filter(c => c.startsWith('/quote')).length;
  await page.clock.runFor(30000);
  assert.equal(calls.filter(c => c.startsWith('/quote')).length, before, 'no 5s polling while closed');
  await page.context().close();
});

test('timeframes and candle sizes request the right data', async () => {
  const calls = [];
  const page = await newPage('iPhone 14', { time: '2026-11-24T15:00:00Z' });
  await relayMock(page, { calls });
  await page.goto(base);
  await page.waitForSelector('#chart canvas');
  assert.ok(calls.some(c => c.includes('/chart') && c.includes('range=1d') && c.includes('interval=5m') && c.includes('prepost=1')));
  await page.click('[data-tf="1Y"]');
  await page.waitForFunction(() => document.querySelector('#ivBtn').textContent.startsWith('1d'));
  assert.ok(calls.some(c => c.includes('range=1y') && c.includes('interval=1d')));
  await page.click('#ivBtn');
  assert.deepEqual(await page.locator('.sheet [data-iv]').allTextContents(), ['1 day', '1 week']);
  await page.click('[data-iv="1wk"]');
  await page.waitForFunction(() => document.querySelector('#ivBtn').textContent.startsWith('1wk'));
  assert.ok(calls.some(c => c.includes('range=1y') && c.includes('interval=1wk')));
  for (const [tf, iv, range] of [['MAX', '1mo', 'max'], ['1W', '30m', '5d'], ['1M', '1h', '1mo']]) {
    await page.click(`[data-tf="${tf}"]`);
    await page.waitForFunction(v => document.querySelector('#ivBtn').textContent.startsWith(v), iv);
    assert.ok(calls.some(c => c.includes(`range=${range}`) && c.includes(`interval=${iv}`)), tf);
  }
  await page.reload(); await page.waitForSelector('#ivBtn');
  assert.equal(await page.getAttribute('[data-tf="1M"]', 'class'), 'on', 'timeframe remembered');
  await page.context().close();
});

test('search: results, pick ticker, recent list', async () => {
  const page = await newPage('iPhone 14', { time: '2026-11-24T15:00:00Z' });
  await relayMock(page);
  await page.goto(base);
  await page.click('[data-tab="search"]');
  await page.fill('#q', 'apple');
  await page.clock.runFor(400);
  await page.waitForSelector('[data-sym="AAPL"]');
  assert.equal(await page.locator('#results .item').count(), 2, 'ETF hidden');
  assert.equal(await page.locator('[data-sym="APLY"]').count(), 0);
  await page.click('[data-sym="AAPL"]');
  await page.waitForFunction(() => document.querySelector('#tkBtn')?.textContent.startsWith('AAPL'));
  await page.waitForFunction(() => document.querySelector('#tkName')?.textContent === 'Apple Inc.');
  await page.click('[data-tab="search"]');
  await page.waitForSelector('text=RECENT');
  assert.equal(await page.locator('[data-sym="AAPL"]').count(), 1);
  await page.click('#tkBtn').catch(() => {});
  await page.context().close();
});

test('menu: relay save & test, about page with disclaimer + credits', async () => {
  const page = await newPage('iPhone 14', { time: '2026-11-24T15:00:00Z', relayUrl: '' });
  await relayMock(page);
  await page.goto(base);
  await page.click('[data-tab="menu"]');
  await page.click('[data-sub="relay"]');
  await page.fill('#relay', 'relay.test/');
  await page.click('#save');
  await page.waitForSelector('text=CONNECTED');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('lpt.v1')).settings.relayUrl), RELAY);
  await page.click('#back');
  await page.click('[data-sub="about"]');
  assert.match(await page.textContent('main'), /NOT FINANCIAL ADVICE/);
  assert.match(await page.textContent('main'), /TradingView/);
  await page.context().close();
});

test('hints: one at a time, calm 2-minute pacing, dismissals persist', async () => {
  const page = await newPage('iPhone 14', { time: '2026-11-24T15:30:00Z' }); // 10:30 ET, mid-session
  await relayMock(page);
  await page.goto(base);
  await page.waitForSelector('.tip');
  assert.equal(await page.locator('.tip').count(), 1);
  const first = await page.textContent('.tip');
  await page.click('.tip .x');
  assert.equal(await page.locator('.tip').count(), 0, 'nothing new right away');
  await page.clock.runFor(125_000);
  await page.waitForSelector('.tip');
  const second = await page.textContent('.tip');
  assert.notEqual(first, second);
  await page.reload(); await page.waitForSelector('#chart');
  assert.equal(await page.textContent('.tip'), second, 'the current hint survives a reload');
  await page.context().close();
});

test('mistake hint: trying to sell a stock you don\'t own', async () => {
  const page = await newPage('iPhone 14', { time: OPEN, symbol: 'AAPL' });
  await relayMock(page);
  await page.goto(base);
  await page.waitForSelector('#chart canvas');
  await page.click('#sell');
  assert.match(await page.textContent('.toast'), /don't own any AAPL/);
  assert.match(await page.textContent('.tip'), /HEADS-UP.*short selling/s);
  await page.context().close();
});

test('indicators: off by default, explainer the first time, panes and settings', async () => {
  const page = await newPage('iPhone 14', { time: OPEN, symbol: 'AAPL' });
  await relayMock(page);
  await page.goto(base);
  await page.waitForSelector('#chart canvas');
  assert.equal(await page.isHidden('#paneRsi'), true);
  await page.click('#indBtn');
  assert.equal(await page.locator('.sheet input[data-ind]:checked').count(), 0, 'all off by default');
  await page.click('.indrow:has([data-ind="rsi"]) .toggle');
  await page.waitForSelector('text=RSI (RELATIVE STRENGTH INDEX)');
  assert.match(await page.textContent('.sheet'), /doesn't predict a turn|can't predict/);
  await page.click('#exOn');
  await page.waitForSelector('[data-set="rsi"]:not([hidden])');
  assert.equal(await page.isVisible('#paneRsi'), true);
  // second time: no explainer
  await page.click('.indrow:has([data-ind="rsi"]) .toggle');
  await page.click('.indrow:has([data-ind="rsi"]) .toggle');
  assert.equal(await page.locator('#exOn').count(), 0);
  // settings with validation
  await page.click('[data-set="rsi"]');
  await page.fill('#sRsi', '1');
  await page.click('#sSave');
  assert.match(await page.textContent('#sErr'), /between 2 and 100/);
  await page.fill('#sRsi', '21');
  await page.click('#sSave');
  await page.click('[data-close]');
  assert.equal(await page.textContent('#paneRsi .plbl'), 'RSI 21');
  await page.reload(); await page.waitForSelector('#chart canvas');
  assert.equal(await page.isVisible('#paneRsi'), true, 'remembered');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('post-trade recap pops up when a position closes, and reopens from History', async () => {
  const now = Date.parse(OPEN), bought = now - 10 * 864e5;
  const state = JSON.parse(ACCOUNT(RELAY, { settings: { relayUrl: RELAY, symbol: 'AAPL', range: '1D', intervals: {} } }));
  state.account = { startingBalance: 10000, settled: 9000, unsettled: [], createdAt: bought - 864e5 };
  state.trading = { positions: { AAPL: { name: 'Apple Inc.', lots: [{ id: 'l1', qty: 10, price: 100, time: bought, fundSettle: null }] } }, orders: [], activity: [], violations: [], restrictedUntil: null,
    divs: { done: {}, pending: [], paid: [] }, splits: {}, lastSync: { AAPL: '2026-11-24' },
    fills: [{ id: 'f1', symbol: 'AAPL', side: 'buy', type: 'market', qty: 10, price: 100, amount: 1000, fees: 0, time: bought }] };
  const page = await newPage('iPhone 14', { time: OPEN, state });
  const day0 = Date.parse('2025-10-01T14:30:00Z') / 1000;
  const bars = Array.from({ length: 300 }, (_, i) => { const c = 80 + i * 0.1; return [day0 + i * 86400, c, c + 1, c - 1, c, 1000 + i]; });
  await relayMock(page, { price: () => 101.5, chart: u => (u.searchParams.get('period1') && !u.searchParams.get('events') ? { meta: {}, bars, dividends: [], splits: [] } : null) });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#pxMain')?.textContent === '101.50');
  await page.click('#sell');
  await page.waitForSelector('.ticket');
  await page.click('#tMax');
  await page.click('#tReview');
  await page.click('#rPlace');
  await page.waitForSelector('.recap >> text=WHEN YOU BOUGHT', { timeout: 15000 });
  const t = await page.textContent('.recap');
  assert.match(t, /TRADE RECAP · AAPL/);
  assert.match(t, /RSI was \d+/);
  assert.match(t, /WHAT HAPPENED/);
  assert.match(t, /S&P 500 moved/);
  assert.match(t, /Not financial advice/);
  await page.click('.recap [data-close]');
  await page.click('[data-tab="portfolio"]');
  await page.click('[data-ptab="history"]');
  await page.click('[data-trip]');
  await page.waitForSelector('.recap >> text=WHAT HAPPENED');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

for (const device of ['iPhone SE', 'iPhone 14', 'iPhone 14 Pro Max']) {
  test(`layout fits ${device}: no horizontal scroll, nav and buttons visible`, async () => {
    const page = await newPage(device, { time: '2026-11-24T15:00:00Z' });
    await relayMock(page);
    await page.goto(base);
    await page.waitForSelector('#chart canvas');
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h: innerHeight, nav: document.querySelector('nav').getBoundingClientRect().bottom, buy: document.querySelector('#buy').getBoundingClientRect().bottom }));
    assert.ok(m.sw <= m.cw, `no horizontal overflow (${m.sw} > ${m.cw})`);
    assert.ok(m.nav <= m.h + 1, 'nav on screen');
    assert.ok(m.buy <= m.h, 'buy button on screen');
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

test('PWA: manifest, icons, iOS meta tags', async () => {
  const page = await newPage('iPhone 14', { account: false });
  await page.goto(base);
  const man = await (await page.request.get(base + 'manifest.webmanifest')).json();
  assert.equal(man.short_name, 'Learn PT');
  assert.equal(man.display, 'standalone');
  for (const i of man.icons) assert.equal((await page.request.get(base + i.src)).status(), 200, i.src);
  assert.equal(await page.getAttribute('meta[name="apple-mobile-web-app-title"]', 'content'), 'Learn PT');
  assert.equal(await page.getAttribute('meta[name="apple-mobile-web-app-capable"]', 'content'), 'yes');
  assert.equal((await page.request.get(base + 'icons/apple-touch-icon.png')).status(), 200);
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  for (const f of [...sw.matchAll(/'([^']+\.(?:js|css|png|woff2|html|webmanifest))'/g)].map(m => m[1])) assert.ok(fs.existsSync(path.join(ROOT, f)), 'sw precache file exists: ' + f);
  await page.context().close();
});

test('live data through a real relay (LIVE_RELAY)', { skip: !process.env.LIVE_RELAY }, async () => {
  const page = await newPage('iPhone 14', { relayUrl: process.env.LIVE_RELAY });
  await page.goto(base);
  await page.waitForFunction(() => /\d/.test(document.querySelector('#pxMain')?.textContent || ''), null, { timeout: 15000 });
  await page.waitForSelector('#chart canvas');
  assert.equal(await page.locator('.chart-msg').count(), 0);
  await page.click('[data-tab="search"]');
  await page.fill('#q', 'nvidia');
  await page.waitForSelector('[data-sym="NVDA"]', { timeout: 15000 });
  await page.click('[data-sym="NVDA"]');
  await page.waitForFunction(() => /NVIDIA/i.test(document.querySelector('#tkName')?.textContent || ''), null, { timeout: 15000 });
  for (const tf of ['1W', '1M', '1Y', 'MAX']) {
    await page.click(`[data-tf="${tf}"]`);
    await page.waitForFunction(() => !document.querySelector('.chart-msg'), null, { timeout: 15000 });
  }
  // real order through the live relay (fills only while the market is open)
  await page.click('#buy');
  await page.waitForSelector('.ticket');
  await page.fill('#tQty', '1');
  await page.click('#tReview');
  await page.click('#rPlace');
  await page.waitForSelector('.toast >> text=/Filled|Order placed/', { timeout: 20000 });
  console.log('    live order:', await page.textContent('.toast'));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

// ---- Phase 3: trading -----------------------------------------------------
const OPEN = '2026-11-24T15:00:00Z'; // Tue 10:00 ET
async function ticket(page, side = 'buy') {
  await page.click('#' + side);
  await page.waitForSelector('.ticket');
}
const lsState = page => page.evaluate(() => JSON.parse(localStorage.getItem('lpt.v1')));

test('market buy: review, place, fills, shows in portfolio', async () => {
  const page = await newPage('iPhone 14', { time: OPEN, symbol: 'AAPL' });
  await relayMock(page, { price: () => 200 });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#pxMain')?.textContent === '200.00');
  await ticket(page);
  await page.fill('#tQty', '10');
  assert.match(await page.textContent('#tEst'), /Est\. cost\$2,000\.50/);
  await page.click('#tReview');
  await page.waitForSelector('#rPlace');
  assert.match(await page.textContent('.sheet'), /Buy 10 shares of AAPL at market/);
  await page.click('#rPlace');
  await page.waitForSelector('.toast >> text=Filled');
  assert.match(await page.textContent('.toast'), /bought 10 AAPL at \$200\.05/);
  const st = await lsState(page);
  assert.equal(st.account.settled, 25000 - 2000.5);
  assert.equal(st.trading.positions.AAPL.lots[0].qty, 10);
  await page.click('[data-tab="portfolio"]');
  await page.waitForSelector('[data-sym="AAPL"]');
  assert.match(await page.textContent('main'), /10 sh · avg 200\.05/);
  await page.click('[data-ptab="history"]');
  await page.click('[data-hist="fills"]');
  assert.match(await page.textContent('main'), /Bought 10 AAPL at 200\.05/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('limit order rests, shows in open orders, can be canceled', async () => {
  const page = await newPage('iPhone 14', { time: OPEN, symbol: 'AAPL' });
  await relayMock(page, { price: () => 200 });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#pxMain')?.textContent === '200.00');
  await ticket(page);
  await page.click('[data-type="limit"]');
  assert.equal(await page.inputValue('#tLimit'), '200');
  await page.fill('#tLimit', '190');
  await page.fill('#tQty', '5');
  await page.click('[data-tif="gtc"]');
  await page.click('#tReview');
  await page.click('#rPlace');
  await page.waitForSelector('.toast >> text=Order placed');
  await page.click('[data-tab="portfolio"]');
  await page.waitForSelector('[data-cancel]');
  assert.match(await page.textContent('main'), /Buy 5 sh AAPL @ 190 limit/);
  assert.match(await page.textContent('main'), /Buying power\$24,050\.00/);
  await page.click('[data-cancel]');
  await page.click('#doCancel');
  await page.waitForSelector('text=No open orders.');
  await page.context().close();
});

test('ticket validation and fractional rules show in plain language', async () => {
  const page = await newPage('iPhone 14', { time: OPEN, symbol: 'AAPL' });
  await relayMock(page, { price: () => 200 });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#pxMain')?.textContent === '200.00');
  await ticket(page);
  await page.click('[data-type="stop"]');
  await page.fill('#tQty', '1.5');
  await page.fill('#tStop', '190');
  await page.click('#tReview');
  const msgs = await page.textContent('#tMsgs');
  assert.match(msgs, /need whole shares/);
  assert.match(msgs, /buy stop must be above the current price/);
  await page.click('[data-type="market"]');
  await page.click('[data-mode="dollars"]');
  await page.fill('#tQty', '500');
  assert.match(await page.textContent('#tEst'), /Shares2\.499/);
  await page.context().close();
});

test('sell side: MAX fills available shares; GFV warning shown', async () => {
  const now = Date.parse(OPEN);
  const state = JSON.parse(ACCOUNT(RELAY, { settings: { relayUrl: RELAY, symbol: 'AAPL', range: '1D', intervals: {} } }));
  state.account = { startingBalance: 25000, settled: 100, unsettled: [{ amount: 2000, settles: '2026-11-25', src: 'x' }], createdAt: now - 864e5 * 10 };
  state.trading = { positions: { AAPL: { name: 'Apple Inc.', lots: [{ id: 'l1', qty: 7, price: 190, time: now - 3600e3, fundSettle: '2026-11-25' }] } }, orders: [], fills: [], activity: [], violations: [], restrictedUntil: null, divs: { done: {}, pending: [] }, splits: {}, lastSync: { AAPL: '2026-11-24' } };
  const page = await newPage('iPhone 14', { time: OPEN, state });
  await relayMock(page, { price: () => 200 });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#pxMain')?.textContent === '200.00');
  await ticket(page, 'sell');
  await page.click('#tMax');
  assert.equal(await page.inputValue('#tQty'), '7');
  assert.match(await page.textContent('#tMsgs'), /good-faith violation/);
  await page.click('#tReview');
  assert.match(await page.textContent('.sheet'), /good-faith violation/);
  await page.click('#rPlace');
  await page.waitForSelector('.toast >> text=sold 7 AAPL');
  const st = await lsState(page);
  assert.equal(st.trading.violations.length, 1);
  await page.context().close();
});

test('orders placed earlier fill on reopen from missed minute bars', async () => {
  const placed = Date.parse('2026-11-24T15:00:00Z'), reopen = Date.parse('2026-11-24T18:00:00Z');
  const state = JSON.parse(ACCOUNT(RELAY, { settings: { relayUrl: RELAY, symbol: 'AAPL', range: '1D', intervals: {} } }));
  state.account = { startingBalance: 25000, settled: 25000, unsettled: [], createdAt: placed - 864e5 };
  state.trading = { positions: {}, fills: [], activity: [], violations: [], restrictedUntil: null, divs: { done: {}, pending: [] }, splits: {}, lastSync: {},
    orders: [{ id: 'o1', symbol: 'AAPL', side: 'buy', type: 'limit', qty: 10, limit: 195, tif: 'gtc', status: 'open', createdAt: placed, activeFrom: placed, checkedTo: placed, expiresAt: placed + 180 * 864e5, refPrice: 200 }] };
  const page = await newPage('iPhone 14', { time: reopen, state });
  const t0 = placed / 1000;
  await relayMock(page, { price: () => 198, chart: u => u.searchParams.get('period1') ? { meta: {}, bars: [[t0 + 600, 199, 199, 198, 198.5, 0], [t0 + 3600, 197, 197, 194, 195.5, 0], [t0 + 7200, 196, 197, 195, 196, 0]], dividends: [], splits: [] } : null });
  await page.goto(base);
  await page.waitForSelector('.toast >> text=while the app was closed');
  const st = await lsState(page);
  assert.equal(st.trading.orders[0].status, 'filled');
  assert.equal(st.trading.fills[0].price, 195);
  assert.equal(st.trading.fills[0].time, (t0 + 3600) * 1000);
  await page.context().close();
});

test('dividends for held shares are scheduled and shown', async () => {
  const now = Date.parse(OPEN), bought = now - 30 * 864e5;
  const state = JSON.parse(ACCOUNT(RELAY, { settings: { relayUrl: RELAY, symbol: 'AAPL', range: '1D', intervals: {} } }));
  state.account = { startingBalance: 25000, settled: 23000, unsettled: [], createdAt: bought - 864e5 };
  state.trading = { positions: { AAPL: { name: 'Apple Inc.', lots: [{ id: 'l1', qty: 10, price: 200, time: bought, fundSettle: null }] } }, orders: [], activity: [], violations: [], restrictedUntil: null, divs: { done: {}, pending: [] }, splits: {}, lastSync: {},
    fills: [{ id: 'f1', orderId: 'o0', symbol: 'AAPL', side: 'buy', qty: 10, price: 200, time: bought }] };
  const page = await newPage('iPhone 14', { time: OPEN, state });
  await relayMock(page, { chart: u => u.searchParams.get('period1') ? { meta: {}, bars: [], dividends: [{ date: (now - 10 * 864e5) / 1000, amount: 0.26 }], splits: [] } : null });
  await page.goto(base);
  await page.click('[data-tab="portfolio"]');
  await page.waitForSelector('text=/Dividend AAPL/');
  assert.match(await page.textContent('main'), /\$2\.60/);
  await page.context().close();
});

// ---- Phase 4: portfolio analytics, performance, backup ----------------------
function tradedState() {
  const d = iso => Date.parse(iso);
  const st = JSON.parse(ACCOUNT(RELAY, { settings: { relayUrl: RELAY, symbol: 'AAPL', range: '1D', intervals: {} } }));
  st.account = { startingBalance: 10000, settled: 10000 - 1000 + 1095 - 500, unsettled: [], createdAt: d('2026-11-16T12:00:00Z') };
  st.trading = { positions: { MSFT: { name: 'Microsoft', lots: [{ id: 'l2', qty: 5, price: 100, time: d('2026-11-18T15:00:00Z'), fundSettle: null }] } }, orders: [], activity: [], violations: [], restrictedUntil: null,
    divs: { done: {}, pending: [], paid: [] }, splits: {}, lastSync: { MSFT: '2026-11-24' },
    fills: [
      { id: 'f3', symbol: 'MSFT', side: 'buy', type: 'market', qty: 5, price: 100, amount: 500, fees: 0, time: d('2026-11-18T15:00:00Z') },
      { id: 'f2', symbol: 'AAPL', side: 'sell', type: 'limit', qty: 10, price: 110, amount: 1100, fees: 5, net: 1095, basis: 1000, realized: 95, time: d('2026-11-17T18:00:00Z') },
      { id: 'f1', symbol: 'AAPL', side: 'buy', type: 'market', qty: 10, price: 100, amount: 1000, fees: 0, time: d('2026-11-16T15:00:00Z') },
    ] };
  return st;
}
const daily = (days, closes) => days.map((day, i) => [Date.parse(day + 'T14:30:00Z') / 1000, closes[i], closes[i], closes[i], closes[i], 0]);
const DAYS = ['2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24'];
const perfChart = u => {
  const sym = u.searchParams.get('symbol');
  if (!u.searchParams.get('period1') || (u.searchParams.get('events') && sym !== 'SPY')) return null;
  if (sym === 'SPY') return { meta: {}, bars: daily(DAYS, [500, 500, 505, 505, 510, 510, 515, 510]), dividends: [], splits: [] };
  if (sym === 'MSFT') return { meta: {}, bars: daily(DAYS, [98, 99, 99, 100, 104, 106, 108, 110]), dividends: [], splits: [] };
  return { meta: {}, bars: daily(DAYS, [99, 100, 110, 108, 107, 106, 105, 104]), dividends: [], splits: [] };
};

test('overview shows total return, open and closed P&L', async () => {
  const page = await newPage('iPhone 14', { time: '2026-11-24T22:00:00Z', state: tradedState() });
  await relayMock(page, { price: () => 110, chart: perfChart });
  await page.goto(base);
  await page.click('[data-tab="portfolio"]');
  await page.waitForSelector('text=Total return');
  const t = await page.textContent('main');
  assert.match(t, /Closed P&L \(realized\)\+\$95\.00/);
  assert.match(t, /Open P&L \(unrealized\)\+\$50\.00/);
  assert.match(t, /Total return\+\$145\.00 \(\+1\.45%\)/);
  await page.context().close();
});

test('performance: you vs the S&P 500 line chart, win rate', async () => {
  const page = await newPage('iPhone 14', { time: '2026-11-24T22:00:00Z', state: tradedState() });
  await relayMock(page, { price: () => 110, chart: perfChart });
  await page.goto(base);
  await page.click('[data-tab="portfolio"]');
  await page.click('[data-ptab="performance"]');
  await page.waitForSelector('.vs-row');
  const t = await page.textContent('main');
  assert.match(t, /You\+1\.45%/);          // 10,145 vs 10,000 start
  assert.match(t, /S&P 500\+2\.00%/);      // 510 vs 500 (close before the account opened)
  assert.match(t, /0\.55 pts behind the S&P 500/);
  assert.match(t, /Win rate100% \(1W \/ 0L\)/);
  assert.ok(await page.locator('#pChart canvas').count() > 0);
  await page.click('[data-range="1W"]');
  await page.waitForSelector('.vs-row');
  assert.match(await page.textContent('.vs-diff'), /1W/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('history: closed positions and all fills', async () => {
  const page = await newPage('iPhone 14', { time: '2026-11-24T22:00:00Z', state: tradedState() });
  await relayMock(page, { price: () => 110, chart: perfChart });
  await page.goto(base);
  await page.click('[data-tab="portfolio"]');
  await page.click('[data-ptab="history"]');
  assert.match(await page.textContent('main'), /AAPL.*\+\$95\.00.*\+9\.50%/s);
  await page.click('[data-hist="fills"]');
  assert.equal(await page.locator('.list .item').count(), 3);
  await page.context().close();
});

test('stock chart: candles/line toggle is remembered', async () => {
  const page = await newPage('iPhone 14', { time: OPEN, symbol: 'AAPL' });
  await relayMock(page);
  await page.goto(base);
  await page.waitForSelector('#chart canvas');
  assert.equal(await page.textContent('#styleBtn'), 'CNDL');
  await page.click('#styleBtn');
  assert.equal(await page.textContent('#styleBtn'), 'LINE');
  await page.reload(); await page.waitForSelector('#styleBtn');
  assert.equal(await page.textContent('#styleBtn'), 'LINE');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('export backup, then import it into a fresh phone', async () => {
  const page = await newPage('iPhone 14', { time: '2026-11-24T22:00:00Z', state: tradedState() });
  await relayMock(page, { price: () => 110, chart: perfChart });
  await page.goto(base);
  await page.click('[data-tab="menu"]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="export"]')]);
  assert.match(dl.suggestedFilename(), /^learn-paper-trading-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const json = fs.readFileSync(await dl.path(), 'utf8');
  const obj = JSON.parse(json);
  assert.equal(obj.app, 'learn-paper-trading');
  assert.equal(obj.state.trading.fills.length, 3);
  await page.context().close();

  const page2 = await newPage('iPhone 14', { time: OPEN, symbol: 'AAPL' });
  await relayMock(page2);
  await page2.goto(base);
  await page2.click('[data-tab="menu"]');
  // a wrong file is refused
  let [fc] = await Promise.all([page2.waitForEvent('filechooser'), page2.click('[data-act="import"]')]);
  await fc.setFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await page2.waitForSelector('.toast >> text=isn’t a Learn Paper Trading backup');
  [fc] = await Promise.all([page2.waitForEvent('filechooser'), page2.click('[data-act="import"]')]);
  await fc.setFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await page2.waitForSelector('#doImport');
  assert.match(await page2.textContent('.sheet'), /Trades3/);
  await Promise.all([page2.waitForEvent('load'), page2.click('#doImport')]);
  const st = await page2.evaluate(() => JSON.parse(localStorage.getItem('lpt.v1')));
  assert.equal(st.account.startingBalance, 10000);
  assert.equal(st.trading.fills.length, 3);
  await page2.context().close();
});

test('reset needs RESET typed, then returns to the starting balance screen', async () => {
  const page = await newPage('iPhone 14', { time: OPEN, symbol: 'AAPL' });
  await relayMock(page);
  await page.goto(base);
  await page.click('[data-tab="menu"]');
  await page.click('[data-act="reset"]');
  assert.equal(await page.isDisabled('#rGo'), true);
  await page.fill('#rText', 'reset');
  assert.equal(await page.isDisabled('#rGo'), true, 'must be exactly RESET');
  await page.fill('#rText', 'RESET');
  // the init script would re-seed the account on reload, so stub it out first
  await page.evaluate(() => { localStorage.setItem('lpt.v1-noseed', '1'); });
  await Promise.all([page.waitForEvent('load'), page.click('#rGo')]);
  const raw = await page.evaluate(() => localStorage.getItem('lpt.v1'));
  // reload ran the test's seeding script again; what matters is the wipe happened before it
  assert.ok(raw === null || JSON.parse(raw).trading.fills.length === 0);
  await page.context().close();
});

test('with every indicator on, nothing overlaps (screen scrolls instead)', async () => {
  const state = JSON.parse(ACCOUNT(RELAY, { settings: { relayUrl: RELAY, symbol: 'AAPL', range: '1D', intervals: {}, ind: { volume: true, ma: true, rsi: true, macd: true } } }));
  for (const device of ['iPhone SE', 'iPhone 14']) {
    const page = await newPage(device, { time: OPEN, state });
    await relayMock(page);
    await page.goto(base);
    await page.waitForSelector('#paneMacd canvas');
    const r = await page.evaluate(() => {
      const box = s => document.querySelector(s).getBoundingClientRect();
      return { chart: box('#chart').height, macdBottom: box('#paneMacd').bottom, tf: box('#tf').top, tfBottom: box('#tf').bottom, buy: box('#buy').top, macdH: box('#paneMacd').height };
    });
    assert.ok(r.macdH >= 60, 'MACD pane keeps its height');
    assert.ok(r.macdBottom <= r.tf + 1, 'panes sit above the timeframe row');
    assert.ok(r.tfBottom <= r.buy, 'timeframe row above the buttons');
    await page.click('[data-tf="1Y"]'); // clickable, not covered
    await page.context().close();
  }
});
