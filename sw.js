// sw.js — ZigZag Service Worker
// Strategy: stale-while-revalidate (instant load, background refresh).
// Bump CACHE on every deploy to force a full refresh.

const CACHE = 'zigzag-v5';
const SHELL = [
    './',
    'index.html',
    'js/zigzag.js',
    'js/zigzag-gpu.js',
    'js/zigzag-worker.js',
    'manifest.json',
    'assets/zigzag-logo.png',
    'assets/icon-192.png',
    'assets/icon-512.png',
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
    self.skipWaiting();
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
    if (new URL(e.request.url).origin !== self.location.origin) return;

    // serve from cache immediately, refresh silently for the next load
    e.respondWith(
        caches.open(CACHE).then(async cache => {
            const cached = await cache.match(e.request);
            const fresh = fetch(e.request).then(resp => {
                if (resp.ok) cache.put(e.request, resp.clone());
                return resp;
            }).catch(() => null);
            return cached || fresh;
        })
    );
});
