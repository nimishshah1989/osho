/**
 * Osho Archives — service worker
 * ───────────────────────────────
 *
 * Two-tier cache strategy:
 *
 *   STATIC_CACHE  — the app shell (HTML, JS, CSS, icons, fonts, the
 *                   sqlite-wasm runtime). Stable per release; we
 *                   bump CACHE_VERSION when shipping a new build.
 *
 *   CORPUS_CACHE  — `osho.db.zst` once it's been downloaded. Stays
 *                   put across releases because the DB is large and
 *                   the user already paid the download cost.
 *
 * Routing rules:
 *
 *   /              → network-first, fall back to cache.
 *                    Keeps the UI fresh on every visit when online,
 *                    keeps it usable offline.
 *
 *   /_next/static/ → cache-first (immutable per release hash).
 *
 *   /icons/        → cache-first.
 *
 *   /sw.js         → never cached by the SW itself (the browser
 *                    handles SW updates).
 *
 *   /api/*         → network-only. When the UI's offline engine is
 *                    ready it stops issuing these entirely; while it
 *                    isn't, we let them fall through unmodified.
 *
 *   osho.db.zst    → cache-first, lives in its own cache so a
 *                    release bump doesn't blow it away.
 *
 * Update flow:
 *   1. Push to main → Vercel rebuilds → new SW with new CACHE_VERSION.
 *   2. New SW is detected next time the user opens the app; installs
 *      in parallel, takes over on next navigation.
 *   3. Old caches with mismatched CACHE_VERSION are deleted in
 *      `activate`.
 */
const CACHE_VERSION = 'v1';
const STATIC_CACHE = `osho-static-${CACHE_VERSION}`;
const CORPUS_CACHE = `osho-corpus-v1`; // intentionally version-independent

// Pre-warm the shell so the very first offline navigation works even
// before the user has clicked around.
const SHELL_ASSETS = [
  '/',
  '/archive',
  '/read',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.map((name) => {
          // Reap old versioned shells. Corpus cache is kept by name.
          if (name.startsWith('osho-static-') && name !== STATIC_CACHE) {
            return caches.delete(name);
          }
          return undefined;
        }),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Same-origin only — third-party CDNs (GA, fonts) flow through
  // unmodified.
  if (url.origin !== self.location.origin) return;

  // /api/* — never intercept. The PWA's offline path lives in the
  // worker; while it's downloading, we want the existing FastAPI
  // proxy to keep serving.
  if (url.pathname.startsWith('/api/')) return;

  // Compressed corpus — cache-first, separate cache bucket.
  if (url.pathname.endsWith('/osho.db.zst') || url.pathname.includes('osho.db.zst')) {
    event.respondWith(cacheFirst(req, CORPUS_CACHE));
    return;
  }

  // _next/static — content-hashed, safe to cache forever.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // Icons + manifest — cache-first.
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // HTML pages — network-first so users see new copy when online,
  // cached copy when not. Mode 'navigate' covers SPA route changes,
  // 'document' accept header covers other variants.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(req, STATIC_CACHE));
    return;
  }

  // Everything else (chunks loaded outside the _next prefix, fetched
  // resources) — stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
});


async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(request);
    if (hit) return hit;
    // Last-resort offline shell: serve cached '/' so the SPA can
    // route client-side to a meaningful screen.
    const fallback = await cache.match('/');
    if (fallback) return fallback;
    throw e;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const networkUpdate = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  return hit || (await networkUpdate) || fetch(request);
}
