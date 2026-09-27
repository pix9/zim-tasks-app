const CACHE = 'zimtasks-v1';
const ASSETS = ['./', './index.html', './app.js', './manifest.webmanifest',
                'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())));

self.addEventListener('activate', e =>
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).hostname === 'api.github.com') return; // never cache your data
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok){ const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
