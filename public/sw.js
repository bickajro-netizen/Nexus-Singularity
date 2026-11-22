/*
 * NEXUS SINGULARITY — Service Worker (Prompt 8)
 * Contract: ARCHITECTURE_BLUEPRINT_V2 §SERVICE WORKER CONTRACT
 *           + hydrogen draft §1.2 Service Worker & Media Isolation Contract
 * - Cache ONLY static Vite build assets (shell): index.html, /assets/*, manifest.webmanifest.
 * - Explicit bypass, never into CacheStorage: blob:, nexus-media:, /__media__*
 *   (media_blobs live exclusively in IndexedDB; URLs are revoked blob: URIs).
 * - No IndexedDB in the SW at all → crypto_keystore database references are
 *   unreachable from here by construction.
 * - Obsidian Local REST API loopback (https://127.0.0.1:27124) is cross-origin
 *   → same-origin guard skips it; explicit blocklist guard as belt-and-braces.
 * - All other navigations fall through to network.
 */
const CACHE = 'nexus-shell-v2'; // bump: drops stale hashed chunks from v1 deploys
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Media isolation contract — hard bypass, never cached, never intercepted.
  if (url.protocol === 'blob:' || url.protocol === 'nexus-media:') return;
  if (url.pathname.startsWith('/__media__')) return;

  // Only same-origin app shell routes are handled.
  if (url.origin !== self.location.origin) return;

  // Obsidian Local REST API loopback guard (defence in depth; normally cross-origin).
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return;

  // App shell assets: cache-first, fill on first fetch.
  if (url.pathname.includes('/assets/') || url.pathname.endsWith('/manifest.webmanifest')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // Navigation requests: offline E2E cycle → serve precached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
  }
  // Everything else falls through to network (per contract).
});
