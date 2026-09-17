// Service worker: shows push notifications and focuses the app when one is tapped.
// (No offline caching — the game needs a live connection anyway.)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { title: 'Hunger Games', body: event.data?.text() };
  }
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
