// Order ticket: pick side, type, amount and prices; see an estimate and any warnings; review; place.
import * as E from './engine.js';
import * as store from './store.js';
import * as trader from './trader.js';
import * as fmt from './format.js';
import { $, sheet, closeSheet, toast } from './ui.js';
import * as learn from './learn.js';

const DESC = {
  market: { buy: 'Buys right away at the best available price (during market hours).', sell: 'Sells right away at the best available price (during market hours).' },
  limit: { buy: 'Buys only at your limit price or lower. It may not fill.', sell: 'Sells only at your limit price or higher. It may not fill.' },
  stop: { buy: 'Waits until the price rises to your stop, then buys at market.', sell: 'Waits until the price falls to your stop, then sells at market.' },
  stop_limit: { buy: 'When the price reaches your stop, it becomes a limit order at your limit price.', sell: 'When the price reaches your stop, it becomes a limit order at your limit price.' },
  trailing_stop: { buy: 'A stop that follows the price down by a set $ or %, and buys if the price rises back by that much.', sell: 'A stop that follows the price up by a set $ or %, and sells if the price drops back by that much.' },
  bracket: { buy: 'Buys, then automatically places a take-profit sell above and a stop-loss sell below. When one of those fills, the other is canceled.' },
  oco: { sell: 'Two sell orders on shares you own: a take-profit above and a stop-loss below. When one fills, the other is canceled (one-cancels-other).' },
};
const SHOW = {
  market: ['amount', 'dollars'], limit: ['amount', 'limit', 'tif', 'ext'], stop: ['amount', 'stop', 'tif'],
  stop_limit: ['amount', 'stop', 'limit', 'tif'], trailing_stop: ['amount', 'trail', 'tif'],
  bracket: ['amount', 'entry', 'tp', 'sl', 'tif'], oco: ['amount', 'tp', 'sl', 'tif'],
};

export async function openTicket({ symbol, name, side = 'buy' }) {
  const t = { symbol, name, side, type: 'market', mode: 'shares', qty: '', notional: '', limit: '', stop: '', trailKind: '%', trail: '', entryType: 'market', takeProfit: '', stopLoss: '', tif: 'day', ext: false };
  let touched = false;
  const q0 = trader.getQuote(symbol);
  const el = sheet(`
    <div class="tk-head">
      <div class="seg side" id="tSide"><button data-side="buy">BUY</button><button data-side="sell">SELL</button></div>
      <button class="x" data-close aria-label="Close">✕</button>
    </div>
    <div class="row tk-sym"><span><b class="w">${fmt.esc(symbol)}</b> <span class="d">${fmt.esc(name || '')}</span></span><span class="w" id="tPx">${q0 ? fmt.price(q0.last ?? q0.price) : '—'}</span></div>
    <div class="sect0">ORDER TYPE</div>
    <div class="chips" id="tTypes"></div>
    <div class="tdesc" id="tDesc"></div>
    <div class="f" data-f="amount">
      <div class="row"><span class="lbl" id="tAmtLbl">Shares</span><span class="seg sm" id="tMode" data-f="dollars"><button data-mode="shares">SHARES</button><button data-mode="dollars">$ AMOUNT</button></span></div>
      <label class="field"><span class="pre" id="tAmtPre"></span><input id="tQty" inputmode="decimal" autocomplete="off" placeholder="0"><button class="max" id="tMax" hidden>MAX</button></label>
    </div>
    <div class="f" data-f="entry"><div class="lbl">Entry</div><div class="seg" id="tEntry"><button data-entry="market">MARKET</button><button data-entry="limit">LIMIT</button></div></div>
    <div class="f" data-f="limit"><div class="lbl" id="tLimLbl">Limit price</div><label class="field"><span class="pre">$</span><input id="tLimit" inputmode="decimal" autocomplete="off"></label></div>
    <div class="f" data-f="stop"><div class="lbl">Stop price</div><label class="field"><span class="pre">$</span><input id="tStop" inputmode="decimal" autocomplete="off"></label></div>
    <div class="f" data-f="trail"><div class="row"><span class="lbl">Trail by</span><span class="seg sm" id="tTrailKind"><button data-tk="%">%</button><button data-tk="$">$</button></span></div><label class="field"><span class="pre" id="tTrailPre">%</span><input id="tTrail" inputmode="decimal" autocomplete="off"></label></div>
    <div class="f" data-f="tp"><div class="lbl">Take-profit (sell limit)</div><label class="field"><span class="pre">$</span><input id="tTp" inputmode="decimal" autocomplete="off"></label></div>
    <div class="f" data-f="sl"><div class="lbl">Stop-loss (sell stop)</div><label class="field"><span class="pre">$</span><input id="tSl" inputmode="decimal" autocomplete="off"></label></div>
    <div class="f" data-f="tif"><div class="lbl">Time in force</div><div class="seg" id="tTif"><button data-tif="day">DAY</button><button data-tif="gtc">GTC · 180 DAYS</button></div></div>
    <div class="f" data-f="ext"><label class="toggle"><input type="checkbox" id="tExt"><span></span> Extended hours (pre-market / after-hours)</label></div>
    <div class="est" id="tEst"></div>
    <div id="tMsgs"></div>
    <button class="btn" id="tReview">REVIEW ORDER</button>`, null, 'ticket');

  const inputs = { tQty: 'qty', tLimit: 'limit', tStop: 'stop', tTrail: 'trail', tTp: 'takeProfit', tSl: 'stopLoss' };
  for (const [id, key] of Object.entries(inputs)) $('#' + id, el).addEventListener('input', e => { t[key] = e.target.value.replace(/[$,\s]/g, ''); if (key === 'qty') t.notional = t.qty; update(); });
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.side) { t.side = b.dataset.side; if (!DESC[t.type][t.side]) t.type = 'market'; }
    else if (b.dataset.type) { t.type = b.dataset.type; learn.emit('type:' + t.type); if (t.type !== 'market') t.mode = 'shares'; if ((t.type === 'limit' || (t.type === 'bracket' && t.entryType === 'limit')) && !t.limit) { const q = trader.getQuote(symbol); if (q) { t.limit = String(E.roundPrice(q.last ?? q.price)); $('#tLimit', el).value = t.limit; } } }
    else if (b.dataset.mode) { t.mode = b.dataset.mode; if (t.mode === 'dollars') learn.emit('mode:dollars'); }
    else if (b.dataset.entry) { t.entryType = b.dataset.entry; }
    else if (b.dataset.tk) t.trailKind = b.dataset.tk;
    else if (b.dataset.tif) { t.tif = b.dataset.tif; if (t.tif === 'gtc') learn.emit('gtc'); }
    else if (b.id === 'tMax') { t.mode = 'shares'; t.qty = String(E.availableShares(store.get(), symbol)); $('#tQty', el).value = t.qty; }
    else if (b.id === 'tReview') { touched = true; return review(); }
    else return;
    update();
  });
  $('#tExt', el).addEventListener('change', e => { t.ext = e.target.checked; if (t.ext) { t.tif = 'day'; learn.emit('ext'); } update(); });

  function input() {
    const q = trader.getQuote(symbol);
    return {
      symbol, name, side: t.side, type: t.type, tif: t.tif, ext: t.type === 'limit' && t.ext,
      qty: t.mode === 'shares' ? t.qty : null, notional: t.type === 'market' && t.mode === 'dollars' ? t.notional : null,
      limit: t.limit, stop: t.stop, trail: { kind: t.trailKind, value: t.trail }, entryType: t.entryType,
      takeProfit: t.takeProfit, stopLoss: t.stopLoss, tradable: !q || !q.type || q.type === 'EQUITY',
    };
  }
  function pv() {
    const q = trader.getQuote(symbol);
    return E.preview(store.get(), input(), { now: Date.now(), price: q ? (q.last ?? q.price) : 0 });
  }

  function update() {
    const types = Object.keys(E.TYPES).filter(k => DESC[k][t.side]);
    $('#tTypes', el).innerHTML = types.map(k => `<button data-type="${k}" class="${k === t.type ? 'on' : ''}">${E.TYPES[k]}</button>`).join('');
    $('#tSide', el).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.side === t.side));
    $('#tSide', el).dataset.side = t.side;
    $('#tDesc', el).textContent = DESC[t.type][t.side];
    const show = new Set(SHOW[t.type]);
    if (t.type === 'bracket' && t.entryType === 'limit') show.add('limit');
    if (t.type === 'bracket' && t.entryType === 'market') show.delete('tif');
    el.querySelectorAll('[data-f]').forEach(f => { f.hidden = !show.has(f.dataset.f); });
    $('#tMode', el).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === t.mode));
    $('#tEntry', el).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.entry === t.entryType));
    $('#tTrailKind', el).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tk === t.trailKind));
    $('#tTif', el).querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.tif === t.tif); b.disabled = t.ext && b.dataset.tif === 'gtc'; });
    $('#tTrailPre', el).textContent = t.trailKind;
    $('#tLimLbl', el).textContent = t.type === 'bracket' ? 'Entry limit price' : 'Limit price';
    const dollars = t.type === 'market' && t.mode === 'dollars';
    $('#tAmtLbl', el).textContent = dollars ? 'Dollar amount' : 'Shares';
    $('#tAmtPre', el).textContent = dollars ? '$' : '#';
    $('#tMax', el).hidden = t.side !== 'sell' || dollars;
    const q = trader.getQuote(symbol);
    if (q) $('#tPx', el).textContent = fmt.price(q.last ?? q.price);

    const r = pv(), s = store.get(), now = Date.now();
    const est = r.estimate;
    const avail = E.availableShares(s, symbol);
    $('#tEst', el).innerHTML = est ? `
      <div class="kv"><span class="d">Est. price</span><span class="w">${fmt.price(est.price)}</span></div>
      <div class="kv"><span class="d">Shares</span><span class="w">${est.qty ? +est.qty.toFixed(3) : '—'}</span></div>
      ${t.side === 'sell' ? `<div class="kv"><span class="d">Reg. fees (est.)</span><span class="w">${fmt.money(est.fees.total)}</span></div>` : ''}
      <div class="kv"><span class="d">${t.side === 'buy' ? 'Est. cost' : 'Est. proceeds'}</span><span class="w">${fmt.money(est.total)}</span></div>
      <div class="kv"><span class="d">${t.side === 'buy' ? 'Buying power' : 'Shares you can sell'}</span><span class="c">${t.side === 'buy' ? fmt.money(E.buyingPower(s, now)) : avail}</span></div>` : '';
    const errs = touched ? r.errors : r.errors.filter(x => !/^Enter |^Choose |^Pick /.test(x));
    $('#tMsgs', el).innerHTML = errs.map(x => `<div class="msg err">⚠ ${fmt.esc(x)}</div>`).join('') + r.warnings.map(w => `<div class="msg ${w.code}">› ${fmt.esc(w.text)}</div>`).join('');
    const btn = $('#tReview', el);
    btn.className = 'btn ' + (t.side === 'buy' ? 'buy' : 'sell');
  }

  function review() {
    update();
    const r = pv();
    if (!r.ok) return;
    const o = r.normalized, est = r.estimate;
    if (o.type === 'market' && r.warnings.some(w => w.code === 'queued')) learn.emit('warn:queued:market');
    const lines = [];
    if (o.type === 'bracket') lines.push(`Buy ${o.qty} ${symbol} ${o.entryType === 'limit' ? `with a limit of $${o.limit}` : 'at market'}`, `Then sell at $${o.takeProfit} (take-profit) or $${o.stopLoss} (stop-loss), whichever comes first. The exits stay open up to 180 days.`);
    else if (o.type === 'oco') lines.push(`Sell ${o.qty} ${symbol} at $${o.takeProfit} (take-profit) or $${o.stopLoss} (stop-loss), whichever comes first.`);
    else lines.push(E.describe(o).replace(/ sh /, ' shares of '));
    if (o.type !== 'bracket') lines.push(o.ext ? 'Extended hours only · Day' : o.tif === 'gtc' ? "Good 'til canceled (up to 180 days)" : 'Day order (expires at the close)');
    sheet(`
      <h3>REVIEW ${o.side === 'buy' ? '<span class="up">BUY</span>' : '<span class="down">SELL</span>'} ORDER</h3>
      ${lines.map(l => `<p class="w">${fmt.esc(l)}</p>`).join('')}
      <div class="est">
        <div class="kv"><span class="d">Est. price</span><span class="w">${fmt.price(est.price)}</span></div>
        <div class="kv"><span class="d">${o.side === 'buy' ? 'Est. cost' : 'Est. proceeds'}</span><span class="w">${fmt.money(est.total)}</span></div>
      </div>
      ${r.warnings.map(w => `<div class="msg ${w.code}">› ${fmt.esc(w.text)}</div>`).join('')}
      <p class="d small">Simulated order with pretend money. Not financial advice.</p>
      <div class="btns"><button class="btn" id="rEdit" style="border-color:var(--line-hi)">EDIT</button><button class="btn ${o.side === 'buy' ? 'buy' : 'sell'}" id="rPlace">PLACE ${o.side.toUpperCase()}</button></div>`,
      s2 => {
        $('#rEdit', s2).addEventListener('click', () => openTicketWith(t));
        $('#rPlace', s2).addEventListener('click', async e => {
          e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span>';
          const q = await trader.freshQuote(symbol);
          if (!q) { toast('Couldn’t get a current price. Check your connection and try again.'); return openTicketWith(t); }
          const res = trader.place(input(), q);
          if (!res.ok) { learn.emit('rejected'); toast(res.errors[0] || 'Order rejected.'); return openTicketWith(t); }
          closeSheet();
          const f = res.fills?.[0];
          toast(f ? `Filled: ${f.side === 'buy' ? 'bought' : 'sold'} ${+f.qty.toFixed(3)} ${symbol} at $${fmt.price(f.price)}.` : `Order placed: ${E.describe(res.orders[0])}.`, 5000);
        });
      });
  }

  // reopen with the same values (after Edit)
  function openTicketWith(state) { closeSheet(); openTicket({ symbol, name, side: state.side }).then(api => api.restore(state)); }

  update();
  learn.emit('ticket');
  trader.freshQuote(symbol).then(update);
  return {
    restore(state) {
      Object.assign(t, state);
      for (const [id, key] of Object.entries(inputs)) $('#' + id, el).value = t[key] || '';
      $('#tExt', el).checked = t.ext;
      update();
    },
  };
}
