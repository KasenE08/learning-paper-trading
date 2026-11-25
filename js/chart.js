// Candlestick chart (TradingView Lightweight Charts, vendored).
import { etOffsetMinutes, isRegularHours, etYmd } from './market.js';

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

export function createCandleChart(el, { onHover } = {}) {
  const LWC = window.LightweightCharts;
  const chart = LWC.createChart(el, {
    autoSize: true,
    layout: { attributionLogo: false, background: { type: 'solid', color: 'transparent' }, textColor: C.text, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 10 },
    grid: { vertLines: { visible: false }, horzLines: { color: C.grid, style: LWC.LineStyle.Dashed } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: { borderVisible: false, rightOffset: 3, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true },
    crosshair: {
      mode: LWC.CrosshairMode.Normal,
      vertLine: { color: C.cross, labelBackgroundColor: '#0b2a33' },
      horzLine: { color: C.cross, labelBackgroundColor: '#0b2a33' },
    },
    handleScale: { axisPressedMouseMove: false },
  });
  const series = chart.addCandlestickSeries({
    upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down,
    priceLineColor: 'rgba(232,241,255,.5)', priceLineStyle: LWC.LineStyle.Dotted,
  });

  let bars = [], interval = '1d', intraday = false;

  const toPoint = ([t, o, h, l, c]) => {
    const ext = intraday && !isRegularHours(t);
    const up = c >= o;
    const col = ext ? (up ? C.upExt : C.downExt) : (up ? C.up : C.down);
    return { time: shiftTs(t), open: o, high: h, low: l, close: c, color: col, borderColor: col, wickColor: col };
  };

  chart.subscribeCrosshairMove(p => {
    if (!onHover) return;
    const d = p && p.time != null ? p.seriesData.get(series) : null;
    onHover(d ? { open: d.open, high: d.high, low: d.low, close: d.close } : null);
  });

  return {
    setData(newBars, iv) {
      interval = iv; intraday = iv in INTERVAL_SEC;
      bars = intraday ? clampOutliers(newBars) : newBars.slice();
      chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
      series.setData(bars.map(toPoint));
      chart.timeScale().fitContent();
    },
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
    },
    lastBar: () => bars[bars.length - 1] || null,
    count: () => bars.length,
    destroy() { chart.remove(); },
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
