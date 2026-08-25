// SLK Locator — service worker
//
// Caches the app shell + data on first successful load so the app keeps
// working with no signal afterwards (the offline guarantee the original
// single-file build had, now split across a few small files instead of
// one 25MB inline blob).
//
// IMPORTANT: bump CACHE_NAME (e.g. 'slk-locator-v2') whenever roads.json or
// roaddata.bin changes, so returning devices pick up the new data instead
// of serving the stale cached copy forever.
const CACHE_NAME = 'slk-locator-v1';
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './roads.json',
  './roaddata.bin',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first: serve instantly from cache when present (this is what makes
// the app usable with no signal), fall back to network, and opportunistically
// refresh the cache in the background when online.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      const networkFetch = fetch(event.request).then(response => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached); // offline and not cached-for-this-exact-request: nothing we can do

      return cached || networkFetch;
    })
  );
});
