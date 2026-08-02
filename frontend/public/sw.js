/**
 * Service worker kill switch — the site stopped shipping a PWA on 2026-08-02.
 *
 * Do NOT delete this file. Browsers that visited while the PWA shipped still
 * have the old cache-first worker installed and would keep serving a frozen
 * copy of the site forever; a worker only updates by re-fetching its own URL,
 * so /sw.js must stay reachable and uninstall itself. No fetch handler, so
 * requests go straight to the network while this is still in control.
 */

self.addEventListener('install', () => {
  // Replace the outgoing worker immediately instead of waiting for every
  // tab still using it to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      await self.registration.unregister();
      // Reload open tabs so they detach from this worker and load from the
      // network. Without this they keep the now-unregistered worker as their
      // controller until the user navigates.
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) client.navigate(client.url);
    })(),
  );
});
