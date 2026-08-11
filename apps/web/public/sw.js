/**
 * OutreachGraph service worker.
 *
 * Two rules govern everything here:
 *
 *   1. Never cache `/api`. Prospect data, approval state and policy decisions
 *      must be current — a stale approval queue would show a card that has
 *      already been actioned, or hide a suppression that just landed.
 *   2. Navigations are network-first with an offline fallback, so an installed
 *      app opens to something useful on a bad connection instead of a browser
 *      error page.
 */

const VERSION = 'v1';
const SHELL_CACHE = `og-shell-${VERSION}`;
const ASSET_CACHE = `og-assets-${VERSION}`;

const SHELL = ['/', '/offline'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll rejects the whole install if any entry 404s; these are our own
      // routes, so a failure here is a real build problem worth surfacing.
      cache.addAll(SHELL),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('og-') && key !== SHELL_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

// The update prompt in the app posts this when the user accepts.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Same-origin only; never touch another host's responses.
  if (url.origin !== self.location.origin) return;

  // Rule 1: API traffic is never cached and never served from cache.
  if (url.pathname.startsWith('/api')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;

    const offline = await caches.match('/offline');
    if (offline) return offline;

    return new Response('Offline', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(ASSET_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 504 });
  }
}

function isStaticAsset(pathname) {
  return (
    pathname.startsWith('/_next/static/') ||
    pathname.startsWith('/icons/') ||
    /\.(?:css|js|woff2?|png|jpg|jpeg|svg|webp|ico)$/.test(pathname)
  );
}
