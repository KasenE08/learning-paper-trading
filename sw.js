// Service worker: app shell works offline; market data always goes to the network.
const VERSION = 'lpt-v0.5.0';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/api.js', 'js/chart.js', 'js/config.js', 'js/format.js', 'js/market.js', 'js/store.js',
  'js/engine.js', 'js/trader.js', 'js/ticket.js', 'js/ui.js', 'js/analytics.js', 'js/portfolio.js', 'js/backup.js', 'js/indicators.js', 'js/learn.js', 'js/recap.js',
  'vendor/lightweight-charts.standalone.production.js',
  'fonts/jetbrains-mono-latin-400-normal.woff2', 'fonts/jetbrains-mono-latin-500-normal.woff2',
  'fonts/jetbrains-mono-latin-600-normal.woff2', 'fonts/jetbrains-mono-latin-700-normal.woff2',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // relay calls: network only
  // Stale-while-revalidate for the app shell.
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
