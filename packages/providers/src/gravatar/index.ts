/**
 * Gravatar: the one free route from an address to the rest of someone.
 *
 * It works because the person opted into it. A Gravatar profile is public by
 * construction — its whole purpose is to be looked up by the hash of an email
 * so that forums and commit logs can show an avatar — and the linked accounts
 * on it are ones the owner chose to publish. That is a materially different
 * act from scraping a profile, and it is why this is the enrichment route to
 * reach for before any that involves guessing.
 *
 * What it gives, on a developer audience, is often exactly the thing missing:
 * a GitHub handle, a Mastodon account, a personal site. What it does not give
 * is LinkedIn coverage or phone numbers — those have no free route, and
 * pretending otherwise by scraping would trade a real legal position for a
 * worse one.
 *
 * Hit rate is meaningful but nowhere near total. A miss is 404 and is a normal
 * answer, not an error.
 */

export interface GravatarAccount {
  /** `github`, `mastodon`, `x`, `linkedin`, … as Gravatar names it. */
  readonly service: string;
  readonly url: string;
  readonly handle?: string;
}

export interface GravatarProfile {
  readonly hash: string;
  readonly displayName?: string;
  readonly fullName?: string;
  readonly location?: string;
  readonly job?: string;
  readonly company?: string;
  readonly profileUrl?: string;
  readonly avatarUrl?: string;
  readonly accounts: readonly GravatarAccount[];
  /** Personal sites the owner listed. */
  readonly urls: readonly string[];
}

/**
 * Gravatar's lookup key.
 *
 * MD5 of the trimmed, lowercased address. MD5 is not a security choice here
 * and its weakness is irrelevant — it is the index Gravatar has used since
 * 2007 and the only one the free `.json` endpoint accepts. Using anything else
 * looks up nothing.
 */
export function gravatarHash(email: string): string {
  return md5(new TextEncoder().encode(email.trim().toLowerCase()));
}

const DEFAULT_BASE = 'https://gravatar.com';

export interface GravatarOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Looks one address up.
 *
 * Returns `undefined` for "no profile", which is the majority answer and must
 * be cheap to handle. Network failures also return `undefined` rather than
 * throwing: this runs seventeen thousand times in a queue, and one flaky
 * response should cost that person's enrichment, not the run.
 */
export async function lookupGravatar(
  email: string,
  options: GravatarOptions = {},
): Promise<GravatarProfile | undefined> {
  const hash = gravatarHash(email);
  const base = options.baseUrl ?? DEFAULT_BASE;
  const doFetch = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);

  try {
    const response = await doFetch(`${base}/${hash}.json`, {
      headers: {
        // Gravatar rate-limits anonymous clients harder and asks that callers
        // identify themselves. An honest agent is also how we stay unblocked.
        'user-agent': 'OutreachGraph (+https://outreachgraph.com)',
        accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) return undefined;

    const body = (await response.json()) as {
      entry?: {
        hash?: string;
        displayName?: string;
        preferredUsername?: string;
        name?: { formatted?: string };
        currentLocation?: string;
        job_title?: string;
        company?: string;
        profileUrl?: string;
        thumbnailUrl?: string;
        accounts?: { shortname?: string; url?: string; username?: string }[];
        urls?: { value?: string }[];
      }[];
    };

    const entry = body.entry?.[0];
    if (!entry) return undefined;

    const accounts: GravatarAccount[] = (entry.accounts ?? [])
      .filter((account) => account.shortname && account.url)
      .map((account) => ({
        service: String(account.shortname).toLowerCase(),
        url: String(account.url),
        ...(account.username ? { handle: String(account.username) } : {}),
      }));

    return {
      hash,
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      ...(entry.name?.formatted ? { fullName: entry.name.formatted } : {}),
      ...(entry.currentLocation ? { location: entry.currentLocation } : {}),
      ...(entry.job_title ? { job: entry.job_title } : {}),
      ...(entry.company ? { company: entry.company } : {}),
      ...(entry.profileUrl ? { profileUrl: entry.profileUrl } : {}),
      ...(entry.thumbnailUrl ? { avatarUrl: entry.thumbnailUrl } : {}),
      accounts,
      urls: (entry.urls ?? []).map((url) => String(url.value ?? '')).filter(Boolean),
    };
  } catch {
    // Aborted, offline, or malformed JSON. All the same answer here.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which Gravatar services map onto networks this product understands.
 *
 * Anything absent is still worth storing as evidence but is not a channel we
 * can act on, so it does not become a `social_identities` row claiming we can
 * reach someone there.
 */
export const GRAVATAR_NETWORKS: Readonly<Record<string, string>> = {
  github: 'github',
  x: 'x',
  twitter: 'x',
  mastodon: 'mastodon',
  bluesky: 'bluesky',
  linkedin: 'linkedin',
};

// ---------------------------------------------------------------------- md5
//
// Implemented here because `crypto.subtle` deliberately does not offer MD5 and
// there is no other way to produce Gravatar's index. Vendoring twenty lines
// beats a dependency for one hash.

function md5(bytes: Uint8Array): string {
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  const K = new Int32Array(64);
  for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const length = bytes.length;
  const withPadding = new Uint8Array((((length + 8) >> 6) + 1) * 64);
  withPadding.set(bytes);
  withPadding[length] = 0x80;

  const bitLength = length * 8;
  const view = new DataView(withPadding.buffer);
  view.setUint32(withPadding.length - 8, bitLength >>> 0, true);
  view.setUint32(withPadding.length - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let chunk = 0; chunk < withPadding.length; chunk += 64) {
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i += 1) M[i] = view.getInt32(chunk + i * 4, true);

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i += 1) {
      let F: number;
      let g: number;

      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }

      F = (F + A + (K[i] ?? 0) + (M[g] ?? 0)) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << (s[i] ?? 0)) | (F >>> (32 - (s[i] ?? 0))))) | 0;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  return [a0, b0, c0, d0].map(toLittleEndianHex).join('');
}

function toLittleEndianHex(value: number): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    out += ((value >> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}
