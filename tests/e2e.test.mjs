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
function relayMock(page, { price = () => 101.5, calls = [] } = {}) {
  return page.route(`${RELAY}/**`, route => {
    const u = new URL(route.request().url()); calls.push(u.pathname + u.search);
    const send = body => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
    const sym = (u.searchParams.get('symbol') || u.searchParams.get('symbols') || 'SPY').split(',')[0];
    if (u.pathname === '/search') return send({ results: [
      { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', type: 'EQUITY' },
      { symbol: 'APLE', name: 'Apple Hospitality REIT, Inc.', exchange: 'NYSE', type: 'EQUITY' },
      { symbol: 'APLY', name: 'YieldMax AAPL Option Income ETF', exchange: 'NYSE Arca', type: 'ETF' }] });
    if (u.pathname === '/chart') return send({ meta: { symbol: sym, name: sym === 'AAPL' ? 'Apple Inc.' : 'SPDR S&P 500 ETF', previousClose: 100 }, bars: mockBars(60, 1795530600, 300), dividends: [], splits: [] });
    if (u.pathname === '/quote') { const p = price(); return send({ quotes: { [sym]: { symbol: sym, name: sym === 'AAPL' ? 'Apple Inc.' : 'SPDR S&P 500 ETF', price: p, previousClose: 100, regularTime: Math.floor(Date.now() / 1000), last: p, lastTime: Math.floor(Date.now() / 1000), extended: false } } }); }
    return send({ ok: true });
  });
}
const ACCOUNT = (relayUrl = RELAY) => JSON.stringify({ version: 1, account: { startingBalance: 25000, cash: 25000, createdAt: 1795500000000 }, settings: { relayUrl, symbol: null, range: '1D', intervals: {} }, recentSearches: [], dismissedTips: {} });

async function newPage(device = 'iPhone 14', { time, account = true, relayUrl } = {}) {
  const ctx = await browser.newContext({ ...devices[device] });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  if (time) await page.clock.install({ time: new Date(time) });
  if (account) await ctx.addInitScript(s => { if (!localStorage.getItem('lpt.v1')) localStorage.setItem('lpt.v1', s); }, ACCOUNT(relayUrl));
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
  assert.equal(saved.cash, 12345.67);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('no relay configured: friendly setup prompt instead of errors', async () => {
  const page = await newPage('iPhone 14', { relayUrl: '' });
  await page.goto(base);
  await page.waitForSelector('.chart-msg >> text=data relay');
  await page.click('#setRelay');
  await page.waitForSelector('text=DATA RELAY');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('home: default SPY chart, quote, colors; Buy shows Phase 3 notice', async () => {
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
  assert.match(await page.textContent('.toast'), /Phase 3/);
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

test('tips can be dismissed and stay dismissed', async () => {
  const page = await newPage('iPhone 14', { time: '2026-11-24T15:00:00Z' });
  await relayMock(page);
  await page.goto(base);
  const first = await page.textContent('.tip');
  await page.click('.tip .x');
  const second = await page.textContent('.tip');
  assert.notEqual(first, second);
  await page.reload(); await page.waitForSelector('.tip');
  assert.equal(await page.textContent('.tip'), second);
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
  assert.deepEqual(page.errors, []);
  await page.context().close();
});
