/**
 * Can this address's domain receive mail at all?
 *
 * An invitation to `someone@profullstack.co` — one letter short of the real
 * domain — was accepted by the mail provider, reported as sent, and went
 * nowhere: the domain has no mail server and is not even registered. Nothing
 * in the product could tell the person who sent it. Checking the domain before
 * minting the invitation turns that into a form error with the likely fix.
 *
 * Fails open. A resolver timeout or a SERVFAIL says nothing about the domain,
 * and refusing a real colleague's invite because DNS hiccuped would be worse
 * than the typo this exists to catch. Only "this name has no mail route" —
 * no MX and no address record, the fallback mail servers use — refuses.
 */

import { promises as dns } from 'node:dns';

export interface MailResolver {
  resolveMx(domain: string): Promise<readonly unknown[]>;
  resolve4(domain: string): Promise<readonly unknown[]>;
}

const NO_SUCH = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

type Answer = 'yes' | 'no' | 'unknown';

async function has(lookup: () => Promise<readonly unknown[]>): Promise<Answer> {
  try {
    return (await lookup()).length > 0 ? 'yes' : 'no';
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code && NO_SUCH.has(code) ? 'no' : 'unknown';
  }
}

async function receives(resolver: MailResolver, domain: string): Promise<Answer> {
  const mx = await has(() => resolver.resolveMx(domain));
  if (mx !== 'no') return mx;
  // No MX: mail falls back to the domain's own address, per RFC 5321 §5.1.
  return has(() => resolver.resolve4(domain));
}

/** Near misses worth offering, most likely first. */
function alternatives(domain: string): string[] {
  const out: string[] = [];
  if (domain.endsWith('.co')) out.push(`${domain}m`);
  if (domain.endsWith('.cm') || domain.endsWith('.om'))
    out.push(domain.replace(/\.c?om?$/, '.com'));
  if (domain.endsWith('.con')) out.push(domain.replace(/\.con$/, '.com'));
  return out.filter((candidate) => candidate !== domain);
}

export type MailDomainCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly domain: string; readonly suggestion?: string };

export async function checkMailDomain(
  email: string,
  resolver: MailResolver = dns,
): Promise<MailDomainCheck> {
  const domain = email.split('@').pop()?.trim().toLowerCase() ?? '';
  if (!domain.includes('.')) return { ok: true };

  if ((await receives(resolver, domain)) !== 'no') return { ok: true };

  for (const candidate of alternatives(domain)) {
    if ((await receives(resolver, candidate)) === 'yes') {
      return { ok: false, domain, suggestion: email.replace(/@[^@]+$/, `@${candidate}`) };
    }
  }
  return { ok: false, domain };
}
