// Intentionally does NOT cache anything. This is a live multiplayer app —
// caching game files or socket.io traffic would risk serving stale code or
// breaking live connections. This service worker exists only so the browser
// recognizes the site as an installable PWA.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // pass every request straight through to the network
  event.respondWith(fetch(event.request));
});
