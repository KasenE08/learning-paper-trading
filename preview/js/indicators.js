// Technical indicators (pure math). They describe past prices; they never say buy or sell.

export const DEFAULTS = { maPeriods: [20, 50, 200], rsiPeriod: 14, macd: [12, 26, 9] };

/** Simple moving average. Returns an array aligned with `v` (null until enough data). */
export function sma(v, n) {
  const out = new Array(v.length).fill(null);
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= n) sum -= v[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first n values. */
export function ema(v, n) {
  const out = new Array(v.length).fill(null);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

/** RSI with Wilder's smoothing (the standard definition). 0–100. */
export function rsi(v, n = 14) {
  const out = new Array(v.length).fill(null);
  if (v.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  const val = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[n] = val();
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}

/** MACD: fast EMA − slow EMA; signal = EMA of MACD; histogram = MACD − signal. */
export function macd(v, fast = 12, slow = 26, signal = 9) {
  const f = ema(v, fast), s = ema(v, slow);
  const line = v.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const start = line.findIndex(x => x != null);
  const sig = new Array(v.length).fill(null);
  if (start >= 0) {
    const e = ema(line.slice(start), signal);
    e.forEach((x, i) => { sig[start + i] = x; });
  }
  const hist = line.map((x, i) => (x != null && sig[i] != null ? x - sig[i] : null));
  return { line, signal: sig, hist };
}

/** Plain-language reading of indicators at one bar, for recaps. Facts + the common interpretation; never advice. */
export function describeAt(closes, volumes, i, cfg = DEFAULTS) {
  const out = [];
  const r = rsi(closes, cfg.rsiPeriod)[i];
  if (r != null) {
    const meaning = r >= 70 ? `above 70, a level many traders call "overbought"` : r <= 30 ? `below 30, a level many traders call "oversold"` : 'between 30 and 70, the range most traders treat as neutral';
    out.push({ key: 'rsi', label: `RSI (${cfg.rsiPeriod})`, value: r, text: `RSI was ${r.toFixed(0)}: ${meaning}.` });
  }
  const m = macd(closes, ...cfg.macd);
  if (m.line[i] != null && m.signal[i] != null) {
    const above = m.line[i] >= m.signal[i];
    out.push({ key: 'macd', label: 'MACD', value: m.hist[i], text: `MACD was ${above ? 'above' : 'below'} its signal line, which many traders read as ${above ? 'upward' : 'downward'} momentum.` });
  }
  for (const n of cfg.maPeriods) {
    const a = sma(closes, n)[i];
    if (a == null) continue;
    const pct = (closes[i] / a - 1) * 100;
    out.push({ key: 'ma' + n, label: `${n}-day average`, value: pct, text: `Price was ${Math.abs(pct).toFixed(1)}% ${pct >= 0 ? 'above' : 'below'} its ${n}-day average. Many traders see price ${pct >= 0 ? 'above its average as part of an uptrend' : 'below its average as part of a downtrend'}.` });
  }
  if (volumes && i >= 20) {
    const avg = volumes.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20;
    if (avg > 0) {
      const x = volumes[i] / avg;
      out.push({ key: 'vol', label: 'Volume', value: x, text: `Volume was ${x.toFixed(1)}× its 20-day average${x >= 1.5 ? ', heavier trading than usual (often around news)' : x <= 0.6 ? ', lighter trading than usual' : ', about normal'}.` });
    }
  }
  return out;
}
