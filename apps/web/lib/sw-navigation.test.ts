import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The service worker's navigation handler, exercised against stubs.
 *
 * This exists for one regression, and it is the expensive kind: it bricked the
 * installed app rather than degrading it.
 *
 * `start_url` is '/', and a signed-in visit to '/' redirects to /today. Fetch
 * follows the redirect, so the response arrives with `redirected === true` --
 * and the Cache API refuses to store a redirected response, by specification:
 * `put()` throws TypeError. That throw sat inside the same `try` as the fetch,
 * so a perfectly good page was caught by the offline handler and every launch
 * served the offline screen. Nothing short of clearing site data recovered it.
 *
 * sw.js is a browser script with no exports, so it is read and evaluated here
 * with `self`, `caches` and `fetch` stubbed. That is uglier than importing a
 * module, and it is the only way to test the file that actually ships.
 */

const SW_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'public', 'sw.js'),
  'utf8',
);

type PutBehaviour = 'ok' | 'throw';

/** Evaluate sw.js against stubs and hand back its navigation handler. */
function loadNavigationHandler(opts: {
  response: Response;
  putBehaviour?: PutBehaviour;
  cached?: Map<string, Response>;
  fetchThrows?: boolean;
}) {
  const puts: string[] = [];
  const cached = opts.cached ?? new Map<string, Response>();

  const cacheStub = {
    addAll: async () => undefined,
    put: async (req: Request | string) => {
      if (opts.putBehaviour === 'throw') {
        // Exactly what a real Cache does with a redirected response.
        throw new TypeError('Cache.put() encountered a redirected response');
      }
      puts.push(typeof req === 'string' ? req : req.url);
    },
  };

  const sandbox = {
    self: {
      addEventListener: (_: string, __: unknown) => undefined,
      location: { origin: 'https://outreachgraph.com' },
      clients: { claim: async () => undefined },
      skipWaiting: () => undefined,
    },
    caches: {
      open: async () => cacheStub,
      keys: async () => [],
      delete: async () => true,
      match: async (key: Request | string) => {
        // Keys arrive both ways: a Request for the navigation, and the literal
        // '/offline' for the fallback. The latter has no origin, so it is
        // resolved against one rather than parsed bare.
        const url = typeof key === 'string' ? key : key.url;
        const path = new URL(url, 'https://outreachgraph.com').pathname;
        return cached.get(url) ?? cached.get(path);
      },
    },
    fetch: async () => {
      if (opts.fetchThrows) throw new TypeError('network');
      return opts.response;
    },
  };

  // Expose the internals the file does not export.
  const factory = new Function(
    'self',
    'caches',
    'fetch',
    `${SW_SOURCE}\n;return { networkFirstNavigation, offlineFallback };`,
  );
  const api = factory(sandbox.self, sandbox.caches, sandbox.fetch);
  return { ...api, puts };
}

const navigate = () => new Request('https://outreachgraph.com/', { method: 'GET' });

describe('navigation is served from the network', () => {
  test('a redirected page is returned, not swallowed into the offline screen', async () => {
    // The exact shape of the bug: signed in, '/' redirects to /today.
    const redirected = new Response('<html>today</html>', { status: 200 });
    Object.defineProperty(redirected, 'redirected', { value: true });
    Object.defineProperty(redirected, 'url', { value: 'https://outreachgraph.com/today' });

    const { networkFirstNavigation } = loadNavigationHandler({
      response: redirected,
      putBehaviour: 'throw',
      cached: new Map([['/offline', new Response('offline', { status: 200 })]]),
    });

    const out: Response = await networkFirstNavigation(navigate());
    expect(out.status).toBe(200);
    expect(await out.text()).toContain('today');
  });

  test('a redirect is never offered to the cache at all', async () => {
    const redirected = new Response('ok', { status: 200 });
    Object.defineProperty(redirected, 'redirected', { value: true });

    const { networkFirstNavigation, puts } = loadNavigationHandler({ response: redirected });
    await networkFirstNavigation(navigate());
    // Storing it is what throws; not attempting it is the fix.
    expect(puts).toEqual([]);
  });

  test('an ordinary page is still cached', async () => {
    const plain = new Response('<html>landing</html>', { status: 200 });
    const { networkFirstNavigation, puts } = loadNavigationHandler({ response: plain });
    await networkFirstNavigation(navigate());
    expect(puts).toEqual(['https://outreachgraph.com/']);
  });

  test('a cache write that fails does not withhold the page', async () => {
    // A full quota is not a reason to show somebody the offline screen.
    const plain = new Response('<html>landing</html>', { status: 200 });
    const { networkFirstNavigation } = loadNavigationHandler({
      response: plain,
      putBehaviour: 'throw',
      cached: new Map([['/offline', new Response('offline')]]),
    });
    const out: Response = await networkFirstNavigation(navigate());
    expect(await out.text()).toContain('landing');
  });
});

describe('the offline screen is for being offline', () => {
  test('a genuine network failure still falls back', async () => {
    const { networkFirstNavigation } = loadNavigationHandler({
      response: new Response('unused'),
      fetchThrows: true,
      cached: new Map([['/offline', new Response('offline screen', { status: 200 })]]),
    });
    const out: Response = await networkFirstNavigation(navigate());
    expect(await out.text()).toContain('offline screen');
  });

  test('with nothing cached it is a 503, not a hang', async () => {
    const { networkFirstNavigation } = loadNavigationHandler({
      response: new Response('unused'),
      fetchThrows: true,
    });
    const out: Response = await networkFirstNavigation(navigate());
    expect(out.status).toBe(503);
  });
});

describe('the cache name changes so a broken install recovers', () => {
  test('VERSION was bumped past the release that poisoned it', () => {
    // Shipping the fix alone leaves the offline page stored against '/' in
    // og-shell-v2, and the app keeps opening to it. Renaming the cache is what
    // makes activate() delete it.
    const version = /const VERSION = '([^']+)'/.exec(SW_SOURCE)?.[1];
    expect(version).toBeDefined();
    expect(version).not.toBe('v2');
  });
});
