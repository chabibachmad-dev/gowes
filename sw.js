// Service worker: simpan app shell & library CDN agar app tetap terbuka saat sinyal lemah.
// Data ride selalu diambil dari server (tidak di-cache).
const CACHE = 'gowes-v2';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/api.js', 'js/config.js', 'js/fit-load.js', 'js/fit-analyze.js',
  'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.pathname.includes('/functions/v1/') || u.hostname.includes('tile.openstreetmap')) return;
  const cdn = u.hostname === 'cdn.jsdelivr.net';
  if (cdn) { // cache-first untuk library ber-versi
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
    })));
    return;
  }
  if (u.origin === location.origin) { // network-first untuk file app
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
    }).catch(() => caches.match(e.request).then((h) => h || caches.match('index.html'))));
  }
});
