/**
 * Learn Paper Trading — Yahoo Finance relay (Cloudflare Worker, free tier).
 *
 * Endpoints (all GET, JSON):
 *   /health
 *   /search?q=apple
 *   /chart?symbol=AAPL&range=1d&interval=5m[&prepost=1][&events=1][&period1=..&period2=..]
 *   /quote?symbols=AAPL,SPY            (max 20 symbols)
 *
 * No API keys. Paste this whole file into the Cloudflare dashboard editor.
 */

// Sites allowed to call this relay from a browser. Requests with no Origin
// header (e.g. you opening a URL directly) are also allowed, for testing.
const ALLOWED_ORIGINS = ['https://kasene08.github.io'];
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
// Keep this short: Yahoo answers 429 to full browser UAs that arrive without cookies.
const UA = 'Mozilla/5.0 (compatible; LearnPaperTradingRelay/1.0)';
const INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']);
const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const SYMBOL = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/;
// Major US exchanges as Yahoo labels them (Nasdaq tiers, NYSE, NYSE American, NYSE Arca, Cboe BZX).
const US_EXCHANGES = new Set(['NMS', 'NGM', 'NCM', 'NAS', 'NYQ', 'NYS', 'ASE', 'PCX', 'BTS', 'CBO']);

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin');
    const okOrigin = !origin || ALLOWED_ORIGINS.includes(origin) || LOCAL_ORIGIN.test(origin);
    const cors = {
      'Access-Control-Allow-Origin': origin && okOrigin ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!okOrigin) return json({ error: 'origin not allowed' }, 403, cors);
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, cors);

    const url = new URL(request.url);
    try {
      switch (url.pathname.replace(/\/+$/, '') || '/') {
        case '/':
        case '/health': return json({ ok: true, time: Date.now() }, 200, cors, 0);
        case '/search': return json(await search(url.searchParams.get('q')), 200, cors, 300);
        case '/chart': return json(await chart(url.searchParams), 200, cors, 15);
        case '/quote': return json(await quotes(url.searchParams.get('symbols')), 200, cors, 2);
        default: return json({ error: 'not found' }, 404, cors);
      }
    } catch (e) {
      const status = e.status || 502;
      return json({ error: e.message || 'upstream error' }, status, cors);
    }
  },
};

function json(body, status, cors, maxAge = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${maxAge}`, ...cors },
  });
}

function fail(message, status = 400) { const e = new Error(message); e.status = status; return e; }

// Fetch from Yahoo, trying query1 then query2 (helps when one is throttled).
async function yahoo(path) {
  let last;
  for (const host of HOSTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(host + path, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
      if (res.ok) return await res.json();
      if (res.status === 404) {
        const body = await res.json().catch(() => null);
        throw fail(body?.chart?.error?.description || 'symbol not found', 404);
      }
      last = fail(`upstream ${res.status}`, res.status === 429 ? 429 : 502);
    } catch (e) {
      if (e.status === 404) throw e;
      last = e.status ? e : fail(e.name === 'AbortError' ? 'upstream timeout' : 'upstream unreachable', 504);
    } finally { clearTimeout(timer); }
  }
  throw last;
}

function cleanSymbol(s) {
  s = String(s || '').trim().toUpperCase();
  if (!SYMBOL.test(s)) throw fail('bad symbol: ' + s);
  return s;
}

async function search(q) {
  q = String(q || '').trim();
  if (!q || q.length > 40) throw fail('missing or too-long query');
  const data = await yahoo(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=15&newsCount=0&listsCount=0&enableFuzzyQuery=true`);
  const results = (data.quotes || [])
    .filter(x => x.quoteType === 'EQUITY' && US_EXCHANGES.has(x.exchange) && !x.symbol.includes('.'))
    .map(x => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, exchange: x.exchDisp || x.exchange, type: x.quoteType }));
  return { query: q, results };
}

async function chart(p) {
  const symbol = cleanSymbol(p.get('symbol'));
  const interval = p.get('interval') || '1d';
  if (!INTERVALS.has(interval)) throw fail('bad interval');
  let qs = `interval=${interval}`;
  const p1 = p.get('period1'), p2 = p.get('period2');
  if (p1 && /^\d{1,11}$/.test(p1)) qs += `&period1=${p1}&period2=${/^\d{1,11}$/.test(p2 || '') ? p2 : Math.floor(Date.now() / 1000)}`;
  else {
    const range = p.get('range') || '1mo';
    if (!RANGES.has(range)) throw fail('bad range');
    qs += `&range=${range}`;
  }
  if (p.get('prepost') === '1') qs += '&includePrePost=true';
  if (p.get('events') === '1') qs += '&events=div%2Csplits';
  const data = await yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`);
  const r = data?.chart?.result?.[0];
  if (!r) throw fail(data?.chart?.error?.description || 'no data', 404);
  return shapeChart(r);
}

function shapeChart(r) {
  const m = r.meta || {}, ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    bars.push([ts[i], round(o), round(h), round(l), round(c), q.volume?.[i] || 0]);
  }
  const ev = r.events || {};
  return {
    meta: {
      symbol: m.symbol, name: m.longName || m.shortName || m.symbol, exchange: m.fullExchangeName || m.exchangeName,
      type: m.instrumentType, currency: m.currency, price: m.regularMarketPrice, time: m.regularMarketTime,
      previousClose: m.previousClose ?? m.chartPreviousClose, chartPreviousClose: m.chartPreviousClose,
      dayHigh: m.regularMarketDayHigh, dayLow: m.regularMarketDayLow, volume: m.regularMarketVolume,
      high52: m.fiftyTwoWeekHigh, low52: m.fiftyTwoWeekLow, priceHint: m.priceHint, granularity: m.dataGranularity,
      tradingPeriod: m.currentTradingPeriod ? {
        pre: [m.currentTradingPeriod.pre?.start, m.currentTradingPeriod.pre?.end],
        regular: [m.currentTradingPeriod.regular?.start, m.currentTradingPeriod.regular?.end],
        post: [m.currentTradingPeriod.post?.start, m.currentTradingPeriod.post?.end],
      } : null,
    },
    bars,
    dividends: Object.values(ev.dividends || {}).map(d => ({ date: d.date, amount: d.amount })).sort((a, b) => a.date - b.date),
    splits: Object.values(ev.splits || {}).map(s => ({ date: s.date, numerator: s.numerator, denominator: s.denominator })).sort((a, b) => a.date - b.date),
  };
}

function round(x) { return Math.round(x * 10000) / 10000; }

async function quotes(list) {
  const symbols = [...new Set(String(list || '').split(',').map(s => s.trim()).filter(Boolean))];
  if (!symbols.length) throw fail('missing symbols');
  if (symbols.length > 20) throw fail('max 20 symbols');
  const out = {};
  await Promise.all(symbols.map(async raw => {
    try {
      const symbol = cleanSymbol(raw);
      const c = await chart(new URLSearchParams({ symbol, range: '1d', interval: '1m', prepost: '1' }));
      out[symbol] = toQuote(c);
    } catch (e) { out[String(raw).toUpperCase()] = { error: e.message }; }
  }));
  return { time: Date.now(), quotes: out };
}

// Reduce a 1-day/1-minute chart to a quote. The last bar gives the latest
// trade, including pre-market and after-hours prints.
function toQuote(c) {
  const m = c.meta, last = c.bars[c.bars.length - 1];
  const lastTime = last ? last[0] : m.time;
  const mins = last ? etMinutes(last[0]) : 600;
  const extended = mins < 570 || mins >= 960; // outside 9:30–16:00 ET
  return {
    symbol: m.symbol, name: m.name, exchange: m.exchange, type: m.type,
    price: m.price, previousClose: m.previousClose, regularTime: m.time,
    last: last ? last[4] : m.price, lastTime, extended: !!extended,
    dayHigh: m.dayHigh, dayLow: m.dayLow, volume: m.volume, tradingPeriod: m.tradingPeriod,
  };
}

const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
function etMinutes(ts) {
  const parts = Object.fromEntries(ET.formatToParts(new Date(ts * 1000)).map(p => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}
