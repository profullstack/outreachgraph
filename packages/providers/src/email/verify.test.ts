/**
 * Verification without the network.
 *
 * DNS and the SMTP prober are both injected, so the scoring-relevant cases —
 * no MX, a strict server, a catch-all, a blocked port — run as fixtures. The
 * wire protocol is exercised against a fake SMTP server on loopback, which is
 * the one piece that cannot be faked by substitution.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import {
  createSmtpProber,
  verifyDomainCandidates,
  type MxRecord,
  type SmtpProber,
  type SmtpProbeResult,
} from './verify';

const mx = (records: MxRecord[]) => async () => records;

/** A prober that answers from a table and records what it was asked. */
function fakeProber(answer: (address: string) => number | undefined, reachable = true) {
  const asked: string[][] = [];
  const prober: SmtpProber = {
    async probe(_host, addresses): Promise<SmtpProbeResult> {
      asked.push([...addresses]);
      if (!reachable) return { reachable: false, reason: 'connect_failed' };
      const codes = new Map<string, number>();
      for (const address of addresses) {
        const code = answer(address);
        if (code !== undefined) codes.set(address, code);
      }
      return { reachable: true, codes };
    },
  };
  return { prober, asked };
}

describe('verifyDomainCandidates', () => {
  test('a domain with no MX is reported as taking no mail, and no server is asked', async () => {
    const { prober, asked } = fakeProber(() => 250);
    const result = await verifyDomainCandidates('nomail.test', ['a@nomail.test'], {
      resolveMx: mx([]),
      smtp: prober,
    });

    expect(result.mx).toEqual([]);
    expect(result.smtp).toBe('skipped');
    expect(asked).toHaveLength(0);
  });

  test('a null MX (RFC 7505) counts as no MX', async () => {
    const result = await verifyDomainCandidates('null.test', ['a@null.test'], {
      resolveMx: mx([{ exchange: '.', priority: 0 }]),
    });
    expect(result.mx).toEqual([]);
  });

  test('a strict server: accepted and rejected mailboxes are told apart', async () => {
    const { prober, asked } = fakeProber((address) =>
      address === 'jane.smith@acme.test' ? 250 : 550,
    );

    const result = await verifyDomainCandidates(
      'acme.test',
      ['jane@acme.test', 'jane.smith@acme.test'],
      {
        resolveMx: mx([
          { exchange: 'mx2.acme.test', priority: 20 },
          { exchange: 'MX1.acme.test.', priority: 10 },
        ]),
        smtp: prober,
        randomLocalPart: () => 'nobody-xyz',
      },
    );

    expect(result.mx).toEqual(['mx1.acme.test', 'mx2.acme.test']);
    expect(result.smtp).toBe('probed');
    expect(result.catchAll).toBe(false);
    expect(result.verdicts.get('jane.smith@acme.test')).toBe('accepted');
    expect(result.verdicts.get('jane@acme.test')).toBe('rejected');
    // One session, the catch-all probe first.
    expect(asked).toEqual([['nobody-xyz@acme.test', 'jane@acme.test', 'jane.smith@acme.test']]);
  });

  test('a catch-all domain: acceptance proves nothing, refusal still counts', async () => {
    const { prober } = fakeProber((address) => (address.startsWith('bad') ? 550 : 250));

    const result = await verifyDomainCandidates('open.test', ['a@open.test', 'bad@open.test'], {
      resolveMx: mx([{ exchange: 'mx.open.test', priority: 10 }]),
      smtp: prober,
      randomLocalPart: () => 'nobody',
    });

    expect(result.catchAll).toBe(true);
    expect(result.verdicts.get('a@open.test')).toBe('unknown');
    expect(result.verdicts.get('bad@open.test')).toBe('rejected');
  });

  test('greylisting (4xx) is inconclusive rather than a refusal', async () => {
    const { prober } = fakeProber(() => 451);
    const result = await verifyDomainCandidates('grey.test', ['a@grey.test'], {
      resolveMx: mx([{ exchange: 'mx.grey.test', priority: 10 }]),
      smtp: prober,
    });
    expect(result.catchAll).toBeUndefined();
    expect(result.verdicts.get('a@grey.test')).toBe('unknown');
  });

  test('an unreachable server degrades to MX-only, with the reason kept', async () => {
    const { prober } = fakeProber(() => 250, false);
    const result = await verifyDomainCandidates('fw.test', ['a@fw.test'], {
      resolveMx: mx([{ exchange: 'mx.fw.test', priority: 10 }]),
      smtp: prober,
    });
    expect(result.smtp).toBe('unavailable');
    expect(result.smtpReason).toBe('connect_failed');
    expect(result.verdicts.get('a@fw.test')).toBe('unknown');
  });
});

describe('createSmtpProber against a loopback fake', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /** A minimal SMTP server: multiline EHLO, and RCPT answered from a table. */
  async function fakeSmtp(rcpt: (address: string) => number, greeting = 220): Promise<number> {
    server = createServer((socket) => {
      socket.write(`${greeting} fake.test ESMTP\r\n`);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf('\r\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 2);
          if (line.startsWith('EHLO')) socket.write('250-fake.test\r\n250-SIZE 1000\r\n250 OK\r\n');
          else if (line.startsWith('MAIL FROM')) socket.write('250 OK\r\n');
          else if (line.startsWith('RCPT TO:')) {
            const address = line.slice('RCPT TO:<'.length, -1);
            socket.write(`${rcpt(address)} reply\r\n`);
          } else if (line === 'QUIT') {
            socket.end('221 bye\r\n');
          } else if (line.startsWith('DATA')) {
            throw new Error('a probe must never send DATA');
          }
          newline = buffer.indexOf('\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  test('asks RCPT for each address down one connection', async () => {
    const port = await fakeSmtp((address) => (address === 'yes@x.test' ? 250 : 550));
    const prober = createSmtpProber({ port, timeoutMs: 2_000 });

    const result = await prober.probe('127.0.0.1', ['yes@x.test', 'no@x.test']);

    expect(result.reachable).toBe(true);
    if (result.reachable) {
      expect(result.codes.get('yes@x.test')).toBe(250);
      expect(result.codes.get('no@x.test')).toBe(550);
    }
  });

  test('a refused greeting (a cloud IP on a blocklist) is unreachable, not a verdict', async () => {
    const port = await fakeSmtp(() => 250, 554);
    const prober = createSmtpProber({ port, timeoutMs: 2_000 });

    const result = await prober.probe('127.0.0.1', ['a@x.test']);
    expect(result).toEqual({ reachable: false, reason: 'greeting_554' });
  });

  test('repeated connection failures mark port 25 blocked and stop asking', async () => {
    // Port 1 on loopback refuses at once, which stands in for the firewall.
    let clock = 0;
    const prober = createSmtpProber({
      port: 1,
      timeoutMs: 2_000,
      blockedAfter: 2,
      blockedForMs: 1_000,
      now: () => clock,
    });

    expect(await prober.probe('127.0.0.1', ['a@x.test'])).toEqual({
      reachable: false,
      reason: 'connect_failed',
    });
    expect(prober.blocked()).toBe(false);
    await prober.probe('127.0.0.1', ['a@x.test']);
    expect(prober.blocked()).toBe(true);
    expect(await prober.probe('127.0.0.1', ['a@x.test'])).toEqual({
      reachable: false,
      reason: 'port_blocked',
    });

    clock = 1_001;
    expect(prober.blocked()).toBe(false);
  });
});
