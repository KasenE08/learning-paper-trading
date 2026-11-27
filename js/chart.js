// Candlestick chart (TradingView Lightweight Charts, vendored).
import { etOffsetMinutes, isRegularHours, etYmd } from './market.js';
import * as I from './indicators.js';
import { textScale } from './ux.js';

// Timeframes: range chips, each with the candle sizes Yahoo serves for it.
export const TIMEFRAMES = {
  '1D': { range: '1d', intervals: ['1m', '2m', '5m', '15m', '30m', '1h'], def: '5m', prepost: true },
  '1W': { range: '5d', intervals: ['5m', '15m', '30m', '1h'], def: '30m', prepost: true },
  '1M': { range: '1mo', intervals: ['30m', '1h', '1d'], def: '1h', prepost: false },
  '1Y': { range: '1y', intervals: ['1d', '1wk'], def: '1d', prepost: false },
  'MAX': { range: 'max', intervals: ['1wk', '1mo'], def: '1mo', prepost: false },
};
export const INTERVAL_LABEL = { '1m': '1 min', '2m': '2 min', '5m': '5 min', '15m': '15 min', '30m': '30 min', '1h': '1 hour', '1d': '1 day', '1wk': '1 week', '1mo': '1 month' };
const INTERVAL_SEC = { '1m': 60, '2m': 120, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600 };

const C = { up: '#00ff9c', down: '#ff3b5c', upExt: 'rgba(0,255,156,.38)', downExt: 'rgba(255,59,92,.38)', text: '#7d92b3', grid: 'rgba(22,36,63,.9)', cross: 'rgba(61,242,255,.45)' };

// Lightweight Charts shows times as UTC, so shift each bar to New York wall-clock.
const shiftTs = ts => ts + etOffsetMinutes(new Date(ts * 1000)) * 60;

function baseChart(el, extra = {}) {
  const LWC = window.LightweightCharts;
  return LWC.createChart(el, {
    autoSize: true,
    layout: { attributionLogo: false, background: { type: 'solid', color: 'transparent' }, textColor: C.text, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: Math.round(10 * textScale()) },
    grid: { vertLines: { visible: false }, horzLines: { color: C.grid, style: LWC.LineStyle.Dashed } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: { borderVisible: false, rightOffset: 3, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true },
    crosshair: {
      mode: LWC.CrosshairMode.Normal,
      vertLine: { color: C.cross, labelBackgroundColor: '#0b2a33' },
      horzLine: { color: C.cross, labelBackgroundColor: '#0b2a33' },
    },
    handleScale: { axisPressedMouseMove: false },
    ...extra,
  });
}

/** Stock chart: candlesticks (default) or a close-price line. */
export function createCandleChart(el, { onHover, style = 'candles', rsiEl = null, macdEl = null } = {}) {
  const LWC = window.LightweightCharts;
  const chart = baseChart(el);
  const series = chart.addCandlestickSeries({
    upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
    priceLineColor: 'rgba(232,241,255,.5)', priceLineStyle: LWC.LineStyle.Dotted,
  });
  const line = chart.addLineSeries({ lineWidth: 2, visible: false, priceLineColor: 'rgba(232,241,255,.5)', priceLineStyle: LWC.LineStyle.Dotted, crosshairMarkerRadius: 4 });

  // ---- indicators (all off until turned on) ----
  const W = ['rgba(232,241,255,.9)', 'rgba(232,241,255,.55)', 'rgba(125,146,179,.85)']; // neutral whites for MAs
  const vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false, visible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  const mas = W.map(color => chart.addLineSeries({ color, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, visible: false }));
  const paneOpts = { timeScale: { visible: false, borderVisible: false }, handleScroll: false, handleScale: false, rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } }, crosshair: { horzLine: { visible: false }, vertLine: { color: C.cross } } };
  let rsiChart = null, rsiLine = null, macdChart = null, macdHist = null, macdLine = null, macdSig = null;
  if (rsiEl) {
    rsiChart = baseChart(rsiEl, paneOpts);
    rsiLine = rsiChart.addLineSeries({ color: 'rgba(232,241,255,.9)', lineWidth: 1, priceLineVisible: false, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
    for (const p of [70, 30]) rsiLine.createPriceLine({ price: p, color: 'rgba(125,146,179,.6)', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true });
  }
  if (macdEl) {
    macdChart = baseChart(macdEl, paneOpts);
    macdHist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    macdLine = macdChart.addLineSeries({ color: 'rgba(232,241,255,.9)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    macdSig = macdChart.addLineSeries({ color: 'rgba(125,146,179,.9)', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
  }
  // keep the panes scrolled/zoomed with the price chart (same bars → same logical indexes)
  chart.timeScale().subscribeVisibleLogicalRangeChange(r => { if (!r) return; rsiChart?.timeScale().setVisibleLogicalRange(r); macdChart?.timeScale().setVisibleLogicalRange(r); });
  let ind = { volume: false, ma: false, rsi: false, macd: false, maPeriods: I.DEFAULTS.maPeriods, rsiPeriod: I.DEFAULTS.rsiPeriod, macdParams: I.DEFAULTS.macd };

  let bars = [], interval = '1d', intraday = false, mode = style, baseline = null;
  // Line color follows the meaning of green/red: up or down vs the close before the range
  // (for 1D that's yesterday's close, matching the day change shown above the chart).
  const recolor = () => { if (bars.length) line.applyOptions({ color: bars.at(-1)[4] >= (baseline ?? bars[0][1]) ? C.up : C.down }); };
  const applyMode = () => { series.applyOptions({ visible: mode === 'candles' }); line.applyOptions({ visible: mode === 'line' }); };
  applyMode();

  const toPoint = ([t, o, h, l, c]) => {
    const ext = intraday && !isRegularHours(t);
    const up = c >= o;
    const col = ext ? (up ? C.upExt : C.downExt) : (up ? C.up : C.down);
    return { time: shiftTs(t), open: o, high: h, low: l, close: c, color: col, borderColor: col, wickColor: col };
  };

  chart.subscribeCrosshairMove(p => {
    if (!onHover) return;
    if (!p || p.time == null) return onHover(null);
    if (mode === 'line') { const d = p.seriesData.get(line); return onHover(d ? { close: d.value } : null); }
    const d = p.seriesData.get(series);
    onHover(d ? { open: d.open, high: d.high, low: d.low, close: d.close } : null);
  });

  return {
    setData(newBars, iv, base = null) {
      interval = iv; intraday = iv in INTERVAL_SEC; baseline = base > 0 ? base : null;
      bars = intraday ? clampOutliers(newBars) : newBars.slice();
      // stocks under $1 need 4 decimals on the price axis
      const fmt = bars.length && bars.at(-1)[4] < 1 ? { type: 'price', precision: 4, minMove: 0.0001 } : { type: 'price', precision: 2, minMove: 0.01 };
      series.applyOptions({ priceFormat: fmt }); line.applyOptions({ priceFormat: fmt });
      chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
      series.setData(bars.map(toPoint));
      line.setData(bars.map(b => ({ time: shiftTs(b[0]), value: b[4] })));
      recolor();
      drawIndicators();
      chart.timeScale().fitContent();
    },
    setStyle(s) { mode = s; applyMode(); },
    /** cfg: { volume, ma, rsi, macd (on/off), maPeriods, rsiPeriod, macdParams:[fast, slow, signal] } */
    setIndicators(cfg) { ind = { ...ind, ...cfg }; drawIndicators(); const r = chart.timeScale().getVisibleLogicalRange(); if (r) { rsiChart?.timeScale().setVisibleLogicalRange(r); macdChart?.timeScale().setVisibleLogicalRange(r); } },
    /** Merge a live quote into the last candle (or start a new one). */
    live(q) {
      if (!bars.length || !q || q.error) return;
      const last = bars[bars.length - 1];
      let bar;
      if (intraday) {
        const step = INTERVAL_SEC[interval];
        if (!q.lastTime || q.lastTime < last[0]) return;
        // Measure from the last bar: Yahoo's hourly bars start at :30, not on the hour.
        const bucket = last[0] + Math.floor((q.lastTime - last[0]) / step) * step;
        const p = q.last;
        if (bucket <= last[0]) bar = [last[0], last[1], Math.max(last[2], p), Math.min(last[3], p), p, last[5]];
        else { bar = [bucket, p, p, p, p, 0]; bars.push(bar); }
      } else if (interval === '1d') {
        if (!q.regularTime || !isRegularHours(q.regularTime)) return;
        const p = q.price;
        if (etYmd(new Date(q.regularTime * 1000)) === etYmd(new Date(last[0] * 1000))) bar = [last[0], last[1], Math.max(last[2], p), Math.min(last[3], p), p, last[5]];
        else { bar = [q.regularTime, p, p, p, p, 0]; bars.push(bar); }
      } else {
        const p = q.price; bar = [last[0], last[1], Math.max(last[2], p), Math.min(last[3], p), p, last[5]];
      }
      bars[bars.length - 1] = bar;
      series.update(toPoint(bar));
      line.update({ time: shiftTs(bar[0]), value: bar[4] });
      recolor();
      if (ind.ma || ind.rsi || ind.macd || ind.volume) drawIndicators();
    },
    lastBar: () => bars[bars.length - 1] || null,
    count: () => bars.length,
    destroy() { rsiChart?.remove(); macdChart?.remove(); chart.remove(); },
  };

  function drawIndicators() {
    const t = bars.map(b => shiftTs(b[0])), c = bars.map(b => b[4]);
    const pts = arr => arr.map((v, i) => (v == null ? { time: t[i] } : { time: t[i], value: v }));
    vol.applyOptions({ visible: !!ind.volume });
    if (ind.volume) vol.setData(bars.map(b => ({ time: shiftTs(b[0]), value: b[5] || 0, color: b[4] >= b[1] ? 'rgba(0,255,156,.22)' : 'rgba(255,59,92,.22)' })));
    mas.forEach((m, k) => {
      const n = ind.maPeriods[k], on = !!ind.ma && n > 1;
      m.applyOptions({ visible: on });
      if (on) m.setData(pts(I.sma(c, n)));
    });
    if (rsiLine && ind.rsi) rsiLine.setData(pts(I.rsi(c, ind.rsiPeriod)));
    if (macdLine && ind.macd) {
      const m = I.macd(c, ...ind.macdParams);
      macdLine.setData(pts(m.line)); macdSig.setData(pts(m.signal));
      macdHist.setData(m.hist.map((v, i) => (v == null ? { time: t[i] } : { time: t[i], value: v, color: v >= 0 ? 'rgba(0,255,156,.5)' : 'rgba(255,59,92,.5)' })));
    }
  }
}

/**
 * Performance chart: two lines of % return — your account (cyan) and the S&P 500 (white).
 * Data: [{ time: 'YYYY-MM-DD', value: percent }].
 */
export function createCompareChart(el) {
  const chart = baseChart(el, { localization: { priceFormatter: v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%' } });
  const LWC = window.LightweightCharts;
  const you = chart.addLineSeries({ color: '#3df2ff', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 4 });
  const spy = chart.addLineSeries({ color: 'rgba(232,241,255,.75)', lineWidth: 2, lineStyle: LWC.LineStyle.Solid, priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 3 });
  const zero = you.createPriceLine({ price: 0, color: 'rgba(125,146,179,.5)', lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: false });
  return {
    setData(a, b) { you.setData(a); spy.setData(b); chart.timeScale().fitContent(); },
    destroy() { you.removePriceLine(zero); chart.remove(); },
  };
}

/**
 * Yahoo's intraday feed sometimes carries stray prints (e.g. the closing-auction
 * bar with a wick 5–10% away). Clamp wicks more than 12× the median candle range
 * beyond the candle body so one bad tick can't flatten the whole chart.
 */
export function clampOutliers(input) {
  if (input.length < 20) return input.slice();
  const ranges = input.map(b => (b[2] - b[3]) / b[4]).sort((a, b) => a - b);
  const med = Math.max(ranges[Math.floor(ranges.length / 2)], 0.0005);
  const steps = input.slice(1).map((b, i) => b[0] - input[i][0]).sort((a, b) => a - b);
  const step = steps[Math.floor(steps.length / 2)] || 60;
  const out = [];
  input.forEach((b, i) => {
    let [t, o, h, l, c, v] = b;
    const lim = med * 12 * c, prev = out[i - 1];
    // A stray open far from the previous close of the bar right before it.
    if (prev && t - prev[0] <= step * 2 && Math.abs(o - prev[4]) > lim && Math.abs(c - prev[4]) <= lim) o = prev[4];
    const top = Math.max(o, c), bot = Math.min(o, c);
    if (h - top > lim) h = top;
    if (bot - l > lim) l = bot;
    out.push([t, o, Math.max(h, top), Math.min(l, bot), c, v]);
  });
  return out;
}
