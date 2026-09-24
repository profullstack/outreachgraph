/**
 * LinkedIn through the customer's own logged-in session.
 *
 * LinkedIn's official API cannot comment on another member's post: the
 * Community Management API writes only to posts the token's own member or
 * organisation authored, and it is partner-gated. So there is no OAuth path
 * to this capability at all, and the only way to automate it is the one the
 * LinkedIn web app itself uses: the internal Voyager API, authenticated by the
 * member's `li_at` session cookie.
 *
 * That is against LinkedIn's User Agreement (section 8.2), and the workspace
 * owner opted into it knowingly on 2026-09-24. The risk is theirs and it is
 * concrete: LinkedIn restricts accounts that act faster or more regularly than
 * a person. The pacing in `outreach-linkedin.ts` exists for that reason and is
 * not a performance knob.
 *
 * Voyager is undocumented and changes without notice. Every failure here is
 * reported as a reason on the card, which falls back to a hand-off, rather
 * than retried blindly.
 */

import { randomInt } from 'node:crypto';
import type { FetchLike } from '../site/fetch';

const VOYAGER = 'https://www.linkedin.com/voyager/api';

/** What the web app sends; Voyager refuses requests that look like a script. */
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export class LinkedInSessionError extends Error {
  constructor(message = 'linkedin rejected the session cookie') {
    super(message);
    this.name = 'LinkedInSessionError';
  }
}

export class LinkedInWriteError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LinkedInWriteError';
    this.status = status;
  }
}

export interface LinkedInMember {
  readonly publicIdentifier: string;
  readonly entityUrn: string;
  readonly name: string;
}

/**
 * The thread a comment belongs to, from any of the URL shapes LinkedIn uses:
 * `/feed/update/urn:li:activity:123/`, `/posts/name_slug-activity-123-abcd`,
 * or a bare `urn:li:ugcPost:123`.
 */
export function threadUrnFromUrl(url: string): string | undefined {
  const urn = /urn:li:(activity|ugcPost|share):(\d+)/.exec(decodeURIComponent(url));
  if (urn) return `urn:li:${urn[1]}:${urn[2]}`;
  const slug = /[-_](activity|ugcPost|share)[-_](\d{15,})/.exec(url);
  if (slug) return `urn:li:${slug[1]}:${slug[2]}`;
  return undefined;
}

export interface LinkedInSessionOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export class LinkedInSession {
  readonly #liAt: string;
  readonly #csrf: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(liAt: string, options: LinkedInSessionOptions = {}) {
    this.#liAt = liAt.trim().replace(/^li_at=/, '');
    // Voyager's CSRF check is double-submit: the `csrf-token` header must
    // equal the JSESSIONID cookie. Any `ajax:` value we mint satisfies it.
    this.#csrf = `ajax:${String(randomInt(1e9, 1e10))}${String(randomInt(1e9, 1e10))}`;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** Who the cookie belongs to. Doubles as the credential check. */
  async me(): Promise<LinkedInMember> {
    const body = (await this.#request('GET', '/me')) as {
      miniProfile?: {
        publicIdentifier?: string;
        entityUrn?: string;
        firstName?: string;
        lastName?: string;
      };
    };
    const mini = body.miniProfile;
    if (!mini?.publicIdentifier || !mini.entityUrn) {
      throw new LinkedInSessionError('linkedin returned no member for the session');
    }
    return {
      publicIdentifier: mini.publicIdentifier,
      entityUrn: mini.entityUrn,
      name: [mini.firstName, mini.lastName].filter(Boolean).join(' '),
    };
  }

  /** Comments on a post. Returns the comment URN when LinkedIn gives one back. */
  async comment(threadUrn: string, text: string): Promise<{ urn?: string }> {
    const body = (await this.#request(
      'POST',
      '/voyagerSocialDashNormComments?decorationId=com.linkedin.voyager.dash.deco.social.NormComment-43',
      {
        commentary: {
          text,
          attributesV2: [],
          $type: 'com.linkedin.voyager.dash.common.text.TextViewModel',
        },
        threadUrn,
      },
    )) as { data?: { entityUrn?: string }; value?: { entityUrn?: string } } | undefined;
    const urn = body?.data?.entityUrn ?? body?.value?.entityUrn;
    return urn ? { urn } : {};
  }

  async #request(method: 'GET' | 'POST', path: string, json?: unknown): Promise<unknown> {
    const response = await this.#fetch(`${VOYAGER}${path}`, {
      method,
      headers: {
        cookie: `li_at=${this.#liAt}; JSESSIONID="${this.#csrf}"`,
        'csrf-token': this.#csrf,
        'x-restli-protocol-version': '2.0.0',
        'x-li-lang': 'en_US',
        accept: 'application/vnd.linkedin.normalized+json+2.1',
        'user-agent': USER_AGENT,
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    // An expired cookie is a redirect to the login page, not a 401.
    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new LinkedInSessionError(
        `linkedin ${response.status}: the session cookie is expired or was signed out`,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new LinkedInWriteError(
        `linkedin ${response.status}: ${text.slice(0, 200)}`,
        response.status,
      );
    }

    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  }
}
