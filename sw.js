// v1001: фикс зависания приветственного окна при ?start=, try/catch для URL-параметров
var CACHE_NAME = 'hospital-nav-v1001';

var PRECACHE = [
  './',
  'data.json',
  'hospital-map.webp',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'icons/chevron-down.svg',
  'icons/chevron-right.svg',
  'icons/chevron-up.svg',
  'icons/chevrons-up.svg',
  'icons/download.svg',
  'map.js',
  'ui.js',
  'styles.css',
  'https://unpkg.com/html5-qrcode'
];

function preCache(url) {
  return fetch(url).then(function(response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return caches.open(CACHE_NAME).then(function(cache) {
      return cache.put(url, response);
    });
  }).catch(function(err) {
    console.warn('SW: failed to pre-cache', url, err);
  });
}

self.addEventListener('install', function(event) {
  event.waitUntil(
    Promise.all(PRECACHE.map(preCache)).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(response) {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        var cloned = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, cloned);
        });
        return response;
      }).catch(function() {
        if (event.request.mode === 'navigate') {
          return caches.match('./');
        }
        return new Response('', { status: 408, statusText: 'Offline' });
      });
    })
  );
});
