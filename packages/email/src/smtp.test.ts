/**
 * SMTP tests, against a real socket.
 *
 * The interesting failures in an SMTP client are all conversational — a
 * multi-line reply read as several replies, an EHLO whose capabilities are
 * parsed off by one, a password sent before the connection is encrypted — and
 * none of them are visible to a test that stubs the transport. So these run a
 * scripted server on loopback and let the client talk to it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { SmtpMailer, buildMessage, verifySmtp, type SmtpConfig } from './smtp';

interface FakeServer {
  readonly port: number;
  /** Every command line the client sent, in order. */
  readonly received: string[];
  close(): Promise<void>;
}

interface FakeOptions {
  /** Capability lines returned after EHLO, without the `250` prefix. */
  readonly capabilities?: readonly string[];
  /** Reply code for the AUTH exchange's final step. 235 accepts. */
  readonly authCode?: number;
  /** Reply code for the end of DATA. */
  readonly dataCode?: number;
  readonly dataText?: string;
}

/**
 * A scripted SMTP server.
 *
 * Only as much of the protocol as the client exercises, and it answers
 * line-by-line exactly as a real server does — including sending the EHLO
 * capabilities as one multi-line reply, which is the case a naive reader gets
 * wrong.
 */
async function startFake(options: FakeOptions = {}): Promise<FakeServer> {
  const received: string[] = [];
  const capabilities = options.capabilities ?? ['PIPELINING', 'AUTH PLAIN LOGIN', 'SIZE 10240000'];

  const server = net.createServer((socket) => {
    let inData = false;
    let authStep = 0;

    socket.setEncoding('utf8');
    socket.write('220 fake.example ESMTP ready\r\n');

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;

      let index = buffer.indexOf('\r\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(line);
        index = buffer.indexOf('\r\n');
      }
    });

    function handle(line: string): void {
      if (inData) {
        // The body is echoed into `received` so a test can assert on the
        // message that actually went over the wire.
        received.push(line);
        if (line === '.') {
          inData = false;
          socket.write(
            `${options.dataCode ?? 250} ${options.dataText ?? 'OK queued as ABC123XYZ'}\r\n`,
          );
        }
        return;
      }

      received.push(line);
      const verb = line.split(' ')[0]?.toUpperCase() ?? '';

      if (authStep > 0) {
        // Mid AUTH LOGIN: username, then password.
        authStep += 1;
        if (authStep === 2) socket.write('334 UGFzc3dvcmQ6\r\n');
        else {
          authStep = 0;
          socket.write(`${options.authCode ?? 235} 2.7.0 Authentication successful\r\n`);
        }
        return;
      }

      switch (verb) {
        case 'EHLO': {
          const lines = ['fake.example greets you', ...capabilities];
          const rendered = lines
            .map((text, i) => `250${i === lines.length - 1 ? ' ' : '-'}${text}`)
            .join('\r\n');
          socket.write(`${rendered}\r\n`);
          return;
        }
        case 'AUTH': {
          const mechanism = line.split(/\s+/)[1]?.toUpperCase();
          if (mechanism === 'PLAIN') {
            socket.write(`${options.authCode ?? 235} 2.7.0 Authentication successful\r\n`);
          } else {
            authStep = 1;
            socket.write('334 VXNlcm5hbWU6\r\n');
          }
          return;
        }
        case 'MAIL':
        case 'RCPT':
          socket.write('250 2.1.0 OK\r\n');
          return;
        case 'DATA':
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          return;
        case 'QUIT':
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
          return;
        default:
          socket.write('502 5.5.2 Command not implemented\r\n');
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let running: FakeServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

function config(port: number, overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: '127.0.0.1',
    port,
    secure: false,
    username: 'sales@example.com',
    password: 'hunter2',
    from: 'sales@example.com',
    fromName: 'Anthony',
    // The fake server speaks plaintext, and the point of these tests is the
    // conversation rather than the transport.
    allowInsecureAuth: true,
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe('verifySmtp', () => {
  test('reports success and what the server said', async () => {
    running = await startFake();
    const result = await verifySmtp(config(running.port));

    expect(result.ok).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.greeting).toContain('fake.example');
  });

  test('prefers AUTH PLAIN when the server offers it', async () => {
    running = await startFake();
    await verifySmtp(config(running.port));

    // One round trip rather than three. The base64 is `\0user\0pass`.
    const auth = running.received.find((line) => line.startsWith('AUTH'));
    expect(auth).toBe(
      `AUTH PLAIN ${Buffer.from('\0sales@example.com\0hunter2').toString('base64')}`,
    );
  });

  test('falls back to AUTH LOGIN when PLAIN is not offered', async () => {
    // Office 365 advertises LOGIN and not PLAIN; a client that only speaks
    // PLAIN silently cannot send for a large share of business customers.
    running = await startFake({ capabilities: ['AUTH LOGIN'] });
    const result = await verifySmtp(config(running.port));

    expect(result.ok).toBe(true);
    expect(running.received).toContain('AUTH LOGIN');
    expect(running.received).toContain(Buffer.from('sales@example.com').toString('base64'));
  });

  test('carries the server’s own words back on a rejected password', async () => {
    running = await startFake({ authCode: 535 });
    const result = await verifySmtp(config(running.port));

    expect(result.ok).toBe(false);
    // "the server rejected the credentials" is the difference between a
    // customer fixing their password and filing a bug about our software.
    expect(result.error).toContain('rejected the credentials');
  });

  test('refuses to send a password over an unencrypted connection', async () => {
    running = await startFake({ capabilities: ['PIPELINING', 'AUTH PLAIN'] });
    const result = await verifySmtp(config(running.port, { allowInsecureAuth: false }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no encryption');
    // And it really did not send it.
    expect(running.received.some((line) => line.startsWith('AUTH'))).toBe(false);
  });

  test('explains an unreachable server rather than hanging', async () => {
    // Port 1 is reserved and nothing listens on it.
    const result = await verifySmtp(config(1, { timeoutMs: 3_000 }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refused|reach|timed out/i);
  });
});

describe('SmtpMailer', () => {
  test('walks the full envelope and returns the queue id', async () => {
    running = await startFake();
    const mailer = new SmtpMailer(config(running.port));

    const result = await mailer.send({
      to: 'lead@prospect.com',
      subject: 'Quick question',
      text: 'Hello there',
      replyTo: 'anthony@example.com',
    });

    expect(running.received).toContain('MAIL FROM:<sales@example.com>');
    expect(running.received).toContain('RCPT TO:<lead@prospect.com>');
    expect(running.received).toContain('DATA');
    expect(result.id).toBe('ABC123XYZ');
  });

  test('sends headers the recipient’s server will accept', async () => {
    running = await startFake();
    await new SmtpMailer(config(running.port)).send({
      to: 'lead@prospect.com',
      subject: 'Quick question',
      text: 'Hello there',
      replyTo: 'anthony@example.com',
    });

    const wire = running.received.join('\n');
    expect(wire).toContain('From: Anthony <sales@example.com>');
    expect(wire).toContain('To: lead@prospect.com');
    expect(wire).toContain('Reply-To: anthony@example.com');
    expect(wire).toContain('MIME-Version: 1.0');
    // `GMT` is obsolete syntax that some receivers score against.
    expect(wire).toContain('+0000');
  });

  test('surfaces a rejected message as a failure, not a success', async () => {
    running = await startFake({ dataCode: 550, dataText: '5.7.1 Message rejected' });
    const mailer = new SmtpMailer(config(running.port));

    // Autopilot counts failures to decide when to stop retrying, so a rejected
    // message that resolved would be retried forever and reported as sent.
    await expect(
      mailer.send({ to: 'lead@prospect.com', subject: 'Hi', text: 'body' }),
    ).rejects.toThrow(/rejected/i);
  });
});

describe('buildMessage', () => {
  const base: SmtpConfig = {
    host: 'h',
    port: 587,
    secure: false,
    from: 'sales@example.com',
    fromName: 'Anthony',
  };

  test('base64-encodes the body so nothing in it can corrupt the message', () => {
    // A drafted outreach message is user text: it can contain a line that is
    // just a full stop, or a line longer than the 998-octet limit. Base64
    // makes both impossible rather than needing to be handled.
    const message = buildMessage(base, { to: 'a@b.com', subject: 'Hi', text: '.\nstop' });

    expect(message).toContain('Content-Transfer-Encoding: base64');
    expect(message).toContain(Buffer.from('.\nstop', 'utf8').toString('base64'));
  });

  test('encodes a subject that is not plain ASCII', () => {
    const message = buildMessage(base, { to: 'a@b.com', subject: 'Café ☕', text: 'x' });

    expect(message).toContain('Subject: =?UTF-8?B?');
    expect(message).not.toContain('Subject: Café');
  });

  test('leaves an ASCII subject readable', () => {
    // Encoding everything works but makes every message look like spam in a
    // log, and needlessly so.
    expect(buildMessage(base, { to: 'a@b.com', subject: 'Hello', text: 'x' })).toContain(
      'Subject: Hello',
    );
  });

  test('builds multipart/alternative when there is HTML', () => {
    const message = buildMessage(base, {
      to: 'a@b.com',
      subject: 'Hi',
      text: 'plain',
      html: '<p>rich</p>',
    });

    expect(message).toContain('Content-Type: multipart/alternative; boundary="');
    expect(message).toContain('Content-Type: text/plain; charset=utf-8');
    expect(message).toContain('Content-Type: text/html; charset=utf-8');
  });

  test('gives every message a unique id on the sender’s domain', () => {
    const first = buildMessage(base, { to: 'a@b.com', subject: 'Hi', text: 'x' });
    const second = buildMessage(base, { to: 'a@b.com', subject: 'Hi', text: 'x' });

    expect(first).toContain('@example.com>');
    expect(/Message-ID: <([^>]+)>/.exec(first)?.[1]).not.toBe(
      /Message-ID: <([^>]+)>/.exec(second)?.[1],
    );
  });
});
