import { describe, expect, test } from 'bun:test';
import { isAllowed, parseRobots } from './robots';
import { fetchPage, USER_AGENT } from './fetch';
import { extractCompany, extractPeople, extractSite, networkForUrl } from './extract';
import { extractWithModel, visibleText, type ExtractionModel } from './model-extract';
import { SiteProvider, normaliseUrl } from './provider';

/** A fetch stand-in that answers from a map of url → response. */
function stubFetch(routes: Record<string, { body: string; status?: number; type?: string }>) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { 'content-type': route.type ?? 'text/html' },
    });
  };
}

describe('robots', () => {
  test('a group naming our agent beats the wildcard group', () => {
    const rules = parseRobots(
      [
        'User-agent: *',
        'Disallow: /',
        '',
        'User-agent: OutreachGraphBot',
        'Disallow: /private',
      ].join('\n'),
      'OutreachGraphBot/0.1',
    );

    expect(isAllowed(rules, '/about')).toBe(true);
    expect(isAllowed(rules, '/private/x')).toBe(false);
  });

  test('an empty Disallow means nothing is disallowed', () => {
    const rules = parseRobots('User-agent: *\nDisallow:', 'OutreachGraphBot/0.1');
    // The bug this guards: treating '' as a prefix would match every path and
    // silently refuse to crawl the entire web.
    expect(isAllowed(rules, '/anything')).toBe(true);
  });

  test('a longer Allow overrides a broader Disallow', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /team\nAllow: /team/about',
      'OutreachGraphBot/0.1',
    );

    expect(isAllowed(rules, '/team/list')).toBe(false);
    expect(isAllowed(rules, '/team/about')).toBe(true);
  });

  test('wildcards and end-anchors are honoured', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /*.pdf$', 'OutreachGraphBot/0.1');

    expect(isAllowed(rules, '/docs/report.pdf')).toBe(false);
    expect(isAllowed(rules, '/docs/report.pdf.html')).toBe(true);
  });

  test('consecutive user-agent lines share one group', () => {
    const rules = parseRobots(
      'User-agent: Googlebot\nUser-agent: *\nDisallow: /nope',
      'OutreachGraphBot/0.1',
    );

    expect(isAllowed(rules, '/nope')).toBe(false);
  });

  test('crawl-delay is carried through', () => {
    const rules = parseRobots('User-agent: *\nCrawl-delay: 4', 'OutreachGraphBot/0.1');
    expect(rules.crawlDelaySeconds).toBe(4);
  });
});

describe('fetchPage', () => {
  test('a disallowed path is refused without fetching it', async () => {
    let pageRequested = false;
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = input.toString();
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /', {
          headers: { 'content-type': 'text/plain' },
        });
      }
      pageRequested = true;
      return new Response('<html></html>');
    };

    const page = await fetchPage('https://example.com/', { fetchImpl });

    expect(page.outcome).toBe('robots_denied');
    expect(pageRequested).toBe(false);
  });

  test('a non-html response is reported rather than parsed', async () => {
    const page = await fetchPage('https://example.com/', {
      fetchImpl: stubFetch({
        'https://example.com/robots.txt': { body: '', type: 'text/plain' },
        'https://example.com/': { body: '%PDF-1.4', type: 'application/pdf' },
      }),
    });

    expect(page.outcome).toBe('not_html');
  });

  test('an oversized body is rejected', async () => {
    const page = await fetchPage('https://example.com/', {
      maxBytes: 50,
      fetchImpl: stubFetch({
        'https://example.com/robots.txt': { body: '', type: 'text/plain' },
        'https://example.com/': { body: '<html>' + 'x'.repeat(500) + '</html>' },
      }),
    });

    expect(page.outcome).toBe('too_large');
  });

  test('the user agent names the product and how to reach us', () => {
    expect(USER_AGENT).toContain('OutreachGraphBot');
    expect(USER_AGENT).toContain('https://');
  });

  test('the same body hashes the same, so an unchanged page is recognisable', async () => {
    const routes = {
      'https://example.com/robots.txt': { body: '', type: 'text/plain' },
      'https://example.com/': { body: '<html><title>Loopwright</title></html>' },
    };

    const first = await fetchPage('https://example.com/', { fetchImpl: stubFetch(routes) });
    const second = await fetchPage('https://example.com/', { fetchImpl: stubFetch(routes) });

    expect(first.contentHash).toBe(second.contentHash!);
    expect(first.contentHash).toHaveLength(64);
  });
});

describe('deterministic extraction', () => {
  const HTML = `
    <html><head>
      <title>Loopwright — agent reliability</title>
      <meta property="og:site_name" content="Loopwright" />
      <meta name="description" content="Reliability tooling for agent teams." />
      <script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Organization","name":"Loopwright",
         "description":"Reliability tooling for agent teams.",
         "sameAs":["https://github.com/loopwright","https://x.com/loopwright"]}
      </script>
      <script type="application/ld+json">
        {"@type":"Person","name":"Alex Chen","jobTitle":"Staff Engineer",
         "sameAs":["https://github.com/alexchen"]}
      </script>
    </head><body>
      <a rel="me" href="https://bsky.app/profile/loopwright.io">bluesky</a>
    </body></html>`;

  test('the organisation is read from JSON-LD, not the page title', () => {
    const company = extractCompany(HTML, 'https://loopwright.io/');

    // <title> says "Loopwright — agent reliability"; the structured statement
    // is the company's actual name and has to win.
    expect(company.name).toBe('Loopwright');
    expect(company.domain).toBe('loopwright.io');
    expect(company.description).toContain('Reliability tooling');
  });

  test('sameAs and rel=me both become identities', () => {
    const company = extractCompany(HTML, 'https://loopwright.io/');
    const networks = company.identities.map((i) => i.network).sort();

    expect(networks).toContain('github');
    expect(networks).toContain('x');
    expect(networks).toContain('bluesky');
  });

  test('a JSON-LD person carries their title and company', () => {
    const company = extractCompany(HTML, 'https://loopwright.io/');
    const people = extractPeople(HTML, 'https://loopwright.io/', company);

    expect(people).toHaveLength(1);
    expect(people[0]!.fullName).toBe('Alex Chen');
    expect(people[0]!.title).toBe('Staff Engineer');
    expect(people[0]!.companyName).toBe('Loopwright');
    expect(people[0]!.identities[0]!.handle).toBe('alexchen');
  });

  test('an @graph wrapper is unwrapped', () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"Organization","name":"Graphed Co"}]}</script>`;

    expect(extractCompany(html, 'https://graphed.co/').name).toBe('Graphed Co');
  });

  test('malformed JSON-LD does not stop the other routes', () => {
    const html = `<html><head>
      <script type="application/ld+json">{ not json at all </script>
      <meta property="og:site_name" content="Still Here" />
    </head></html>`;

    expect(extractCompany(html, 'https://x.example/').name).toBe('Still Here');
  });

  test('a linkedin company path yields the company slug, not the word company', () => {
    expect(networkForUrl('https://www.linkedin.com/company/loopwright')).toBe('linkedin');
    const company = extractCompany(
      '<a href="https://www.linkedin.com/company/loopwright">li</a>',
      'https://loopwright.io/',
    );
    expect(company.identities[0]!.handle).toBe('loopwright');
  });

  test('a page with no structured data names nobody', () => {
    const result = extractSite('<html><body><p>We are a team.</p></body></html>', 'https://a.io/');
    expect(result.people).toHaveLength(0);
  });
});

describe('model extraction', () => {
  function modelReturning(text: string, refused = false): ExtractionModel {
    return { generate: async () => ({ text, refused }) };
  }

  test('visible text drops script, style and markup', () => {
    const text = visibleText(
      '<html><style>a{color:red}</style><script>var x=1</script><p>Hello&nbsp;world</p></html>',
    );

    expect(text).toBe('Hello world');
  });

  test('a fenced JSON reply is parsed', async () => {
    const model = modelReturning(
      '```json\n{"company":{"name":"Bespoke Co"},"people":[{"fullName":"Dana Reed","title":"CTO"}]}\n```',
    );

    const result = await extractWithModel(model, '<p>text</p>', 'https://b.co/', {
      identities: [],
      domain: 'b.co',
    });

    expect(result.company.name).toBe('Bespoke Co');
    expect(result.people[0]!.fullName).toBe('Dana Reed');
    expect(result.people[0]!.companyDomain).toBe('b.co');
  });

  test('a single-word name is discarded', async () => {
    const model = modelReturning(
      '{"people":[{"fullName":"Engineering"},{"fullName":"Ada Byron"}]}',
    );

    const result = await extractWithModel(model, '<p>x</p>', 'https://b.co/', { identities: [] });

    // "Engineering" is a department. Turning it into a prospect would put a
    // fabricated human into the approval queue.
    expect(result.people.map((p) => p.fullName)).toEqual(['Ada Byron']);
  });

  test('a refusal yields nothing rather than throwing', async () => {
    const result = await extractWithModel(modelReturning('no', true), '<p>x</p>', 'https://b.co/', {
      identities: [],
    });

    expect(result.people).toHaveLength(0);
    expect(result.company.name).toBeUndefined();
  });

  test('an unparseable reply yields nothing rather than throwing', async () => {
    const result = await extractWithModel(
      modelReturning('I am unable to find any JSON here'),
      '<p>x</p>',
      'https://b.co/',
      { identities: [] },
    );

    expect(result.people).toHaveLength(0);
  });

  test('a thrown model error does not fail the crawl', async () => {
    const model: ExtractionModel = {
      generate: async () => {
        throw new Error('api down');
      },
    };

    const result = await extractWithModel(model, '<p>x</p>', 'https://b.co/', { identities: [] });
    expect(result.people).toHaveLength(0);
  });
});

describe('SiteProvider', () => {
  const ROBOTS = { body: '', type: 'text/plain' };

  test('a well-marked-up page never reaches the model', async () => {
    let modelCalls = 0;
    const model: ExtractionModel = {
      generate: async () => {
        modelCalls += 1;
        return { text: '{}', refused: false };
      },
    };

    const provider = new SiteProvider({
      model,
      fetchImpl: stubFetch({
        'https://loop.io/robots.txt': ROBOTS,
        'https://loop.io/': {
          body: `<script type="application/ld+json">
            {"@type":"Organization","name":"Loop"}</script>
            <script type="application/ld+json">
            {"@type":"Person","name":"Alex Chen"}</script>`,
        },
      }),
    });

    const result = await provider.crawl('https://loop.io/');

    expect(result.company.name).toBe('Loop');
    expect(result.people).toHaveLength(1);
    // The whole economic argument for the hybrid: structured data is free.
    expect(modelCalls).toBe(0);
    expect(result.usedSignals).not.toContain('model');
  });

  test('a bespoke page falls through to the model', async () => {
    const model: ExtractionModel = {
      generate: async () => ({
        text: '{"company":{"name":"Handmade Ltd"},"people":[{"fullName":"Sam Rivers","title":"Founder"}]}',
        refused: false,
      }),
    };

    const provider = new SiteProvider({
      model,
      fetchImpl: stubFetch({
        'https://handmade.example/robots.txt': ROBOTS,
        'https://handmade.example/': {
          body: '<html><body><h1>We build things</h1><p>Sam Rivers, Founder</p></body></html>',
        },
      }),
    });

    const result = await provider.crawl('https://handmade.example/');

    expect(result.company.name).toBe('Handmade Ltd');
    expect(result.people[0]!.fullName).toBe('Sam Rivers');
    expect(result.usedSignals).toContain('model');
  });

  test('without a model it degrades to deterministic-only', async () => {
    const provider = new SiteProvider({
      fetchImpl: stubFetch({
        'https://plain.example/robots.txt': ROBOTS,
        'https://plain.example/': { body: '<html><body><p>Nothing structured</p></body></html>' },
      }),
    });

    const result = await provider.crawl('https://plain.example/');

    expect(result.outcome).toBe('ok');
    expect(result.people).toHaveLength(0);
  });

  test('a blocked page is a result, not a throw', async () => {
    const provider = new SiteProvider({
      fetchImpl: stubFetch({
        'https://blocked.example/robots.txt': {
          body: 'User-agent: *\nDisallow: /',
          type: 'text/plain',
        },
      }),
    });

    const result = await provider.crawl('https://blocked.example/');

    expect(result.outcome).toBe('robots_denied');
    expect(result.people).toHaveLength(0);
  });

  test('a bare domain is normalised to https', () => {
    expect(normaliseUrl('example.com')).toBe('https://example.com');
    expect(normaliseUrl('http://example.com')).toBe('http://example.com');
  });

  test('it does not claim it can search', () => {
    expect(new SiteProvider().capabilities().canSearch).toBe(false);
  });
});
