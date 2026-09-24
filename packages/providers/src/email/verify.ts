/**
 * Asking a domain's own mail servers whether an address exists.
 *
 * `patterns.ts` proposes; this is the half that checks. Two questions, asked in
 * order of how often they can be answered:
 *
 *   1. **Does the domain take mail at all?** An MX lookup. Always answerable,
 *      and a hard gate: an address at a domain with no mail exchanger bounces
 *      whatever its local part, so nothing past this point is worth doing.
 *   2. **Does this mailbox exist?** An SMTP conversation that stops at `RCPT
 *      TO` — no `DATA`, so nothing is ever delivered. Frequently unanswerable,
 *      and the module is built around that rather than surprised by it:
 *
 *        - Cloud hosts (Railway among them) block outbound port 25, so the
 *          connection never opens.
 *        - Large providers reject connections from cloud IP ranges at the
 *          greeting, before any question can be asked.
 *        - A *catch-all* domain says yes to every recipient, so a yes proves
 *          nothing. That is detected by asking about a local part nobody has,
 *          and a domain that accepts it has its answers discounted.
 *
 * So every result says which of those happened, and the caller scores the
 * address from its evidence either way. A blocked port degrades the job to
 * "learned pattern plus MX", never to a failure.
 */

import { resolveMx as nodeResolveMx } from 'node:dns/promises';
import { connect, type Socket } from 'node:net';

export interface MxRecord {
  readonly exchange: string;
  readonly priority: number;
}

/** What one SMTP session could say about the addresses it was asked about. */
export type SmtpProbeResult =
  | {
      readonly reachable: true;
      /** RCPT reply code per address, as asked. */
      readonly codes: ReadonlyMap<string, number>;
    }
  | {
      readonly reachable: false;
      /** Why no question could be asked: `connect_failed`, `greeting_550`, … */
      readonly reason: string;
    };

export interface SmtpProber {
  probe(mxHost: string, addresses: readonly string[]): Promise<SmtpProbeResult>;
}

export interface VerifierDeps {
  /** Injected so tests never touch the network. Defaults to `node:dns`. */
  readonly resolveMx?: (domain: string) => Promise<readonly MxRecord[]>;
  /** Omit to skip SMTP entirely — MX-only verification. */
  readonly smtp?: SmtpProber;
  /** The local part used to test for catch-all. Injected for determinism. */
  readonly randomLocalPart?: () => string;
}

export type AddressVerdict = 'accepted' | 'rejected' | 'unknown';

export interface DomainVerification {
  readonly domain: string;
  /** Mail exchangers, best first. Empty means the domain takes no mail. */
  readonly mx: readonly string[];
  /**
   * `probed` — a server answered RCPT for these addresses.
   * `unavailable` — no server could be asked (blocked port, refused greeting).
   * `skipped` — no prober configured, or no MX to ask.
   */
  readonly smtp: 'probed' | 'unavailable' | 'skipped';
  /** Why `smtp` is `unavailable`, for the evidence trail. */
  readonly smtpReason?: string;
  /** True when a made-up recipient was accepted. Undefined when not asked. */
  readonly catchAll?: boolean;
  readonly verdicts: ReadonlyMap<string, AddressVerdict>;
  /** RCPT reply codes, when there were any. */
  readonly codes: ReadonlyMap<string, number>;
}

/** Thrown for a DNS failure that is not an answer — a timeout, a SERVFAIL. */
export class TransientDnsError extends Error {
  constructor(domain: string, code: string) {
    super(`MX lookup for ${domain} failed: ${code}`);
    this.name = 'TransientDnsError';
  }
}

/**
 * DNS codes that *are* an answer: the name does not exist, or exists and has
 * no MX. Anything else is the resolver failing, and must be retried rather
 * than recorded as "this domain takes no mail".
 */
const NO_MAIL_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

async function defaultResolveMx(domain: string): Promise<readonly MxRecord[]> {
  try {
    return await nodeResolveMx(domain);
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'unknown';
    if (NO_MAIL_CODES.has(code)) return [];
    throw new TransientDnsError(domain, code);
  }
}

function defaultRandomLocalPart(): string {
  // Long and unpronounceable, so no real mailbox and no plausible alias can
  // collide with it.
  return `og-verify-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** 250/251 accept; 5xx refuses. Everything else (4xx greylisting) says nothing. */
function verdictFor(code: number | undefined): AddressVerdict {
  if (code === undefined) return 'unknown';
  if (code === 250 || code === 251) return 'accepted';
  if (code >= 500 && code < 600) return 'rejected';
  return 'unknown';
}

/**
 * Verifies a set of candidate addresses that share one domain.
 *
 * One MX lookup and at most one SMTP session per domain, whatever the number of
 * candidates: every RCPT goes down the same connection, the catch-all probe
 * first. Asking a server the same question over five connections is how a
 * prober gets itself rate-limited or listed.
 */
export async function verifyDomainCandidates(
  domain: string,
  addresses: readonly string[],
  deps: VerifierDeps = {},
): Promise<DomainVerification> {
  const resolveMx = deps.resolveMx ?? defaultResolveMx;
  const records = [...(await resolveMx(domain))]
    .filter((record) => record.exchange && record.exchange !== '.')
    .sort((a, b) => a.priority - b.priority);
  const mx = records.map((record) => record.exchange.replace(/\.$/, '').toLowerCase());

  const unknown = new Map(addresses.map((address) => [address, 'unknown' as AddressVerdict]));

  // RFC 7505 null MX (`0 .`) was filtered above, so it lands here too: the
  // domain has said in DNS that it accepts no mail.
  if (mx.length === 0) {
    return { domain, mx, smtp: 'skipped', verdicts: unknown, codes: new Map() };
  }

  if (!deps.smtp || addresses.length === 0) {
    return { domain, mx, smtp: 'skipped', verdicts: unknown, codes: new Map() };
  }

  const probeAddress = `${(deps.randomLocalPart ?? defaultRandomLocalPart)()}@${domain}`;
  const primary = mx[0] as string;
  const result = await deps.smtp.probe(primary, [probeAddress, ...addresses]);

  if (!result.reachable) {
    return {
      domain,
      mx,
      smtp: 'unavailable',
      smtpReason: result.reason,
      verdicts: unknown,
      codes: new Map(),
    };
  }

  const catchAllVerdict = verdictFor(result.codes.get(probeAddress));
  // An inconclusive answer about the fake address leaves catch-all unknown,
  // not false: we only call a domain strict when it demonstrably refused.
  const catchAll =
    catchAllVerdict === 'accepted' ? true : catchAllVerdict === 'rejected' ? false : undefined;

  const verdicts = new Map<string, AddressVerdict>();
  const codes = new Map<string, number>();

  for (const address of addresses) {
    const code = result.codes.get(address);
    if (code !== undefined) codes.set(address, code);
    // On a catch-all domain an acceptance is the server being polite, not a
    // fact about the mailbox. A refusal is still a refusal.
    const verdict = verdictFor(code);
    verdicts.set(address, catchAll === true && verdict === 'accepted' ? 'unknown' : verdict);
  }

  return { domain, mx, smtp: 'probed', catchAll, verdicts, codes };
}

export interface SmtpProberOptions {
  /** Name given in EHLO. Should resolve back to something we own. */
  readonly helo?: string;
  /** MAIL FROM. The null sender `<>` is what bounce and probe traffic uses. */
  readonly from?: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  /**
   * Consecutive connection failures, across different hosts, after which the
   * port is assumed blocked for this process and probing stops for
   * `blockedForMs`. One host being down says nothing; three in a row on a
   * cloud host is the firewall.
   */
  readonly blockedAfter?: number;
  readonly blockedForMs?: number;
  /** Injected for tests. */
  readonly connectSocket?: (host: string, port: number) => Socket;
  readonly now?: () => number;
}

/**
 * A prober that speaks just enough SMTP to ask RCPT and leave.
 *
 * Stateful on purpose: it remembers that port 25 looks blocked, so a worker on
 * a host that forbids it spends three timeouts finding out rather than one per
 * domain for ever.
 */
export function createSmtpProber(options: SmtpProberOptions = {}): SmtpProber & {
  /** True while the prober has concluded port 25 is blocked from here. */
  readonly blocked: () => boolean;
} {
  const helo = options.helo ?? 'outreachgraph.com';
  const from = options.from ?? '';
  const port = options.port ?? 25;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const blockedAfter = options.blockedAfter ?? 3;
  const blockedForMs = options.blockedForMs ?? 3_600_000;
  const clock = options.now ?? Date.now;
  const open = options.connectSocket ?? ((host: string, p: number) => connect(p, host));

  let consecutiveConnectFailures = 0;
  let blockedUntil = 0;

  const blocked = (): boolean => clock() < blockedUntil;

  async function probe(mxHost: string, addresses: readonly string[]): Promise<SmtpProbeResult> {
    if (blocked()) return { reachable: false, reason: 'port_blocked' };

    const outcome = await converse(open(mxHost, port), helo, from, addresses, timeoutMs);

    if (!outcome.reachable && outcome.reason === 'connect_failed') {
      consecutiveConnectFailures += 1;
      if (consecutiveConnectFailures >= blockedAfter) blockedUntil = clock() + blockedForMs;
    } else {
      consecutiveConnectFailures = 0;
    }

    return outcome;
  }

  return { probe, blocked };
}

/**
 * One SMTP session: greeting, EHLO, MAIL FROM, one RCPT per address, QUIT.
 *
 * Never sends DATA. A reply is read as complete at the line whose fourth
 * character is a space, per RFC 5321's multiline rule; EHLO replies are
 * routinely a dozen lines.
 */
function converse(
  socket: Socket,
  helo: string,
  from: string,
  addresses: readonly string[],
  timeoutMs: number,
): Promise<SmtpProbeResult> {
  return new Promise((resolve) => {
    let buffer = '';
    let connected = false;
    let settled = false;
    let waiting: ((code: number) => void) | undefined;

    const finish = (result: SmtpProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (connected) socket.write('QUIT\r\n');
      } catch {
        // Already gone; nothing to be polite to.
      }
      socket.destroy();
      resolve(result);
    };

    // Before the greeting a timeout is the firewall; after it, a slow server.
    const timer = setTimeout(
      () => finish({ reachable: false, reason: connected ? 'timeout' : 'connect_failed' }),
      timeoutMs,
    );

    socket.setEncoding?.('utf8');
    socket.on('error', () =>
      finish({ reachable: false, reason: connected ? 'connection_lost' : 'connect_failed' }),
    );
    socket.on('close', () =>
      finish({ reachable: false, reason: connected ? 'connection_lost' : 'connect_failed' }),
    );

    socket.on('data', (chunk: string | Buffer) => {
      connected = true;
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        // `250-` continues, `250 ` (or a bare `250`) ends the reply.
        if (/^\d{3}(?: |$)/.test(line)) {
          const handler = waiting;
          waiting = undefined;
          handler?.(Number(line.slice(0, 3)));
        }
        newline = buffer.indexOf('\n');
      }
    });

    const reply = (): Promise<number> =>
      new Promise<number>((next) => {
        waiting = next;
      });

    const send = (command: string): Promise<number> => {
      const pending = reply();
      socket.write(`${command}\r\n`);
      return pending;
    };

    void (async () => {
      const greeting = await reply();
      if (greeting !== 220) return finish({ reachable: false, reason: `greeting_${greeting}` });

      const ehlo = await send(`EHLO ${helo}`);
      if (ehlo !== 250) {
        const heloCode = await send(`HELO ${helo}`);
        if (heloCode !== 250) return finish({ reachable: false, reason: `helo_${heloCode}` });
      }

      const mailFrom = await send(`MAIL FROM:<${from}>`);
      if (mailFrom !== 250) return finish({ reachable: false, reason: `mail_from_${mailFrom}` });

      const codes = new Map<string, number>();
      for (const address of addresses) {
        codes.set(address, await send(`RCPT TO:<${address}>`));
      }

      finish({ reachable: true, codes });
    })();
  });
}
