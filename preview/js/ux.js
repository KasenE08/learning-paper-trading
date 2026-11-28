// Feel & readability helpers: text size, pull-to-refresh.

/** Text scale: 'auto' follows the iPhone's Settings → Display → Text Size; or a fixed 1 / 1.15 / 1.3. */
export function applyTextScale(setting = 'auto') {
  let v = 1;
  if (setting === 'auto') v = systemTextScale();
  else v = Math.min(1.4, Math.max(0.9, parseFloat(setting) || 1));
  document.documentElement.style.setProperty('--ts', String(Math.round(v * 100) / 100));
  return v;
}
export function systemTextScale() {
  try {
    if (!CSS.supports('font', '-apple-system-body')) return 1;
    const probe = document.createElement('span');
    probe.style.cssText = 'font: -apple-system-body; position: absolute; visibility: hidden;';
    probe.textContent = 'x';
    document.body.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize) || 17;
    probe.remove();
    return Math.min(1.35, Math.max(1, px / 17)); // 17px is iOS's default body size
  } catch { return 1; }
}
export const textScale = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ts')) || 1;

/**
 * Pull down at the top of `scroller` to refresh. Shows a small indicator; calls onRefresh() (a promise).
 * Works with touch; ignored on desktop mice.
 */
export function pullToRefresh(scroller, onRefresh) {
  const ind = document.createElement('div');
  ind.className = 'ptr'; ind.innerHTML = '<span class="spin"></span><b>RELEASE TO REFRESH</b>';
  scroller.parentNode.insertBefore(ind, scroller); // outside the scroller: screens redraw its contents
  let y0 = null, dy = 0, busy = false;
  const set = h => { ind.style.height = h + 'px'; ind.classList.toggle('ready', h >= 64); };
  const start = e => { if (busy || scroller.scrollTop > 0 || e.touches.length !== 1 || e.target.closest('.chart, .ipane, .cmp')) { y0 = null; return; } y0 = e.touches[0].clientY; dy = 0; };
  const move = e => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0) { set(0); return; }
    set(Math.min(90, dy * 0.5));
  };
  const end = async () => {
    if (y0 == null) return;
    y0 = null;
    if (dy * 0.5 >= 64 && !busy) {
      busy = true; set(48); ind.classList.add('busy');
      try { await onRefresh(); } finally { busy = false; ind.classList.remove('busy'); set(0); }
    } else set(0);
  };
  scroller.addEventListener('touchstart', start, { passive: true });
  scroller.addEventListener('touchmove', move, { passive: true });
  scroller.addEventListener('touchend', end);
  scroller.addEventListener('touchcancel', end);
  return () => { ind.remove(); scroller.removeEventListener('touchstart', start); scroller.removeEventListener('touchmove', move); scroller.removeEventListener('touchend', end); scroller.removeEventListener('touchcancel', end); };
}
