// Mock candlestick renderer for design concepts (seeded random walk).
function mockCandles(n, seed = 7, start = 228) {
  let s = seed, p = start; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = p, c = o + (r() - 0.46) * 2.4, hi = Math.max(o, c) + r() * 1.2, lo = Math.min(o, c) - r() * 1.2;
    out.push({ o, c, hi, lo, v: 0.3 + r() }); p = c;
  }
  return out;
}
function drawCandles(svg, opt = {}) {
  const { n = 40, seed = 7, up = '#00ff9c', down = '#ff3b5c', hollow = false, grid = null, vol = false, glow = true } = opt;
  const W = svg.clientWidth, H = svg.clientHeight, data = mockCandles(n, seed);
  const ph = vol ? H * 0.8 : H, max = Math.max(...data.map(d => d.hi)), min = Math.min(...data.map(d => d.lo));
  const y = v => 6 + (max - v) / (max - min) * (ph - 12), cw = W / n;
  let g = '';
  if (grid) for (let i = 1; i < 4; i++) g += `<line x1="0" x2="${W}" y1="${ph * i / 4}" y2="${ph * i / 4}" stroke="${grid}" stroke-width="1" stroke-dasharray="2 4"/>`;
  data.forEach((d, i) => {
    const x = i * cw + cw / 2, col = d.c >= d.o ? up : down, bt = y(Math.max(d.o, d.c)), bh = Math.max(1.5, Math.abs(y(d.o) - y(d.c)));
    g += `<line x1="${x}" x2="${x}" y1="${y(d.hi)}" y2="${y(d.lo)}" stroke="${col}" stroke-width="1.2"/>`;
    g += `<rect x="${x - cw * 0.32}" y="${bt}" width="${cw * 0.64}" height="${bh}" rx="1" fill="${hollow && d.c >= d.o ? 'none' : col}" stroke="${col}" stroke-width="1.2"/>`;
    if (vol) g += `<rect x="${x - cw * 0.32}" y="${H - d.v * H * 0.17}" width="${cw * 0.64}" height="${d.v * H * 0.17}" fill="${col}" opacity=".35"/>`;
  });
  svg.innerHTML = (glow ? `<defs><filter id="cg"><feGaussianBlur stdDeviation="1.3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` : '') + `<g ${glow ? 'filter="url(#cg)"' : ''}>${g}</g>`;
}
document.querySelectorAll('svg[data-candles]').forEach(s => drawCandles(s, JSON.parse(s.dataset.candles || '{}')));
