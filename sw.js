// Cache-first app shell. Once installed, the app opens with no signal at all.
// Bump CACHE when shipping changes, otherwise phones keep the old copy forever.
const CACHE = 'trips-v5';

const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './db.js',
  './model.js',
  './ics.js',
  './icons.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(hit => {
      if (hit) {
        // Refresh in the background when there happens to be a network.
        e.waitUntil(
          fetch(req)
            .then(res => res.ok && caches.open(CACHE).then(c => c.put(req, res.clone())))
            .catch(() => {})
        );
        return hit;
      }
      return fetch(req)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
