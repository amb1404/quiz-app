// public/sw.js
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Basic network-first pass-through fetch handler
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});