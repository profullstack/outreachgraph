import { describe, expect, test } from 'bun:test';
import { C0mputeModel } from './c0mpute';
import { isBudgetExhausted } from './fallback';

const SSE = [
  'event: job\ndata: {"id":"j1","status":"assigned"}\n\n',
  'event: meta\ndata: {"model":"qwen2.5:7b","engine":"ollama"}\n\n',
  'event: token\ndata: {"text":"{\\"ok\\""}\n\n',
  'event: token\ndata: {"text":":true}"}\n\n',
  'event: done\ndata: {"text":"{\\"ok\\":true}","reason":"stop"}\n\n',
];

function fake(source: string, chunks = SSE, submitStatus = 200) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (href.endsWith('/api/chat')) {
      return new Response(
        JSON.stringify(
          submitStatus === 200 ? { jobId: 'j1', source } : { error: 'Rate limit exceeded' },
        ),
        { status: submitStatus, headers: { 'content-type': 'application/json' } },
      );
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-event, as a real network does.
        const all = new TextEncoder().encode(chunks.join(''));
        controller.enqueue(all.slice(0, 37));
        controller.enqueue(all.slice(37));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('C0mputeModel', () => {
  test('submits a chat job and reads the answer from the stream', async () => {
    const { fetchImpl, calls } = fake('p2p');
    const model = new C0mputeModel({ fetchImpl, baseUrl: 'https://infernet.test' });
    const out = await model.generate({ system: 'Be brief.', user: 'Say ok', maxTokens: 50 });
    expect(out.text).toBe('{"ok":true}');
    expect(out.model).toBe('c0mpute/qwen2.5:7b');
    expect(calls[0]).toMatchObject({
      url: 'https://infernet.test/api/chat',
      body: {
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Say ok' },
        ],
        maxTokens: 50,
      },
    });
    expect(calls[1]!.url).toBe('https://infernet.test/api/chat/stream/j1');
  });

  test('refuses a paid hosted fallback by default, as unavailable', async () => {
    const { fetchImpl, calls } = fake('nim');
    const model = new C0mputeModel({ fetchImpl });
    const error = await model.generate({ system: '', user: 'hi' }).catch((e: unknown) => e);
    expect(String(error)).toContain('no c0mpute node took the job');
    expect(isBudgetExhausted(error)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('a rate limit is read as unavailable by the fallback chain', async () => {
    const { fetchImpl } = fake('p2p', SSE, 429);
    const error = await new C0mputeModel({ fetchImpl })
      .generate({ system: '', user: 'hi' })
      .catch((e: unknown) => e);
    expect(isBudgetExhausted(error)).toBe(true);
  });

  test('an error event fails the call', async () => {
    const { fetchImpl } = fake('p2p', ['event: error\ndata: {"message":"node crashed"}\n\n']);
    const error = await new C0mputeModel({ fetchImpl })
      .generate({ system: '', user: 'hi' })
      .catch((e: unknown) => e);
    expect(String(error)).toContain('node crashed');
  });
});
