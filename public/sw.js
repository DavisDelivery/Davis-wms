const CACHE = 'davis-wms-v20';
const ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/') || e.request.url.includes('/.netlify/')) return;

  const url = new URL(e.request.url);
  const isHTML = e.request.mode === 'navigate' ||
                 url.pathname === '/' ||
                 url.pathname.endsWith('.html') ||
                 url.pathname.endsWith('/sw.js');

  if (isHTML) {
    // Network-first: always try to get fresh HTML
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => {
          const resClone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, resClone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for other assets
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

