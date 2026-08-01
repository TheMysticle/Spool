self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  // Empty fetch handler satisfies PWA installability requirement.
  // We do not call e.respondWith() so the browser handles all requests natively,
  // avoiding CSP connect-src conflicts and video stream Range request bugs.
});
