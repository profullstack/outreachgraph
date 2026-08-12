import { describe, expect, test } from 'bun:test';
import { ConsoleMailer, MailerError, ResendMailer } from './mailer';
import { verificationEmail } from './templates';

function captureFetch(): { calls: RequestInit[]; impl: typeof fetch } {
  const calls: RequestInit[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return new Response('{"id":"1"}', { status: 200 });
  }) as unknown as typeof fetch;

  return { calls, impl };
}

describe('ResendMailer', () => {
  test('sends the message with the configured sender', async () => {
    const { calls, impl } = captureFetch();
    const mailer = new ResendMailer({ apiKey: 'key', from: 'hi@og.com', fetchImpl: impl });

    await mailer.send({ to: 'a@b.com', subject: 'Hi', text: 'body' });

    const body = JSON.parse(String(calls[0]?.body));
    expect(body.from).toBe('hi@og.com');
    expect(body.to).toEqual(['a@b.com']);
    expect(body.subject).toBe('Hi');
  });

  test('the API key travels as a bearer token, never in the body', async () => {
    const { calls, impl } = captureFetch();
    await new ResendMailer({ apiKey: 'secret', from: 'a@b.com', fetchImpl: impl }).send({
      to: 'c@d.com',
      subject: 'x',
      text: 'y',
    });

    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret');
    expect(String(calls[0]?.body)).not.toContain('secret');
  });

  test('a rejection carries the provider reason rather than a bare status', async () => {
    const impl = (async () =>
      new Response('domain not verified', { status: 403 })) as unknown as typeof fetch;

    const mailer = new ResendMailer({ apiKey: 'k', from: 'a@b.com', fetchImpl: impl });

    // Every failure looking identical is what makes "email is broken" take a
    // day to diagnose instead of a minute.
    await expect(mailer.send({ to: 'c@d.com', subject: 'x', text: 'y' })).rejects.toThrow(
      /domain not verified/,
    );
  });

  test('the thrown error exposes the status for callers that branch on it', async () => {
    const impl = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;

    try {
      await new ResendMailer({ apiKey: 'k', from: 'a@b.com', fetchImpl: impl }).send({
        to: 'c@d.com',
        subject: 'x',
        text: 'y',
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MailerError);
      expect((error as MailerError).status).toBe(429);
    }
  });
});

describe('ConsoleMailer', () => {
  test('logs rather than sends, so signup completes with no credentials', async () => {
    const lines: string[] = [];
    await new ConsoleMailer((line) => lines.push(line)).send({
      to: 'a@b.com',
      subject: 'Confirm',
      text: 'https://example.com/verify?token=abc',
    });

    expect(lines[0]).toContain('a@b.com');
    // The link must be recoverable from the log or local signup is a dead end.
    expect(lines[0]).toContain('token=abc');
  });
});

describe('verificationEmail', () => {
  test('the plain-text part carries the whole link', async () => {
    const message = verificationEmail('a@b.com', 'https://og.com/verify?token=xyz');

    expect(message.text).toContain('https://og.com/verify?token=xyz');
    expect(message.to).toBe('a@b.com');
  });

  test('a link with markup in it cannot break out of the html', async () => {
    const message = verificationEmail(
      'a@b.com',
      'https://og.com/verify?token="><script>x</script>',
    );

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });

  test('the brand mark is served from the same origin as the link', async () => {
    const message = verificationEmail('a@b.com', 'https://og.com/verify?token=xyz');

    expect(message.html).toContain('src="https://og.com/favicon.png"');
  });

  test('a link that is not an absolute url still produces a sendable message', async () => {
    const message = verificationEmail('a@b.com', '/verify?token=xyz');

    expect(message.html).not.toContain('<img');
    expect(message.text).toContain('/verify?token=xyz');
  });
});
