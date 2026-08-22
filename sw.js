/* ============================================================
   Stackroom — Service Worker
   ------------------------------------------------------------
   Kept in its own file (not inlined in index.html) per the app's
   architecture: the main script only registers it.

   Strategy:
   - App shell (index.html, manifest.json, icons): cache-first, so the
     app itself always launches offline once it has been opened at
     least once.
   - Third-party CDN libraries (Dexie, html5-qrcode, qrcode-generator,
     JsBarcode, jspdf, xlsx, Google Fonts): stale-while-revalidate —
     served from cache instantly if present (so the app still works
     offline after a first successful online load), while a background
     fetch refreshes the cached copy for next time whenever the network
     is available. This app depends on IndexedDB (via Dexie), so the
     Dexie script in particular MUST be available for the app to
     function at all past the first load — this strategy guarantees that
     once it's cached, it stays available offline indefinitely.

   Bump CACHE_VERSION on every release that changes cached assets. The
   activate handler deletes any cache from a previous version.
   ============================================================ */
const CACHE_VERSION = 'stackroom-v7'; // bumped: Issue Book auto-advance fix + Service Worker update-detection prompt changed index.html — forces every existing install to re-fetch it instead of continuing to serve the old cached copy
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const RUNTIME_HOSTS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('stackroom-') && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

function isRuntimeHost(url){
  try{ return RUNTIME_HOSTS.includes(new URL(url).hostname); }
  catch(e){ return false; }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return; // never cache POST/PUT/etc.

  const url = new URL(req.url);

  // App shell: cache-first, fall back to network, and cache whatever we
  // fetch so a future offline load still has it.
  if(url.origin === self.location.origin){
    event.respondWith(
      caches.match(req).then((cached) => {
        if(cached) return cached;
        return fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  // Third-party CDN libraries and fonts: stale-while-revalidate.
  if(isRuntimeHost(req.url)){
    event.respondWith(
      caches.open(RUNTIME_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const networkFetch = fetch(req).then((res) => {
            if(res && res.ok) cache.put(req, res.clone());
            return res;
          }).catch(() => cached);
          return cached || networkFetch;
        })
      )
    );
  }
  // Anything else (e.g. other third-party requests) is left to the
  // network as normal — not cached, not intercepted.
});
