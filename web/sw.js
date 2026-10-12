'use strict';
const CACHE = 'coach-comms-v1';
const SHELL = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache credentials, messages, receipts, or failed API sends.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/v1/') || url.pathname === '/health') return;
  if (!SHELL.includes(url.pathname) && url.pathname !== '/index.html') return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      return (await caches.match(event.request)) ?? (event.request.mode === 'navigate'
        ? await caches.match('/') : new Response('Offline', { status: 503 }));
    }
  })());
});
self.addEventListener('push', event => {
  // iOS requires a visible notification for every push; never silently discard an expired call.
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data?.json() ?? {}; } catch { /* Display a safe fallback. */ }
    const expired = payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now();
    await self.registration.showNotification(expired ? 'Expired call · Coach Comms' : String(payload.title ?? 'Coach Comms'), {
      body: expired ? 'An old call expired. Open the app for the latest instruction.' : String(payload.body ?? 'Open Coach Comms for the latest call.'),
      icon: '/icon-192.png', badge: '/icon-192.png', tag: 'coach-latest-call',
      timestamp: Date.now(),
      data: { messageID: payload.messageID, expiresAt: payload.expiresAt, url: '/' }
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) { await client.focus(); return; }
    }
    await self.clients.openWindow('/');
  })());
});
