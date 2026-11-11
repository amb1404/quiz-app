const CACHE_NAME = 'pioneers-prep-v1';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    // Pass API calls, live room data, and live quizzes directly through to the server
    if (event.request.url.includes('/api/') || event.request.url.includes('/socket.io/')) {
        return;
    }
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});