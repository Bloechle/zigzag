// sw.js — ZigZag Service Worker
// Strategy: stale-while-revalidate (instant load, background refresh).
// Bump CACHE on every deploy to force a full refresh.

const CACHE = 'zigzag-v20';
const SHARED = 'zigzag-shared';   // an image shared to the app, until index.html takes it
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
    'assets/icon-maskable-512.png',
];

self.addEventListener('install', e => {
    // past the HTTP cache: a new version must not be filled with the old one's files
    const fresh = SHELL.map(url => new Request(url, { cache: 'reload' }));
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(fresh)));
    self.skipWaiting();
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHARED).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if (url.origin !== self.location.origin) return;
    if (e.request.method === 'POST' && url.searchParams.has('share')) {
        e.respondWith(receiveShare(e.request));
        return;
    }
    if (e.request.method !== 'GET') return;

    // a page is cached once, whatever its query (?shared, ?source=pwa)
    const navigate = e.request.mode === 'navigate';
    const key = navigate ? url.origin + url.pathname : e.request;

    // serve from cache immediately, refresh silently for the next load
    const fresh = caches.open(CACHE).then(cache => fetch(e.request).then(resp => {
        if (resp.ok) cache.put(key, resp.clone());
        return resp;
    })).catch(() => null);
    e.waitUntil(fresh.then(() => {}));     // keep the worker alive until the refresh lands
    e.respondWith(
        caches.match(e.request, { ignoreSearch: navigate })
            .then(async cached => cached || (await fresh)?.clone() || Response.error())
    );
});

/** The manifest's share_target posts the image here: park it, open the app on it. */
async function receiveShare(request) {
    const file = (await request.formData()).get('image');
    if (file instanceof File) {
        const headers = { 'Content-Type': file.type, 'X-Name': encodeURIComponent(file.name) };
        await (await caches.open(SHARED)).put('shared', new Response(file, { headers }));
    }
    return Response.redirect(new URL('./?shared', self.registration.scope).href, 303);
}
