// Learning layer: hints in the HUD, triggered by time, actions, mistakes and progress.
// Pacing (calm): one hint at a time; a new one at most every 2 minutes; mistakes show right away.
// Fade-out (medium): each hint shows at most twice; hints thin out as your trade count grows
// (basic ones over ~20→50 trades); mistake warnings never fully stop.
// Hints teach; they never say what to buy or sell.
import * as store from './store.js';

const GAP_MS = 2 * 60 * 1000;
const MISTAKE_COOLDOWN = 10 * 60 * 1000;
const PENDING_TTL = 10 * 60 * 1000;
const MAX_SHOWS = 2;

// kind: lesson (idle curriculum, in order) | tip (event) | mistake (event, immediate)
// from / to: trade counts. Shown fully until `to`, then thins out to zero at 2.5×to.
const H = (id, kind, on, text, opts = {}) => ({ id, kind, on, text, from: 0, to: 20, ...opts });
export const HINTS = [
  // ---- lessons: beginner → comfortable (shown while browsing, in this order) ----
  H('candles', 'lesson', null, 'Each candle is one time period. Green = the price closed higher than it opened; red = lower. The thin "wicks" show the highest and lowest prices in that period.'),
  H('search', 'lesson', null, 'Tap the ticker above the chart (like SPY) to look up any US stock by name or symbol.'),
  H('timeframes', 'lesson', null, '1D shows today in small candles; 1Y and MAX zoom out. The same stock can look calm on one timeframe and wild on another.'),
  H('stock-is', 'lesson', null, 'A share is a tiny piece of ownership in a company. Its price moves as buyers and sellers change what they are willing to pay.'),
  H('hours', 'lesson', null, 'Regular trading is 9:30 AM–4:00 PM Eastern, Monday to Friday, except market holidays. The bar at the top always shows the current session.'),
  H('account-value', 'lesson', null, 'Account value = your cash + what your shares are worth right now. Buying power is the cash you can actually spend on new orders.'),
  H('market-vs-limit', 'lesson', null, 'A market order fills right away at whatever the price is. A limit order sets the most you will pay (or least you will accept) but might not fill.'),
  H('spread', 'lesson', null, 'There are two prices at any moment: the bid (what buyers pay) and the ask (what sellers want). Market orders cross that gap, so fills land a little worse than the last price.'),
  H('fractional', 'lesson', null, 'You don\'t need to afford a whole share. Fractional shares (down to 0.001) or a dollar amount let you own a slice of an expensive stock.'),
  H('diversify', 'lesson', null, 'Diversifying means spreading money across several companies, so one bad surprise can\'t sink your whole account.', { from: 1 }),
  H('position-size', 'lesson', null, 'Position size is how much of your account goes into one trade. Many traders cap each position at a small slice of their account so a single loss stays survivable.', { from: 1 }),
  H('unrealized', 'lesson', null, 'Open (unrealized) P&L moves with the price and isn\'t locked in. It becomes closed (realized) P&L only when you sell.', { from: 1 }),
  H('benchmark', 'lesson', null, 'Portfolio → Performance compares you with the S&P 500, a basket of 500 big US companies. Beating it over time is harder than it sounds.', { from: 2 }),
  H('tif', 'lesson', null, 'Day orders expire at the close if they don\'t fill. GTC ("good \'til canceled") orders stay open for up to 180 days.', { from: 2 }),
  H('stops', 'lesson', null, 'A stop order waits until the price reaches a level you pick, then becomes a market order. People often use sell stops to limit how much they can lose.', { from: 2 }),
  H('settlement', 'lesson', null, 'When you sell, the cash takes one business day to "settle." You can reuse it right away, but sell the new shares too early and it\'s a good-faith violation.', { from: 2 }),
  H('volatility', 'lesson', null, 'Volatility is how much a price swings. Big swings mean bigger possible gains and bigger possible losses. Long wicks and tall candles are a sign of it.', { from: 3, to: 30 }),
  H('indicators', 'lesson', null, 'Tap IND under the chart to try indicators like moving averages or RSI. They summarize past prices; they can\'t tell you what happens next.', { from: 3, to: 30 }),
  H('dividends', 'lesson', null, 'Some companies pay dividends: cash for each share you own, usually every 3 months. You must own the shares before the "ex-dividend" date.', { from: 3, to: 30 }),
  H('recaps', 'lesson', null, 'When you fully sell a position, you get a recap of what the indicators showed when you bought and what happened next. Old recaps live in Portfolio → History.', { from: 3, to: 30 }),
  H('win-rate', 'lesson', null, 'Win rate isn\'t everything. Winning 40% of the time can still make money if wins are bigger than losses, and 70% can lose money if losses are bigger.', { from: 5, to: 30 }),
  H('fomo', 'lesson', null, 'FOMO (fear of missing out) pushes people to buy after big jumps. Noticing how you feel before you tap Buy is a real skill.', { from: 5, to: 30 }),
  H('panic', 'lesson', null, 'Prices often wiggle down before they move either way. Deciding your exit before you buy (a stop or a target) helps avoid panic decisions.', { from: 5, to: 30 }),
  H('trailing', 'lesson', null, 'A trailing stop follows the price up and only triggers if the price falls back by your chosen amount. It\'s one way to protect gains without picking an exact exit.', { from: 6, to: 30 }),
  H('bracket', 'lesson', null, 'A bracket order buys and immediately sets both a take-profit and a stop-loss. When one fills, the other cancels. It plans the whole trade up front.', { from: 6, to: 30 }),
  H('gaps', 'lesson', null, 'News (like earnings reports) can make a stock "gap": open far from yesterday\'s close. Stop orders fill at the gap price, not your stop price.', { from: 8, to: 30 }),
  H('long-term', 'lesson', null, 'Short-term moves are mostly noise. Comparing your performance over months, not days, shows what your decisions are really doing.', { from: 8, to: 30 }),
  H('journal', 'lesson', null, 'Before each trade, try saying why you\'re making it in one sentence. Then compare it with the recap afterwards. That\'s how pros learn.', { from: 10, to: 30 }),
  H('compounding', 'lesson', null, 'Compounding: gains earn gains. +10% then −10% leaves you at −1%, because losses hit a bigger number. Avoiding big losses matters a lot.', { from: 10, to: 30 }),

  // ---- tips: triggered by what you do ----
  H('first-ticket', 'tip', 'ticket', 'This is the order ticket. Nothing happens until you tap Review and then Place, so explore freely.'),
  H('type-limit', 'tip', 'type:limit', 'Limit orders protect your price. If the stock never reaches your limit, the order just doesn\'t fill.'),
  H('type-stop', 'tip', 'type:stop', 'Stops turn into market orders when triggered, so the fill can be worse than the stop price if the price jumps.'),
  H('type-stop_limit', 'tip', 'type:stop_limit', 'Stop limit = stop trigger + price protection. The catch: if the price blows past your limit, it may never fill.'),
  H('type-trailing_stop', 'tip', 'type:trailing_stop', 'The trail follows the highest price since you placed the order. Check its current stop level in Portfolio → Overview.'),
  H('type-bracket', 'tip', 'type:bracket', 'Brackets plan the exit before you enter. The two exits stay open (up to 180 days) after the buy fills.'),
  H('type-oco', 'tip', 'type:oco', 'OCO = one-cancels-other. It\'s two sell orders on shares you own; whichever fills first cancels the other.'),
  H('dollars', 'tip', 'mode:dollars', 'Dollar orders buy whatever fraction of a share that amount gets. They are market orders during regular hours only.'),
  H('ext', 'tip', 'ext', 'Extended hours have fewer traders, so prices jump more and the gap between bid and ask is wider. That\'s why only limit orders are allowed.'),
  H('gtc', 'tip', 'gtc', 'GTC orders can fill weeks later, at a moment you\'re not watching. Review your open orders now and then.'),
  H('first-fill', 'tip', 'fill:buy', 'You own shares now. Watch Open P&L in Portfolio. It changes with every price move, but nothing is locked in until you sell.', { to: 3 }),
  H('first-sell', 'tip', 'fill:sell', 'Sale proceeds settle next business day. Your buying power includes them now, but selling a stock bought with them too soon is a good-faith violation.', { to: 5 }),
  H('first-win', 'tip', 'close:win', 'A closed position in profit. Check the recap: was it the plan, or luck? Both happen, and telling them apart is the skill.', { to: 10 }),
  H('first-loss', 'tip', 'close:loss', 'Losses are part of trading for everyone. What matters is keeping them small relative to wins. Your recap shows what happened during the trade.', { to: 10 }),
  H('performance', 'tip', 'performance', 'Both lines start at 0% on the first day of the range, so you can see who grew more since then.', { to: 25 }),
  H('ind-on', 'tip', 'ind:any', 'Indicators can disagree with each other, and none of them predict the future. Traders use them as context, not as instructions.', { to: 30 }),
  H('line-chart', 'tip', 'style:line', 'Line charts connect closing prices. They\'re easier to read at a glance, but they hide each period\'s high, low and open.'),
  H('pre', 'tip', 'session:pre', 'It\'s pre-market (4:00–9:30 AM ET). Prices are moving on thin trading; this app only allows limit orders from 7:00 to 9:28 AM.'),
  H('open15', 'tip', 'session:open', 'The first minutes after 9:30 AM are often the most hectic of the day, as overnight news gets priced in.', { to: 30 }),
  H('close15', 'tip', 'session:closing', 'The market closes soon. Day orders that haven\'t filled expire at the close.', { to: 30 }),
  H('post', 'tip', 'session:post', 'It\'s after-hours (4:00–8:00 PM ET). Companies often report earnings now, which can make prices jump.'),
  H('closed', 'tip', 'session:closed', 'The market is closed. Orders you place now wait for the next session, and market orders fill at the opening price, which can differ a lot.'),

  // ---- mistakes & risk: shown right away, never fully fade ----
  H('m-gfv', 'mistake', 'gfv', 'Good-faith violation recorded: those shares were bought with cash that hadn\'t settled yet. Three in 12 months restricts your account for 90 days. Waiting one business day avoids it.'),
  H('m-restricted', 'mistake', 'restricted', 'Your account is restricted to settled cash for 90 days because of 3 good-faith violations. Check Portfolio for the date it ends.'),
  H('m-queued', 'mistake', 'warn:queued:market', 'A market order placed while the market is closed fills at the next opening price, whatever it is. A limit order would cap that price.'),
  H('m-concentration', 'mistake', 'concentration', 'Over 40% of your account is now in one stock. That\'s a concentrated bet: one bad day for that company moves your whole account.'),
  H('m-bigmove', 'mistake', 'bigmove', 'This stock moved more than 8% today. Big moves often come with big swings in both directions, so prices can change fast between Review and Place.'),
  H('m-quickloss', 'mistake', 'quickloss', 'You closed a loss within a day of buying. Quick reversals can be a plan working (a stop) or a reaction. The recap can help you tell which.'),
  H('m-noposition', 'mistake', 'sell:none', 'This is a cash account: you can only sell shares you own. Selling shares you don\'t own (short selling) isn\'t allowed here.'),
  H('m-rejected', 'mistake', 'rejected', 'An order was rejected. Check Portfolio → History → Activity for the reason (often the price moved or cash wasn\'t enough when it triggered).'),
].map(h => ({ ...h, on: h.on }));

const byEvent = new Map();
for (const h of HINTS) if (h.on) (byEvent.get(h.on) || byEvent.set(h.on, []).get(h.on)).push(h);

// ---------------------------------------------------------------- state
const L = () => {
  const s = store.get();
  return s.learn || (s.learn = { seen: {}, current: null, lastShownAt: 0, pending: [], lastMistake: {}, explained: {}, recaps: {} });
};
const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });

export const trades = () => store.get().trading?.fills?.length || 0;

/** How likely a hint is to show given experience (1 = always, 0 = never). */
export function weight(h, n = trades()) {
  if (h.kind === 'mistake') return 1;
  if (n < h.from) return 0;
  if (n <= h.to) return 1;
  return Math.max(0, 1 - (n - h.to) / (h.to * 1.5));
}
const shows = id => L().seen[id] || 0;
const eligible = (h, n) => h.kind === 'mistake' || (shows(h.id) < MAX_SHOWS && weight(h, n) > 0);

/** Report something that happened. Mistakes show right away; tips queue for the next free slot. */
export function emit(event, ctx = {}, now = Date.now(), rand = Math.random) {
  const list = byEvent.get(event) || [];
  if (!list.length) return null;
  const n = trades();
  let shown = null;
  store.update(() => {
    const l = L();
    for (const h of list) {
      if (!eligible(h, n)) continue;
      if (h.kind === 'mistake') {
        if (now - (l.lastMistake[h.id] || 0) < MISTAKE_COOLDOWN) continue;
        l.lastMistake[h.id] = now;
        show(l, h, now); shown = h;
      } else if (rand() < weight(h, n) && !l.pending.some(p => p.id === h.id)) {
        l.pending.push({ id: h.id, at: now });
      }
    }
  });
  if (!shown) tick(now, rand); else notify();
  return shown;
}

function show(l, h, now) {
  l.current = { id: h.id, shownAt: now };
  l.lastShownAt = now;
  l.seen[h.id] = (l.seen[h.id] || 0) + 1;
}

/** Called periodically (and after events): fill the slot if it's free and the calm gap has passed. */
export function tick(now = Date.now(), rand = Math.random) {
  const l = L();
  if (l.current || now - l.lastShownAt < GAP_MS) return null;
  const n = trades();
  let pick = null;
  store.update(() => {
    l.pending = l.pending.filter(p => now - p.at < PENDING_TTL);
    while (l.pending.length && !pick) {
      const p = l.pending.pop(); // most recent first
      const h = HINTS.find(x => x.id === p.id);
      if (h && eligible(h, n)) pick = h;
    }
    if (!pick) pick = HINTS.find(h => h.kind === 'lesson' && shows(h.id) === 0 && eligible(h, n) && rand() < weight(h, n)) || null;
    if (pick) show(l, pick, now);
  });
  if (pick) notify();
  return pick;
}

export function current() {
  const c = L().current;
  return c ? { ...HINTS.find(h => h.id === c.id), shownAt: c.shownAt } : null;
}
export function dismiss(now = Date.now()) {
  store.update(() => { const l = L(); l.current = null; l.lastShownAt = now; });
  notify();
}

// ---------------------------------------------------------------- indicator explainers (first time you turn one on)
export const EXPLAIN = {
  volume: { title: 'Volume', body: [
    'Volume is how many shares traded in each candle. The faint bars at the bottom of the chart show it.',
    'Taller bars mean more trading. Volume often rises around news, earnings and the open/close of the day.',
    'Traders look at whether price moves happen on heavy or light volume to judge how much interest is behind them.'] },
  ma: { title: 'Moving averages', body: [
    'A moving average (MA) is the average closing price of the last N candles, redrawn at every candle. It smooths out the wiggles.',
    'This app draws three: 20 (short-term), 50 (medium) and 200 (long-term). On a daily chart, 200 ≈ the last 10 months.',
    'Many traders describe price above a rising average as an uptrend and below a falling one as a downtrend. Averages lag: they only show where price has been.'] },
  rsi: { title: 'RSI (Relative Strength Index)', body: [
    'RSI compares recent gains with recent losses over 14 candles and scales the result from 0 to 100.',
    'Above 70 is often called "overbought" and below 30 "oversold": the price has moved a lot in one direction, quickly.',
    'Prices can stay overbought or oversold for a long time, so RSI describes momentum. It doesn\'t predict a turn.'] },
  macd: { title: 'MACD', body: [
    'MACD is the gap between a fast (12) and a slow (26) average of price. The dashed line is a 9-candle average of MACD itself, called the signal line.',
    'The green/red bars show MACD minus the signal line. Many traders read bars above zero as upward momentum and below zero as downward.',
    'Like all indicators it\'s built from past prices, so it reacts after moves happen.'] },
};
export const isExplained = k => !!L().explained[k];
export function markExplained(k) { store.update(() => { L().explained[k] = Date.now(); }); }

// ---------------------------------------------------------------- recaps storage
export const recapFor = key => L().recaps[key] || null;
export function saveRecap(key, recap) { store.update(() => { L().recaps[key] = recap; }); }
