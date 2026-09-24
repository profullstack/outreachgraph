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
 * The same is true of the rest of what a member does by hand — inviting,
 * visiting a profile, following, messaging a connection. The official API
 * offers none of them to a third party, so they go the same way, under the
 * same opt-in, and are paced harder (see `social-delivery.ts`): LinkedIn
 * watches invitation volume in particular, and caps it weekly.
 *
 * Voyager is undocumented and changes without notice. Every failure here is
 * reported as a reason on the card, which falls back to a hand-off, rather
 * than retried blindly.
 */

import { randomInt, randomUUID } from 'node:crypto';
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

/**
 * LinkedIn's limit on an invitation note.
 *
 * 300 is what the Connect dialog enforces for Premium members. Free accounts
 * have been capped at 200 characters, and at a handful of personalised
 * invitations a month, since 2023; LinkedIn refuses the over-long or
 * over-quota note itself, and that refusal comes back as the card's reason.
 * Enforced here as well so a note that can only fail is never sent.
 */
export const INVITATION_NOTE_LIMIT = 300;

/** LinkedIn's limit on one direct message. */
export const MESSAGE_LIMIT = 8000;

/** Where a person stands with the member whose session this is. */
export type LinkedInConnectionStatus = 'connected' | 'pending' | 'none';

export interface LinkedInProfile {
  /** `urn:li:fsd_profile:ACoAA…`, what every write addresses. */
  readonly profileUrn: string;
  readonly publicIdentifier?: string;
  readonly status: LinkedInConnectionStatus;
}

/**
 * The member identity to look a profile up by, from whatever we stored.
 *
 * `social_identities` holds LinkedIn people three ways: a profile URL from a
 * crawl or a search result, a bare vanity name, or an `fsd_profile` URN from a
 * provider. All three reduce to the one string Voyager's `memberIdentity`
 * query takes. A company page is not a person and returns undefined.
 */
export function memberIdentityFrom(ref: string): string | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;

  const urn = /urn:li:(?:fsd_profile|fs_miniProfile|fs_profile):([A-Za-z0-9_-]+)/.exec(trimmed);
  if (urn) return urn[1];

  if (/^https?:\/\//i.test(trimmed) || /linkedin\.com\//i.test(trimmed)) {
    try {
      const url = new URL(/^https?:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
      const [kind, id] = url.pathname.split('/').filter(Boolean);
      if (kind !== 'in' || !id) return undefined;
      return decodeURIComponent(id);
    } catch {
      return undefined;
    }
  }

  return /^[A-Za-z0-9_%.-]{2,100}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The entity to follow: a person's `fsd_profile` or a company's `fsd_company`.
 *
 * A company is accepted as its URN or as a `/company/<numeric id>/` URL. A
 * company *vanity* URL (`/company/acme/`) needs a lookup this module does not
 * make, and is refused rather than guessed.
 */
export function followTargetFrom(
  ref: string,
): { kind: 'company'; urn: string } | { kind: 'profile'; identity: string } | undefined {
  const trimmed = ref.trim();
  const company = /urn:li:(?:fsd_company|fs_normalized_company|company|organization):(\d+)/.exec(
    trimmed,
  );
  if (company) return { kind: 'company', urn: `urn:li:fsd_company:${company[1]}` };
  const companyUrl = /linkedin\.com\/company\/(\d+)(?:[/?#]|$)/i.exec(trimmed);
  if (companyUrl) return { kind: 'company', urn: `urn:li:fsd_company:${companyUrl[1]}` };
  if (/linkedin\.com\/company\//i.test(trimmed)) return undefined;

  const identity = memberIdentityFrom(trimmed);
  return identity ? { kind: 'profile', identity } : undefined;
}

/**
 * Reads the connection state out of a top-card response.
 *
 * The profile read answers `{ data, included }`: `data['*elements']` names the
 * subject, and `included` carries a `MemberRelationship` for it — and also a
 * `Profile` for *us*, as the potential inviter, which is why the subject is
 * picked by URN rather than by position. The union has three branches:
 *
 *   connection                                  -> connected
 *   noConnection.invitationUnion.noInvitation   -> none
 *   noConnection.invitationUnion.invitation     -> pending
 *
 * The first two shapes were captured from the web client in September 2026
 * (OpenRecruiterTools/linkedin-toolkit, fixture `profileView.json`). The
 * `invitation` branch is UNVERIFIED: it is the sibling the union implies, but
 * it has not been watched on a live pending invite. `memberDistance:
 * DISTANCE_1` is also read as connected, as a fallback.
 */
export function relationshipFromTopCard(body: unknown): LinkedInProfile | undefined {
  const root = (body ?? {}) as {
    data?: { '*elements'?: string[] };
    included?: Record<string, unknown>[];
  };
  const included = Array.isArray(root.included) ? root.included : [];
  const subjectUrn = root.data?.['*elements']?.find((urn) => urn.startsWith('urn:li:fsd_profile:'));
  const subject = subjectUrn ? included.find((e) => e.entityUrn === subjectUrn) : undefined;
  if (!subjectUrn) return undefined;

  const profileId = subjectUrn.slice('urn:li:fsd_profile:'.length);
  const relationship = included.find(
    (e) => e.entityUrn === `urn:li:fsd_memberRelationship:${profileId}`,
  );

  return {
    profileUrn: subjectUrn,
    ...(typeof subject?.publicIdentifier === 'string'
      ? { publicIdentifier: subject.publicIdentifier }
      : {}),
    status: statusOf(relationship),
  };
}

function statusOf(relationship: Record<string, unknown> | undefined): LinkedInConnectionStatus {
  if (!relationship) return 'none';
  const union = (relationship.memberRelationshipUnion ?? {}) as Record<string, unknown>;
  if (union.connection) return 'connected';

  const no = (union.noConnection ?? {}) as Record<string, unknown>;
  if (no.memberDistance === 'DISTANCE_1') return 'connected';

  const invitationUnion = (no.invitationUnion ?? {}) as Record<string, unknown>;
  const data = (relationship.memberRelationshipData ?? {}) as Record<string, unknown>;
  if (invitationUnion.invitation || data.invitation) return 'pending';
  return 'none';
}

/** `urn:li:fs_miniProfile:X` (what `/me` returns) as the `fsd_profile` URN writes use. */
function fsdProfileUrn(urn: string): string {
  const id = /:([A-Za-z0-9_-]+)$/.exec(urn)?.[1];
  return id ? `urn:li:fsd_profile:${id}` : urn;
}

/** The decoration the web client's own profile page asks for. */
const TOP_CARD = 'com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-19';
const INVITATION_RESULT =
  'com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2';

export interface LinkedInSessionOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export class LinkedInSession {
  readonly #liAt: string;
  readonly #csrf: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  #mailbox: string | undefined;

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

  /**
   * Looks one person up: their profile URN and where they stand with us.
   *
   * `GET /identity/dash/profiles?q=memberIdentity` with the top-card
   * decoration, which is what the profile page itself loads and the only read
   * that still states the relationship. A third party captured it working in
   * September 2026; it has not been watched live from here.
   *
   * LinkedIn meters it as a profile view for commercial-use limits, which is
   * one more reason every caller paces it.
   */
  async lookupProfile(profile: string): Promise<LinkedInProfile> {
    const identity = memberIdentityFrom(profile);
    if (!identity) throw new LinkedInWriteError(`not a LinkedIn profile: ${profile}`, 400);

    const query = new URLSearchParams({
      q: 'memberIdentity',
      memberIdentity: identity,
      decorationId: TOP_CARD,
    });
    const body = await this.#request('GET', `/identity/dash/profiles?${query.toString()}`);
    const found = relationshipFromTopCard(body);
    if (!found) throw new LinkedInWriteError(`linkedin has no profile for ${identity}`, 404);
    return found;
  }

  /** Where this person stands with the member: connected, invited, or neither. */
  async connectionStatus(profile: string): Promise<LinkedInConnectionStatus> {
    return (await this.lookupProfile(profile)).status;
  }

  /**
   * Visits a profile, the way opening it in the browser does.
   *
   * UNVERIFIED as a *visit*: the read is the same top-card request the profile
   * page makes, but whether it alone puts us in the member's "who viewed your
   * profile" list, or whether that also needs the page's separate tracking
   * beacon (which this deliberately does not forge), has not been observed.
   * The older `identity/profiles/{id}/profileView` endpoint answers 410.
   */
  async viewProfile(profile: string): Promise<LinkedInProfile> {
    return this.lookupProfile(profile);
  }

  /**
   * Sends a connection invitation, with an optional note.
   *
   * `POST voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2`,
   * the Connect dialog's own request. A third party captured it succeeding on
   * 2026-09-09 (success is `data.value['*invitation']`); it has not been sent
   * from here, so it is UNVERIFIED against the live client.
   *
   * A note-less invitation omits `customMessage` entirely. An empty string is
   * not the same thing to LinkedIn: it spends one of the free tier's few
   * personalised invitations.
   */
  async connect(profile: string, note?: string): Promise<{ invitationUrn?: string }> {
    const message = note?.trim() ?? '';
    if (message.length > INVITATION_NOTE_LIMIT) {
      throw new LinkedInWriteError(
        `an invitation note may be at most ${INVITATION_NOTE_LIMIT} characters (this one is ${message.length})`,
        400,
      );
    }

    const profileUrn = await this.#profileUrn(profile);
    const body = (await this.#request(
      'POST',
      `/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=${INVITATION_RESULT}`,
      {
        invitee: { inviteeUnion: { memberProfile: profileUrn } },
        ...(message ? { customMessage: message } : {}),
      },
    )) as
      { data?: { value?: Record<string, unknown>; code?: unknown; message?: unknown } } | undefined;

    const value = body?.data?.value ?? {};
    const invitationUrn = value['*invitation'] ?? value.invitationUrn;
    if (typeof invitationUrn === 'string') return { invitationUrn };

    // LinkedIn sometimes refuses with a 200 and no invitation: a duplicate, or
    // an exhausted weekly allowance. Reported, never retried.
    if (body?.data?.code !== undefined || body?.data?.message !== undefined) {
      throw new LinkedInWriteError(
        `linkedin refused the invitation: ${String(body.data.code ?? '')} ${String(body.data.message ?? '')}`.trim(),
        200,
      );
    }
    return {};
  }

  /**
   * Follows a person or a company without connecting.
   *
   * `POST /feed/dash/followingStates/<urn:li:fsd_followingState:…>` with
   * `{"patch":{"$set":{"following":true}}}`. The same request with `false` is
   * the Following manager's Unfollow button, captured working in September
   * 2026; the `true` direction is UNVERIFIED, inferred from it.
   */
  async follow(target: string): Promise<{ urn: string }> {
    const parsed = followTargetFrom(target);
    if (!parsed) throw new LinkedInWriteError(`cannot follow ${target}`, 400);
    const urn =
      parsed.kind === 'company'
        ? parsed.urn
        : (await this.lookupProfile(parsed.identity)).profileUrn;

    const state = encodeURIComponent(`urn:li:fsd_followingState:${urn}`);
    await this.#request('POST', `/feed/dash/followingStates/${state}`, {
      patch: { $set: { following: true } },
    });
    return { urn };
  }

  /**
   * Sends a direct message to a 1st-degree connection.
   *
   * `POST voyagerMessagingDashMessengerMessages?action=createMessage`,
   * addressed from our own mailbox (`/me`, as an `fsd_profile` URN) to the
   * recipient's. The body follows two independent September 2026 captures of
   * the web client; a new conversation names its recipient in
   * `hostRecipientUrns`. UNVERIFIED: no message has been sent from here.
   *
   * Only connections can be messaged without InMail credits, so the caller
   * checks `connectionStatus` first; LinkedIn would refuse anyway.
   */
  async sendMessage(profile: string, text: string): Promise<{ urn?: string }> {
    const body = text.trim();
    if (!body) throw new LinkedInWriteError('there is no message to send', 400);
    if (body.length > MESSAGE_LIMIT) {
      throw new LinkedInWriteError(`a message may be at most ${MESSAGE_LIMIT} characters`, 400);
    }

    const recipient = await this.#profileUrn(profile);
    const mailboxUrn = await this.#mailboxUrn();
    const result = (await this.#request(
      'POST',
      '/voyagerMessagingDashMessengerMessages?action=createMessage',
      {
        message: {
          body: { attributes: [], text: body },
          renderContentUnions: [],
          originToken: randomUUID(),
        },
        mailboxUrn,
        trackingId: randomUUID().replace(/-/g, '').slice(0, 16),
        dedupeByClientGeneratedToken: false,
        hostRecipientUrns: [recipient],
      },
    )) as { data?: { value?: { entityUrn?: string } } } | undefined;

    const urn = result?.data?.value?.entityUrn;
    return urn ? { urn } : {};
  }

  /** A URN passes straight through; anything else costs a profile lookup. */
  async #profileUrn(profile: string): Promise<string> {
    if (/^urn:li:fsd_profile:[A-Za-z0-9_-]+$/.test(profile.trim())) return profile.trim();
    return (await this.lookupProfile(profile)).profileUrn;
  }

  async #mailboxUrn(): Promise<string> {
    this.#mailbox ??= fsdProfileUrn((await this.me()).entityUrn);
    return this.#mailbox;
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
