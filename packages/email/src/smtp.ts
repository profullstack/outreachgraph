/**
 * Sending as yourself.
 *
 * Resend sends from a domain *we* verified, which is right for account mail —
 * the verification link genuinely is from OutreachGraph — and wrong for
 * outreach. Outreach that says it came from us is outreach the recipient has no
 * relationship with, it burns our sending reputation on someone else's campaign,
 * and replies land in a mailbox the customer cannot read. Their own SMTP server
 * fixes all three at once: their envelope, their domain, their reputation.
 *
 * This speaks SMTP directly over `node:net`/`node:tls` rather than pulling in a
 * mail library. That is not asceticism — the protocol surface actually needed
 * here is small and completely specified (EHLO, STARTTLS, AUTH, MAIL, RCPT,
 * DATA), and it is worth owning because the failure messages *are* the feature:
 * "your server rejected the password", "your server offers no encryption", and
 * "your server accepted it" are three different things a customer must be able
 * to tell apart while configuring this, and a wrapped library error usually
 * cannot.
 *
 * The one rule that is not configurable: credentials never cross an unencrypted
 * connection. If a server offers no STARTTLS and the caller has a password, the
 * attempt fails rather than leaking it.
 */

import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import type { Mailer, Message, SendResult } from './mailer';
import { MailerError } from './mailer';

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /**
   * True for implicit TLS (port 465): the socket is encrypted from the first
   * byte. False for STARTTLS (587/25), where the connection opens in plaintext
   * and is upgraded before authentication.
   */
  readonly secure: boolean;
  readonly username?: string;
  readonly password?: string;
  /** Envelope sender and `From:` header. */
  readonly from: string;
  readonly fromName?: string;
  readonly timeoutMs?: number;
  /**
   * Accept a self-signed or otherwise unverifiable certificate.
   *
   * Off by default. On for the small number of self-hosted servers whose
   * certificate is genuinely private, and never a thing to set to make an
   * error go away.
   */
  readonly allowInvalidCertificate?: boolean;
  /**
   * Permit authentication over an unencrypted connection.
   *
   * Exists for a local relay on loopback, which is a real deployment and not a
   * security hole. Anything else should fail loudly instead.
   */
  readonly allowInsecureAuth?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** One reply from the server: its status code and the text that came with it. */
interface Reply {
  readonly code: number;
  readonly lines: readonly string[];
}

export class SmtpError extends Error {
  /** The SMTP status code, or 0 when the failure happened below the protocol. */
  readonly code: number;
  /** The command that provoked it, for a message a human can act on. */
  readonly stage: string;

  constructor(stage: string, code: number, detail: string) {
    super(detail);
    this.name = 'SmtpError';
    this.code = code;
    this.stage = stage;
  }
}

/**
 * A line-oriented SMTP conversation over one socket.
 *
 * SMTP replies are multi-line: `250-PIPELINING\r\n250 STARTTLS\r\n`. Only the
 * line whose code is followed by a space ends the reply. Reading them one line
 * at a time is the bug that makes a client work against one server and hang
 * against another, so the whole reply is assembled before anything sees it.
 */
class Conversation {
  #socket: net.Socket;
  #buffer = '';
  #lines: string[] = [];
  #ready: Reply[] = [];
  #waiter: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | undefined;
  #failure: Error | undefined;

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#onData(chunk));
    socket.on('error', (error: Error) => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('the server closed the connection')));
  }

  get socket(): net.Socket {
    return this.#socket;
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;

    // Tolerate a bare LF. It is not legal SMTP, but a server that sends it is
    // otherwise perfectly usable and refusing to parse it helps nobody.
    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(index + 1);
      this.#onLine(line);
      index = this.#buffer.indexOf('\n');
    }
  }

  #onLine(line: string): void {
    this.#lines.push(line);

    // `250-text` continues; `250 text` ends. A line too short to carry a code
    // cannot end a reply.
    if (line.length < 4 || line[3] === '-') return;

    const code = Number.parseInt(line.slice(0, 3), 10);
    const reply: Reply = {
      code: Number.isNaN(code) ? 0 : code,
      lines: this.#lines.map((entry) => entry.slice(4)),
    };
    this.#lines = [];

    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter.resolve(reply);
    } else {
      this.#ready.push(reply);
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;

    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter.reject(error);
    }
  }

  /** The next complete reply, or a rejection if the socket died first. */
  read(): Promise<Reply> {
    const buffered = this.#ready.shift();
    if (buffered) return Promise.resolve(buffered);
    if (this.#failure) return Promise.reject(this.#failure);

    return new Promise<Reply>((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  write(payload: string): void {
    this.#socket.write(payload);
  }

  /**
   * Sends a command and returns the reply, failing on an unexpected code.
   *
   * The server's own text is carried through verbatim. It is nearly always the
   * most useful thing on screen — "5.7.8 Username and Password not accepted"
   * tells a customer exactly what to fix in a way "auth failed" does not.
   */
  async command(stage: string, line: string, expected: readonly number[]): Promise<Reply> {
    this.write(`${line}\r\n`);
    const reply = await this.read();

    if (!expected.includes(reply.code)) {
      throw new SmtpError(stage, reply.code, reply.lines.join(' ').trim() || `unexpected reply`);
    }

    return reply;
  }

  /**
   * Releases the socket so it can be wrapped in TLS.
   *
   * The listeners must come off first: `tls.connect({ socket })` takes over the
   * stream, and a stale `data` handler here would eat the encrypted bytes
   * before TLS ever saw them.
   */
  detach(): net.Socket {
    this.#socket.removeAllListeners('data');
    this.#socket.removeAllListeners('error');
    this.#socket.removeAllListeners('close');
    this.#socket.setEncoding('binary');
    return this.#socket;
  }

  close(): void {
    try {
      this.#socket.destroy();
    } catch {
      // Already gone. Nothing to do and nothing worth reporting.
    }
  }
}

function connectPlain(config: SmtpConfig, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: config.host, port: config.port });
    const done = finisher(socket, resolve, reject, timeoutMs);
    socket.once('connect', () => done.ok(socket));
    socket.once('error', done.fail);
  });
}

function connectTls(
  config: SmtpConfig,
  timeoutMs: number,
  existing?: net.Socket,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      ...(existing ? { socket: existing } : { host: config.host, port: config.port }),
      servername: config.host,
      rejectUnauthorized: config.allowInvalidCertificate !== true,
    });
    const done = finisher(socket, resolve, reject, timeoutMs);
    socket.once('secureConnect', () => done.ok(socket));
    socket.once('error', done.fail);
  });
}

/**
 * Resolves or rejects exactly once, and gives up after `timeoutMs`.
 *
 * A firewalled SMTP port does not refuse the connection, it swallows it. The
 * timeout is what turns "the settings page hangs forever" into "we could not
 * reach mail.example.com:587".
 */
function finisher<T>(
  socket: net.Socket,
  resolve: (value: T) => void,
  reject: (error: Error) => void,
  timeoutMs: number,
): { ok: (value: T) => void; fail: (error: Error) => void } {
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    socket.destroy();
    reject(new SmtpError('connect', 0, `timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  // Node keeps the process alive for a pending timer; a background worker tick
  // should not be held open by one.
  timer.unref?.();

  return {
    ok(value: T) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    },
    fail(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    },
  };
}

/** The capability names a server advertised in its EHLO reply, upper-cased. */
function capabilities(reply: Reply): Set<string> {
  const found = new Set<string>();
  // The first line is the greeting text, not a capability.
  for (const line of reply.lines.slice(1)) {
    const name = line.trim().split(/\s+/)[0];
    if (name) found.add(name.toUpperCase());
  }
  return found;
}

/** True when the EHLO reply advertises this AUTH mechanism. */
function offersAuth(reply: Reply, mechanism: string): boolean {
  return reply.lines.some(
    (line) =>
      /^AUTH\b/i.test(line.trim()) &&
      line.toUpperCase().split(/\s+/).includes(mechanism.toUpperCase()),
  );
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/**
 * The name this client gives for itself in EHLO.
 *
 * Derived from the sender's domain rather than the machine's hostname, which in
 * a container is a random hex string that some servers reject outright.
 */
function clientName(from: string): string {
  const domain = from.split('@')[1]?.trim();
  return domain && /^[a-z0-9.-]+$/i.test(domain) ? domain : 'localhost';
}

interface Session {
  readonly conversation: Conversation;
  readonly greeting: Reply;
  readonly authenticated: boolean;
  readonly encrypted: boolean;
}

/**
 * Opens a connection, upgrades it, and authenticates.
 *
 * Shared by sending and verifying so that "the test passed" means precisely
 * "a real send would get this far" — a verification path that does its own
 * simplified handshake is a verification path that can pass while sending
 * fails.
 */
async function openSession(config: SmtpConfig): Promise<Session> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ehloName = clientName(config.from);

  let encrypted = config.secure;
  const socket: net.Socket = config.secure
    ? await connectTls(config, timeoutMs)
    : await connectPlain(config, timeoutMs);

  let conversation = new Conversation(socket);

  // Every exit from here on closes the socket.
  //
  // Without this, an authentication failure — by far the most common outcome
  // while someone is still typing their password into the settings form —
  // leaves the connection open on both ends. The server holds it until its own
  // idle timeout, and enough retries in a row exhaust its connection limit,
  // which turns a wrong password into an outage on the customer's mail server.
  try {
    const greeting = await conversation.read();
    if (greeting.code !== 220) {
      throw new SmtpError('greeting', greeting.code, greeting.lines.join(' ').trim());
    }

    let ehlo = await conversation.command('ehlo', `EHLO ${ehloName}`, [250]);

    // ----------------------------------------------------------- STARTTLS
    if (!encrypted && capabilities(ehlo).has('STARTTLS')) {
      await conversation.command('starttls', 'STARTTLS', [220]);

      const raw = conversation.detach();
      const secured = await connectTls(config, timeoutMs, raw);
      conversation = new Conversation(secured);
      encrypted = true;

      // A second EHLO is required, not optional: capabilities advertised
      // before the upgrade are discarded, and most servers only offer AUTH
      // afterwards.
      ehlo = await conversation.command('ehlo', `EHLO ${ehloName}`, [250]);
    }

    // ---------------------------------------------------------------- auth
    const wantsAuth = Boolean(config.username && config.password);

    if (wantsAuth && !encrypted && config.allowInsecureAuth !== true) {
      throw new SmtpError(
        'starttls',
        0,
        'this server offers no encryption, so the password was not sent. ' +
          'Use port 465, or a server that supports STARTTLS.',
      );
    }

    if (wantsAuth) {
      const username = config.username ?? '';
      const password = config.password ?? '';

      // PLAIN first: one round trip instead of three, and universally
      // supported where it is offered at all. LOGIN is the fallback for the
      // servers — Office 365 among them — that advertise only it.
      if (offersAuth(ehlo, 'PLAIN')) {
        await conversation.command(
          'auth',
          `AUTH PLAIN ${b64(`\0${username}\0${password}`)}`,
          [235],
        );
      } else if (offersAuth(ehlo, 'LOGIN') || !capabilities(ehlo).has('AUTH')) {
        await conversation.command('auth', 'AUTH LOGIN', [334]);
        await conversation.command('auth', b64(username), [334]);
        await conversation.command('auth', b64(password), [235]);
      } else {
        throw new SmtpError(
          'auth',
          0,
          'this server supports no authentication method this client can use',
        );
      }
    }

    return { conversation, greeting, authenticated: wantsAuth, encrypted };
  } catch (error) {
    conversation.close();
    throw error;
  }
}

export interface VerifyResult {
  readonly ok: boolean;
  /** Why it failed, phrased for the person filling in the form. */
  readonly error?: string;
  /** True once the connection was encrypted. False only for a plaintext relay. */
  readonly encrypted?: boolean;
  /** True when credentials were supplied and the server accepted them. */
  readonly authenticated?: boolean;
  /** The server's greeting banner, which usually names the software. */
  readonly greeting?: string;
}

/**
 * Proves the configuration works, without sending anything.
 *
 * Everything a real send does except `MAIL FROM` onwards, so a pass means the
 * host resolves, the port is open, TLS negotiates and the credentials are
 * accepted. It cannot prove the server will accept mail *for a given
 * recipient*, which is why the settings flow follows this with a test message
 * to the owner's own address.
 */
export async function verifySmtp(config: SmtpConfig): Promise<VerifyResult> {
  let session: Session | undefined;

  try {
    session = await openSession(config);

    // Politeness, and it also proves the session is still healthy rather than
    // half-closed by an idle timer partway through the handshake.
    await session.conversation.command('quit', 'QUIT', [221]).catch(() => undefined);

    return {
      ok: true,
      encrypted: session.encrypted,
      authenticated: session.authenticated,
      greeting: session.greeting.lines[0]?.trim() ?? '',
    };
  } catch (error) {
    return { ok: false, error: describe(error) };
  } finally {
    session?.conversation.close();
  }
}

/**
 * Turns a failure into a sentence a customer can act on.
 *
 * The raw errors here are unusually opaque — `ECONNREFUSED`, `535 5.7.8`,
 * `ERR_TLS_CERT_ALTNAME_INVALID` — and this is a form people fill in by hand
 * from a hosting provider's documentation, so the difference between a wrong
 * port and a wrong password has to survive all the way to the screen.
 */
function describe(error: unknown): string {
  if (error instanceof SmtpError) {
    if (error.code === 535 || error.code === 534 || error.code === 454) {
      return `the server rejected the credentials: ${error.message}`;
    }
    if (error.stage === 'connect') {
      return `could not reach the server: ${error.message}`;
    }
    return error.message;
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | undefined)?.code;

  switch (code) {
    case 'ECONNREFUSED':
      return 'the server refused the connection — check the host and port';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'that hostname does not resolve — check the server address';
    case 'ETIMEDOUT':
      return 'the connection timed out — the port is probably blocked';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return "the server's certificate is for a different hostname";
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'the server uses a self-signed certificate';
    default:
      return message;
  }
}

// ------------------------------------------------------------------ message

/** RFC 2047 encoding, applied only where a header actually needs it. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function address(email: string, name?: string): string {
  return name ? `${encodeHeader(name)} <${email}>` : email;
}

/**
 * RFC 5322 date.
 *
 * `toUTCString()` ends in `GMT`, which is obsolete syntax that a strict
 * receiver may score against. `+0000` is the current form and costs one
 * substitution.
 */
function rfc5322Date(at: Date): string {
  return at.toUTCString().replace(/GMT$/, '+0000');
}

function messageId(from: string): string {
  const domain = from.split('@')[1] ?? 'localhost';
  return `<${randomBytes(16).toString('hex')}@${domain}>`;
}

/** Base64 body, wrapped at 76 characters as the transfer encoding requires. */
function base64Body(text: string): string {
  return (
    Buffer.from(text, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? ['']
  ).join('\r\n');
}

/**
 * Builds the RFC 5322 message.
 *
 * The body is base64 rather than 8bit or quoted-printable, which sidesteps
 * three separate classes of corruption at once: lines over 998 octets, a lone
 * `.` at the start of a line being read as end-of-data, and any question about
 * what a bare LF in the draft means. A drafted outreach message is user text
 * that has been nowhere near a mail-safety pass, so paying a third in size for
 * a body that cannot be mangled is the right trade.
 */
export function buildMessage(config: SmtpConfig, message: Message, at: Date = new Date()): string {
  const boundary = `--=_${randomBytes(12).toString('hex')}`;
  const headers: string[] = [
    `From: ${address(config.from, config.fromName)}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${rfc5322Date(at)}`,
    `Message-ID: ${messageId(config.from)}`,
    'MIME-Version: 1.0',
  ];

  if (message.replyTo) headers.push(`Reply-To: ${message.replyTo}`);

  if (!message.html) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
    return `${headers.join('\r\n')}\r\n\r\n${base64Body(message.text)}\r\n`;
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(message.html),
    `--${boundary}--`,
  ];

  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n`;
}

/**
 * Escapes a message body for the DATA command.
 *
 * A line consisting of a single `.` terminates DATA, so any line *starting*
 * with one gets an extra. Base64 bodies never produce such a line, but headers
 * are not base64 and this costs nothing to be right about.
 */
function dotStuff(payload: string): string {
  return payload.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');
}

/** The provider id, when the server put one in its 250 reply. */
function extractQueueId(reply: Reply): string | undefined {
  const text = reply.lines.join(' ');
  const match = /\b(?:queued as|id=|2\.0\.0 OK)\s*([A-Za-z0-9._-]{6,})/i.exec(text);
  return match?.[1];
}

/**
 * Sends through the workspace's own SMTP server.
 *
 * One connection per message. Pooling would be worth it at volume, but the
 * daily cap is measured in tens and a pooled connection that goes stale between
 * ticks fails in a way that is much harder to explain than reconnecting.
 */
export class SmtpMailer implements Mailer {
  readonly #config: SmtpConfig;

  constructor(config: SmtpConfig) {
    this.#config = config;
  }

  get from(): string {
    return this.#config.from;
  }

  async send(message: Message): Promise<SendResult> {
    let session: Session | undefined;

    try {
      session = await openSession(this.#config);
      const { conversation } = session;

      await conversation.command('mail', `MAIL FROM:<${this.#config.from}>`, [250]);
      await conversation.command('rcpt', `RCPT TO:<${message.to}>`, [250, 251]);
      await conversation.command('data', 'DATA', [354]);

      conversation.write(`${dotStuff(buildMessage(this.#config, message))}\r\n.\r\n`);

      const accepted = await conversation.read();
      if (accepted.code !== 250) {
        throw new SmtpError('data', accepted.code, accepted.lines.join(' ').trim());
      }

      await conversation.command('quit', 'QUIT', [221]).catch(() => undefined);

      const id = extractQueueId(accepted);
      return id ? { id } : {};
    } catch (error) {
      // Rethrown as the shared MailerError so callers — autopilot's retry
      // accounting above all — do not have to know which transport failed.
      const status = error instanceof SmtpError ? error.code : 0;
      throw new MailerError(status, describe(error));
    } finally {
      session?.conversation.close();
    }
  }
}
