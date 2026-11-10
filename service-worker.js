/* Biomexa does not use a service worker. This file replaces any old one that a previous version
   of the website (or a site builder) registered on this domain: it clears its caches, removes
   itself and reloads open tabs, so pages and API calls go straight to the network again. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch (e) {}
    try { await self.registration.unregister(); } catch (e) {}
    try { const tabs = await self.clients.matchAll({ type: 'window' }); tabs.forEach((t) => t.navigate(t.url)); } catch (e) {}
  })());
});
