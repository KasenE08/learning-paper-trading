// Service worker: the app works offline; market data always goes to the network.
// Updates are user-approved: a new version installs in the background and waits until you tap
// "Update now" in the app (which sends SKIP_WAITING). Bump VERSION with every release.
const VERSION = 'lpt-v0.7.1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/api.js', 'js/chart.js', 'js/config.js', 'js/format.js', 'js/market.js', 'js/store.js',
  'js/engine.js', 'js/trader.js', 'js/ticket.js', 'js/ui.js', 'js/analytics.js', 'js/portfolio.js', 'js/backup.js', 'js/indicators.js', 'js/learn.js', 'js/recap.js', 'js/ux.js', 'js/update.js',
  'vendor/lightweight-charts.standalone.production.js',
  'fonts/jetbrains-mono-latin-400-normal.woff2', 'fonts/jetbrains-mono-latin-500-normal.woff2',
  'fonts/jetbrains-mono-latin-600-normal.woff2', 'fonts/jetbrains-mono-latin-700-normal.woff2',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache so a new version never installs old files
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
  // no skipWaiting() here: the new version waits for the user to tap "Update now"
});
self.addEventListener('message', e => { if (e.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // relay calls: network only
  if (url.pathname.endsWith('/version.json')) return;                        // update check: always network
  // Cache-first: each installed version serves only its own files (no silent partial updates).
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok) cache.put(e.request, res.clone());
    return res;
  }));
});
