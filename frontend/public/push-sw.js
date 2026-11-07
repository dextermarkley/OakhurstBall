// Push handlers, pulled into the generated service worker via workbox importScripts
// (see vite.config.ts). Messages come from backend/src/lib/push.ts as JSON:
//   { title, body, url?, tag? }
/* eslint-disable no-restricted-globals */

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(d.title || 'Oakhurst Basketball', {
      body: d.body || '',
      icon: '/pwa-192.png',
      tag: d.tag,
      renotify: !!d.tag,
      data: { url: d.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Same-origin pages only.
  let target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Reuse an open app window, but never pull the check-in kiosk away from its screen.
      const win = wins.find((w) => {
        const u = new URL(w.url);
        return u.origin === self.location.origin && !u.pathname.startsWith('/kiosk');
      });
      if (win) {
        await win.focus();
        if (new URL(win.url).href !== target.href && 'navigate' in win) {
          await win.navigate(target.href).catch(() => {});
        }
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
