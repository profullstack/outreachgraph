/**
 * The LinkedIn session's member actions, against a recorded fake.
 *
 * No request leaves the process. The response bodies are cut down from the
 * shapes captured from the web client in September 2026, with every id and
 * name replaced; they prove the parsing and the request shapes, not that
 * LinkedIn still answers this way today.
 */

import { describe, expect, test } from 'bun:test';
import {
  followTargetFrom,
  INVITATION_NOTE_LIMIT,
  LinkedInSession,
  LinkedInSessionError,
  LinkedInWriteError,
  memberIdentityFrom,
  relationshipFromTopCard,
} from './session';

const COOKIE = 'AQEDAtestcookievalue1234567890';
const THEM = 'urn:li:fsd_profile:ACoAAAtheir0000000000000000000000000000';
const US = 'ACoAAAours00000000000000000000000000000';

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body?: Record<string, unknown>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A top-card answer with the relationship branch given. */
function topCard(relationship: Record<string, unknown>): unknown {
  return {
    data: { '*elements': [THEM] },
    included: [
      {
        $type: 'com.linkedin.voyager.dash.identity.profile.Profile',
        entityUrn: THEM,
        publicIdentifier: 'jane-doe',
      },
      // Us, as the potential inviter. Must never be mistaken for the subject.
      {
        $type: 'com.linkedin.voyager.dash.identity.profile.Profile',
        entityUrn: `urn:li:fsd_profile:${US}`,
        publicIdentifier: 'sam-seller',
      },
      {
        $type: 'com.linkedin.voyager.dash.relationships.MemberRelationship',
        entityUrn: `urn:li:fsd_memberRelationship:${THEM.split(':').at(-1)}`,
        memberRelationshipUnion: relationship,
      },
    ],
  };
}

const NONE = {
  noConnection: {
    memberDistance: 'DISTANCE_2',
    invitationUnion: { noInvitation: { inviter: `urn:li:fsd_profile:${US}`, targetInvitee: THEM } },
  },
};
const PENDING = {
  noConnection: {
    memberDistance: 'DISTANCE_2',
    invitationUnion: { invitation: 'urn:li:fsd_invitation:7000000000000000001' },
  },
};
const CONNECTED = { connection: 'urn:li:fsd_connection:ACoAAAtheir' };

function session(respond: (sent: Sent) => Response): { session: LinkedInSession; sent: Sent[] } {
  const sent: Sent[] = [];
  const fake = new LinkedInSession(COOKIE, {
    fetchImpl: async (input, init) => {
      const record: Sent = {
        method: init?.method ?? 'GET',
        url: String(input),
        headers: new Headers(init?.headers),
        ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
      };
      sent.push(record);
      return respond(record);
    },
  });
  return { session: fake, sent };
}

describe('profile references', () => {
  test('every stored shape reduces to a member identity', () => {
    expect(memberIdentityFrom('https://www.linkedin.com/in/jane-doe/')).toBe('jane-doe');
    expect(memberIdentityFrom('linkedin.com/in/jane-doe?trk=x')).toBe('jane-doe');
    expect(memberIdentityFrom('jane-doe')).toBe('jane-doe');
    expect(memberIdentityFrom(THEM)).toBe('ACoAAAtheir0000000000000000000000000000');
    expect(memberIdentityFrom('https://www.linkedin.com/company/acme/')).toBeUndefined();
    expect(memberIdentityFrom('')).toBeUndefined();
  });

  test('a follow target is a person or a company with a numeric id', () => {
    expect(followTargetFrom('https://www.linkedin.com/company/12345/')).toEqual({
      kind: 'company',
      urn: 'urn:li:fsd_company:12345',
    });
    expect(followTargetFrom('urn:li:organization:777')).toEqual({
      kind: 'company',
      urn: 'urn:li:fsd_company:777',
    });
    // A vanity company URL would need a lookup; refused rather than guessed.
    expect(followTargetFrom('https://www.linkedin.com/company/acme/')).toBeUndefined();
    expect(followTargetFrom('https://www.linkedin.com/in/jane-doe')).toEqual({
      kind: 'profile',
      identity: 'jane-doe',
    });
  });
});

describe('connectionStatus', () => {
  test.each([
    ['none', NONE],
    ['pending', PENDING],
    ['connected', CONNECTED],
  ] as const)('reads %s from the top card', async (expected, relationship) => {
    const { session: s, sent } = session(() => json(200, topCard(relationship)));

    expect(await s.connectionStatus('https://www.linkedin.com/in/jane-doe/')).toBe(expected);

    const url = new URL(sent[0]!.url);
    expect(url.pathname).toBe('/voyager/api/identity/dash/profiles');
    expect(url.searchParams.get('q')).toBe('memberIdentity');
    expect(url.searchParams.get('memberIdentity')).toBe('jane-doe');
    expect(url.searchParams.get('decorationId')).toContain('WebTopCardCore');
  });

  test('the subject is picked by URN, not by being first', () => {
    const body = topCard(CONNECTED) as { included: unknown[] };
    body.included.reverse();
    expect(relationshipFromTopCard(body)).toEqual({
      profileUrn: THEM,
      publicIdentifier: 'jane-doe',
      status: 'connected',
    });
  });

  test('a body with no profile is a clear error, not a guess', async () => {
    const { session: s } = session(() => json(200, { data: {}, included: [] }));
    await expect(s.connectionStatus('jane-doe')).rejects.toBeInstanceOf(LinkedInWriteError);
  });

  test('a redirect to the login page is a signed-out session', async () => {
    const { session: s } = session(() => new Response('', { status: 302 }));
    await expect(s.connectionStatus('jane-doe')).rejects.toBeInstanceOf(LinkedInSessionError);
  });
});

describe('viewProfile', () => {
  test('is the profile page’s own read, and returns who it was', async () => {
    const { session: s, sent } = session(() => json(200, topCard(NONE)));
    const viewed = await s.viewProfile('jane-doe');
    expect(viewed.profileUrn).toBe(THEM);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('GET');
  });
});

describe('connect', () => {
  test('sends the Connect dialog’s request with the note and a CSRF pair', async () => {
    const { session: s, sent } = session((req) =>
      req.method === 'GET'
        ? json(200, topCard(NONE))
        : json(200, {
            data: {
              value: {
                '*invitation': 'urn:li:fsd_invitation:7000000000000000001',
                inviteeUrn: THEM,
              },
            },
          }),
    );

    const result = await s.connect('jane-doe', 'Loved your talk on settlement fees.');
    expect(result.invitationUrn).toBe('urn:li:fsd_invitation:7000000000000000001');

    const post = sent[1]!;
    expect(post.method).toBe('POST');
    expect(post.url).toContain(
      '/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2',
    );
    expect(post.body).toEqual({
      invitee: { inviteeUnion: { memberProfile: THEM } },
      customMessage: 'Loved your talk on settlement fees.',
    });
    const csrf = post.headers.get('csrf-token')!;
    expect(post.headers.get('cookie')).toContain(`JSESSIONID="${csrf}"`);
  });

  test('a note-less invitation omits the field rather than sending an empty one', async () => {
    const { session: s, sent } = session(() =>
      json(200, { data: { value: { '*invitation': 'urn:li:fsd_invitation:1' } } }),
    );
    await s.connect(THEM);
    // A URN skips the lookup: one request, the invitation.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).not.toHaveProperty('customMessage');
  });

  test(`refuses a note over ${INVITATION_NOTE_LIMIT} characters before any request`, async () => {
    const { session: s, sent } = session(() => json(200, {}));
    await expect(s.connect(THEM, 'x'.repeat(INVITATION_NOTE_LIMIT + 1))).rejects.toThrow(
      `at most ${INVITATION_NOTE_LIMIT} characters`,
    );
    expect(sent).toHaveLength(0);
  });

  test('a 200 that carries a refusal is reported, not treated as sent', async () => {
    const { session: s } = session(() =>
      json(200, { data: { code: 'CANT_RESEND_YET', message: 'already pending' } }),
    );
    await expect(s.connect(THEM)).rejects.toThrow('CANT_RESEND_YET');
  });
});

describe('follow', () => {
  test('patches the following state of a person to true', async () => {
    const { session: s, sent } = session((req) =>
      req.method === 'GET' ? json(200, topCard(NONE)) : new Response('', { status: 200 }),
    );
    const followed = await s.follow('https://www.linkedin.com/in/jane-doe');
    expect(followed.urn).toBe(THEM);

    const post = sent[1]!;
    expect(decodeURIComponent(post.url)).toContain(
      `/feed/dash/followingStates/urn:li:fsd_followingState:${THEM}`,
    );
    expect(post.body).toEqual({ patch: { $set: { following: true } } });
  });

  test('follows a company by id without a profile lookup', async () => {
    const { session: s, sent } = session(() => new Response('', { status: 200 }));
    await s.follow('https://www.linkedin.com/company/12345/');
    expect(sent).toHaveLength(1);
    expect(decodeURIComponent(sent[0]!.url)).toContain(
      'urn:li:fsd_followingState:urn:li:fsd_company:12345',
    );
  });
});

describe('sendMessage', () => {
  test('writes from our own mailbox to their profile', async () => {
    const { session: s, sent } = session((req) => {
      if (req.url.endsWith('/me')) {
        return json(200, {
          miniProfile: {
            publicIdentifier: 'sam-seller',
            entityUrn: `urn:li:fs_miniProfile:${US}`,
            firstName: 'Sam',
          },
        });
      }
      return json(201, { data: { value: { entityUrn: 'urn:li:msg_message:1' } } });
    });

    const result = await s.sendMessage(THEM, 'Thanks for connecting.');
    expect(result.urn).toBe('urn:li:msg_message:1');

    const post = sent.find((r) => r.url.includes('createMessage'))!;
    expect(post.body).toMatchObject({
      mailboxUrn: `urn:li:fsd_profile:${US}`,
      hostRecipientUrns: [THEM],
      dedupeByClientGeneratedToken: false,
      message: { body: { text: 'Thanks for connecting.', attributes: [] } },
    });
    expect(String(post.body?.trackingId)).toHaveLength(16);
  });

  test('refuses an empty message without a request', async () => {
    const { session: s, sent } = session(() => json(200, {}));
    await expect(s.sendMessage(THEM, '   ')).rejects.toThrow('no message');
    expect(sent).toHaveLength(0);
  });
});
