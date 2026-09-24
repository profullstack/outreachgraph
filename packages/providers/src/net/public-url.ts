/**
 * Refusing to make requests on a stranger's behalf into our own network.
 *
 * A webhook URL is the first thing in this product that a customer types and
 * our server then fetches, unprompted, from inside the deployment. Anything on
 * the far side of that request is reachable by whoever controls the URL:
 * `http://169.254.169.254/` is the cloud metadata service and its credentials,
 * `http://127.0.0.1:8080/` is our own API without the proxy in front of it,
 * and `http://10.0.0.5:5432/` is somebody's database. That is server-side
 * request forgery, and the guard for it has to be in the code path that makes
 * the request, not in the form that collects the URL.
 *
 * Checking the hostname's spelling is not enough, which is why this resolves
 * it. `evil.example` can have an A record of `127.0.0.1`, and a check that
 * only reads the text would wave it through. So every address the name
 * resolves to must be public, not just the first one — a resolver that
 * returns a public and a private answer is how the first answer gets tested
 * and the second one gets used.
 *
 * What this does not close, stated so nobody believes otherwise: a name that
 * resolves to a public address here and a private one a moment later, when
 * `fetch` resolves it again (DNS rebinding). Pinning the address would close
 * it and would also break TLS, whose certificate is for the name. The residual
 * window is one TTL wide, redirects are never followed (so a public endpoint
 * cannot bounce us inward), and a response body is never shown to the caller
 * beyond a short excerpt in the delivery log.
 *
 * The crawler predates this and has only the lexical check in `photo.ts`;
 * moving it onto this guard is worth doing separately.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeUrlError extends Error {
  readonly reason:
    'invalid' | 'scheme' | 'credentials' | 'private_host' | 'private_address' | 'unresolvable';

  constructor(reason: UnsafeUrlError['reason'], message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
    this.reason = reason;
  }
}

/** Resolves a hostname to every address it has. Injected by tests. */
export type HostLookup = (hostname: string) => Promise<readonly string[]>;

export const systemLookup: HostLookup = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

export interface PublicUrlOptions {
  /**
   * Accept `http:`. For tests and local development only: a webhook that
   * carries a signed payload in cleartext hands the payload to every hop.
   */
  readonly allowHttp?: boolean;
  /** Accept private and loopback addresses. Tests only. */
  readonly allowPrivate?: boolean;
  readonly lookup?: HostLookup;
}

function ipv4Octets(address: string): number[] | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : undefined;
}

function privateIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  // Not a dotted quad at all is not an address we can vouch for.
  if (!octets) return true;
  const [a, b] = octets as [number, number, number, number];

  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, and the metadata service
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && octets[2] === 0) || // IETF protocol assignments
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands `::`-compressed IPv6 into eight 16-bit groups. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  // A trailing dotted quad (`::ffff:1.2.3.4`) becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = ipv4Octets(dotted[1] as string);
    if (!octets) return undefined;
    const [a, b, c, d] = octets as [number, number, number, number];
    text =
      text.slice(0, dotted.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return undefined;

  const parse = (part: string): number[] =>
    part ? part.split(':').map((group) => parseInt(group, 16)) : [];
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;

  const groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

function privateIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const [g0, , , , , g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  const allZeroUpTo = (n: number) => groups.slice(0, n).every((g) => g === 0);

  // :: and ::1
  if (allZeroUpTo(7) && (g7 === 0 || g7 === 1)) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the IPv4 inside,
  // because that is where the packet actually goes.
  if (allZeroUpTo(5) && (g5 === 0xffff || g5 === 0)) {
    return privateIpv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  // NAT64 (64:ff9b::/96) embeds an IPv4 address the same way.
  if (g0 === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return privateIpv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && groups[1] === 0x0db8) return true; // documentation

  return false;
}

/**
 * True for any address a customer-supplied URL must not reach.
 *
 * Fails closed: a string that is not a recognisable address is treated as
 * private, because the alternative is trusting input we could not parse.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address.replace(/^\[|\]$/g, '').split('%')[0] ?? '');
  if (version === 4) return privateIpv4(address);
  if (version === 6) return privateIpv6(address);
  return true;
}

/**
 * Parses `raw` and checks that it is safe to request from inside the
 * deployment. Returns the parsed URL, or throws `UnsafeUrlError`.
 */
export async function assertPublicUrl(raw: string, options: PublicUrlOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError('invalid', 'that is not a URL');
  }

  const allowed = options.allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(url.protocol)) {
    throw new UnsafeUrlError('scheme', 'the URL must start with https://');
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError('credentials', 'the URL must not carry a username or password');
  }

  if (options.allowPrivate) return url;

  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');

  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new UnsafeUrlError('private_address', 'the URL points at a private address');
    }
    return url;
  }

  // Names that only mean something inside a network. Refused before DNS so
  // the answer does not depend on how this container's resolver is set up.
  if (
    !host.includes('.') ||
    /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host)
  ) {
    throw new UnsafeUrlError('private_host', 'the URL points at a private host name');
  }

  let addresses: readonly string[];
  try {
    addresses = await (options.lookup ?? systemLookup)(host);
  } catch {
    throw new UnsafeUrlError('unresolvable', `${host} does not resolve`);
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError('unresolvable', `${host} does not resolve`);
  }

  if (addresses.some(isPrivateAddress)) {
    throw new UnsafeUrlError('private_address', `${host} resolves to a private address`);
  }

  return url;
}
