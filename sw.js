// Cache-first app shell. Once installed, the app opens with no signal at all.
// Bump CACHE when shipping changes, otherwise phones keep the old copy forever.
const CACHE = 'trips-v10';
const VENDOR = 'trips-vendor-v1';

const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './db.js',
  './model.js',
  './ics.js',
  './icons.js',
  './coverage.js',
  './parse.js',
  './importers.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// The PDF and OCR readers are fetched from a CDN the first time someone imports
// with one, then kept forever in a cache of their own. Keeping them out of the
// shell means nobody who never imports pays for the download.
const VENDOR_HOSTS = ['cdn.jsdelivr.net'];

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
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE && k !== VENDOR).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (VENDOR_HOSTS.includes(url.hostname)) {
    // Cache-first and never revalidated: these URLs are version-pinned, so a hit
    // is always correct, and keeping it makes the importer work offline later.
    e.respondWith(
      caches.open(VENDOR).then(async cache => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

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
