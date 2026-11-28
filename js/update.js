// "Update available" pop-up. On open (and when you come back to the app), checks version.json on the
// server. If it's newer than this copy, shows what's new with UPDATE NOW / LATER.
import { APP_VERSION } from './config.js';
import { $, sheet, closeSheet, toast } from './ui.js';
import { esc } from './format.js';

/** Compare "1.2.3" style versions: >0 if a is newer than b. */
export function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

let shownFor = null, checking = false;

export async function checkForUpdate() {
  if (checking) return null;
  checking = true;
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const info = await res.json();
    if (!info?.version || newer(info.version, APP_VERSION) <= 0) return null;
    if (shownFor === info.version || sessionStorage.getItem('lpt-later') === info.version) return info; // "Later" lasts until the app is reopened
    if (document.querySelector('.scrim')) { setTimeout(checkForUpdate, 10000); return info; } // don't interrupt an open sheet; retry shortly
    shownFor = info.version;
    showPrompt(info);
    return info;
  } catch { return null; } finally { checking = false; }
}

function showPrompt(info) {
  sheet(`<h3>UPDATE AVAILABLE</h3>
    <p class="w">Version <b class="c">${esc(info.version)}</b> is ready. You have ${esc(APP_VERSION)}.</p>
    ${info.notes?.length ? `<div class="sect0">WHAT'S NEW</div><ul class="facts">${info.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <p class="d small">Your account, trades and settings stay exactly as they are.</p>
    <div class="btns"><button class="btn" id="upLater" style="border-color:var(--line-hi)">LATER</button><button class="btn cy" id="upNow">UPDATE NOW</button></div>`, el => {
    $('#upLater', el).addEventListener('click', () => { sessionStorage.setItem('lpt-later', info.version); closeSheet(); });
    $('#upNow', el).addEventListener('click', async e => {
      e.target.disabled = true; e.target.innerHTML = '<span class="spin"></span>';
      sessionStorage.setItem('lpt-updated-to', info.version);
      await applyUpdate();
    });
  }, 'update');
}

/** Activate the waiting service worker (or just reload when there isn't one) and restart the app. */
export async function applyUpdate() {
  const reload = () => location.reload();
  if (!('serviceWorker' in navigator)) return reload();
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return reload();
  navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
  setTimeout(reload, 8000); // safety net
  try { await reg.update(); } catch { /* offline: fall through */ }
  const waitFor = () => new Promise(resolve => {
    if (reg.waiting) return resolve(reg.waiting);
    const sw = reg.installing;
    if (!sw) return resolve(null);
    sw.addEventListener('statechange', () => { if (sw.state === 'installed') resolve(reg.waiting || sw); if (sw.state === 'redundant') resolve(null); });
  });
  const waiting = await waitFor();
  if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' }); else reload();
}

/** After an update: a short confirmation, once. */
export function confirmUpdated() {
  const v = sessionStorage.getItem('lpt-updated-to');
  if (v && newer(APP_VERSION, '0') && newer(v, APP_VERSION) <= 0) { sessionStorage.removeItem('lpt-updated-to'); toast(`Updated to version ${APP_VERSION}.`); }
}

/** Register the service worker and check for updates now and whenever the app comes back to the screen. */
export function startUpdates() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  confirmUpdated();
  setTimeout(checkForUpdate, 1500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
}
