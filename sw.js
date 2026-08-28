/* 31en — service worker.
   Network-first: er wordt altijd eerst geprobeerd om de nieuwste versie
   op te halen, de cache is alleen de vangnet voor offline. Versie
   ophogen bij grote wijzigingen. */

const CACHE = '31en-v1.0.0';

const ASSETS = [
  './',
  './index.html',
  './app.js',
  './online.js',
  './mqtt.min.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(m => m || caches.match('./index.html'))
      )
  );
});
