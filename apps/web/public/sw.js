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

/*
 * Bumped to v3 to evict a poisoned cache, not because the shell changed.
 *
 * While the redirect bug above was live, a signed-in launch stored the OFFLINE
 * page against '/' in og-shell-v2. Shipping the fix alone would leave that entry
 * in place and the app would keep opening to it. The activate handler deletes
 * every og-* cache that is not the current one, so renaming the cache is what
 * actually unsticks an install that is already broken.
 */
const VERSION = 'v3';
const SHELL_CACHE = `og-shell-${VERSION}`;
const ASSET_CACHE = `og-assets-${VERSION}`;

// The public landing page and the offline fallback, plus the two brand assets
// those pages render — an offline screen that renders a broken image is worse
// than the browser error it replaces. `/today` is deliberately absent: it is
// per-user and must never be served from a shared cache.
const SHELL = ['/', '/offline', '/favicon.png', '/logo.png'];

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
  let response;
  try {
    response = await fetch(request);
  } catch {
    return offlineFallback(request);
  }

  /*
   * Two rules here, and between them they are why the installed app hung.
   *
   * `start_url` is '/', and a signed-in visit to '/' redirects to /today. Fetch
   * follows that, so the response arrives with `redirected === true` -- and the
   * Cache API REFUSES to store a redirected response, by specification: put()
   * throws TypeError rather than writing it. That throw used to happen inside the
   * same try as the fetch, so a perfectly good page was caught by the offline
   * handler and the launcher was served the offline screen. Every launch. The
   * only way out was clearing site data, which is not a thing to ask of anyone.
   *
   * So: never try to cache a redirect, and never let a cache write decide what
   * the reader gets. The response is returned either way.
   */
  if (response.ok && !response.redirected) {
    try {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
    } catch {
      // A full quota or a storage error is not a reason to withhold the page.
    }
  }
  return response;
}

/**
 * What a reader gets when the network genuinely failed.
 *
 * Reached only from a fetch rejection now. It used to be reachable from a cache
 * write as well, which is how a working page turned into an offline screen.
 */
async function offlineFallback(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const offline = await caches.match('/offline');
  if (offline) return offline;

  return new Response('Offline', {
    status: 503,
    headers: { 'content-type': 'text/plain' },
  });
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
