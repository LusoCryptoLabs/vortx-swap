// Vortx Swap ships no service worker of its own. This file is a kill switch.
//
// An earlier app served from the same origin registered a Workbox service worker at /sw.js with
// scope "/". Browsers that kept it could serve its cached app shell for one frame on load.
//
// Browsers that still hold that registration fetch /sw.js on their next update check and get this
// file instead: it unregisters itself, deletes every Cache Storage entry, and reloads open tabs so
// they load from the network. Browsers with no registration never request this file.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop all caches left by the stale worker.
      try {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      } catch (_) { /* ignore */ }

      // Remove this registration, which replaced the stale one.
      try {
        await self.registration.unregister()
      } catch (_) { /* ignore */ }

      // Reload controlled tabs so they load the app from the network.
      try {
        const clients = await self.clients.matchAll({ type: 'window' })
        for (const client of clients) client.navigate(client.url)
      } catch (_) { /* ignore */ }
    })(),
  )
})
