import { describe, expect, test } from 'bun:test';
import { SeoRankClient, SeoRankRefused, SeoRankUnavailable } from './index';

function stub(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const OK = {
  url: 'https://acme.test/',
  finalUrl: 'https://www.acme.test/',
  status: 200,
  score: 71,
  grade: 'C',
  summary: { pass: 18, warn: 4, fail: 3 },
  fixes: [{ id: 'title', label: 'Title', priority: 'high', fix: 'Write a title.' }],
  checkedAt: '2026-10-17T12:00:00.000Z',
};

describe('SeoRankClient', () => {
  test('asks for the summary with the key and the Host header, and parses it', async () => {
    const { fetchImpl, calls } = stub(200, OK);
    const client = new SeoRankClient({
      apiKey: 'k_123',
      baseUrl: 'http://10.0.0.1/',
      host: 'seo.rank',
      fetch: fetchImpl,
    });
    const audit = await client.audit('https://acme.test/');
    expect(audit.score).toBe(71);
    expect(audit.fixes[0]?.priority).toBe('high');
    expect(calls[0]?.url).toBe(
      'http://10.0.0.1/api/audit?url=https%3A%2F%2Facme.test%2F&fields=summary&top=5',
    );
    expect(calls[0]?.headers.authorization).toBe('Bearer k_123');
    expect(calls[0]?.headers.host).toBe('seo.rank');
  });

  test('400 and 422 are the site refusing', async () => {
    for (const status of [400, 422]) {
      const { fetchImpl } = stub(status, { error: 'unreachable' });
      const client = new SeoRankClient({ apiKey: 'k', fetch: fetchImpl });
      await expect(client.audit('https://x.test/')).rejects.toBeInstanceOf(SeoRankRefused);
    }
  });

  test('429, 503 and 401 mean seo.rank is unavailable, with Retry-After', async () => {
    const { fetchImpl } = stub(429, { error: 'cap' }, { 'retry-after': '120' });
    const client = new SeoRankClient({ apiKey: 'k', fetch: fetchImpl });
    const error = await client.audit('https://x.test/').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeoRankUnavailable);
    expect((error as SeoRankUnavailable).retryAfter).toBe(120);
    for (const status of [503, 401]) {
      const s = stub(status, {});
      await expect(
        new SeoRankClient({ apiKey: 'k', fetch: s.fetchImpl }).audit('https://x.test/'),
      ).rejects.toBeInstanceOf(SeoRankUnavailable);
    }
  });

  test('a 5xx is a plain transient error', async () => {
    const { fetchImpl } = stub(502, {});
    const error = await new SeoRankClient({ apiKey: 'k', fetch: fetchImpl })
      .audit('https://x.test/')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SeoRankRefused);
    expect(error).not.toBeInstanceOf(SeoRankUnavailable);
  });
});
