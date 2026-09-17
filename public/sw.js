// Service worker: shows push notifications and focuses the app when one is tapped.
// Page loads fall back to a cached shell when offline; game data always needs the network.

const SHELL = 'hunger-games-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL).then((cache) => cache.add('/index.html')).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// Page loads go to the network; the cached shell is only a fallback when the phone is offline.
// (Chrome also wants a real fetch handler before it offers to install the app.)
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.match('/index.html'))
    ?? new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain' } })));
});

function readPayload(event) {
  try {
    return event.data?.json() ?? {};
  } catch {
    return { title: 'Hunger Games', body: event.data?.text() };
  }
}

self.addEventListener('push', (event) => {
  const data = readPayload(event);
  event.waitUntil(self.registration.showNotification(data.title ?? 'Hunger Games', {
    body: data.body,
    tag: data.kind === 'storm' ? 'storm' : undefined,
    renotify: data.kind === 'storm',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { gameId: data.gameId },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.length) return windows[0].focus();
    return self.clients.openWindow('/');
  })());
});
