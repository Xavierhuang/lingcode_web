/*!
 * lingcode-sw.js — service worker for LingCode Web Push.
 *
 * Registered by the SDK's client.push.subscribe(). Renders incoming push
 * payloads as notifications and focuses/opens the app on click. The push SEND
 * path (per-backend VAPID keys, /push/subscribe + /push/send routes) lands with
 * the notifications update — this worker is the stable client half, shipped with
 * the SDK so the subscribe() flow has something to register.
 *
 * Note on scope: a service worker only controls pages under the path it's served
 * from. Apps served on their own origin should host this file at their origin
 * root (or pass { serviceWorker } to push.subscribe) so it can claim the app.
 */
'use strict';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) {
    try { payload = { body: event.data ? event.data.text() : '' }; } catch (__) { payload = {}; }
  }
  var title = payload.title || 'Notification';
  var options = {
    body: payload.body || '',
    icon: payload.icon,
    badge: payload.badge,
    data: { url: payload.url || '/' },
    tag: payload.tag,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url === target && 'focus' in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
