self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  // Pass-through: satisfies PWA installability requirement without caching
  e.respondWith(fetch(e.request));
});
