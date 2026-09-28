import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll } from '@outreachgraph/db';
import { createApp } from './app';
import type { RequestActor } from './context';
import { checkMailDomain, type MailResolver } from './mail-domain';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/** A resolver where only the listed domains have mail servers. */
function resolver(mail: readonly string[], opts: { a?: readonly string[]; broken?: boolean } = {}) {
  const calls: string[] = [];
  const fake: MailResolver = {
    async resolveMx(domain) {
      calls.push(domain);
      if (opts.broken) fail('ETIMEOUT');
      return mail.includes(domain)
        ? [{ exchange: `mx.${domain}`, priority: 10 }]
        : fail('ENOTFOUND');
    },
    async resolve4(domain) {
      if (opts.broken) fail('ETIMEOUT');
      return opts.a?.includes(domain) ? ['192.0.2.1'] : fail('ENOTFOUND');
    },
  };
  return { fake, calls };
}

describe('checkMailDomain', () => {
  test('a domain with a mail server passes', async () => {
    expect(
      await checkMailDomain('sam@profullstack.com', resolver(['profullstack.com']).fake),
    ).toEqual({ ok: true });
  });

  test('a .co typo is refused with the .com that works', async () => {
    const result = await checkMailDomain(
      'preshy@profullstack.co',
      resolver(['profullstack.com']).fake,
    );
    expect(result).toEqual({
      ok: false,
      domain: 'profullstack.co',
      suggestion: 'preshy@profullstack.com',
    });
  });

  test('no MX but an address record still receives mail', async () => {
    const { fake } = resolver([], { a: ['tiny.example'] });
    expect((await checkMailDomain('x@tiny.example', fake)).ok).toBe(true);
  });

  test('a dead domain with no near miss has no suggestion', async () => {
    const result = await checkMailDomain('x@nowhere.invalid', resolver([]).fake);
    expect(result).toEqual({ ok: false, domain: 'nowhere.invalid' });
  });

  test('a resolver outage lets the invite through', async () => {
    const { fake } = resolver([], { broken: true });
    expect((await checkMailDomain('x@profullstack.co', fake)).ok).toBe(true);
  });
});

describe('POST /team/invitations', () => {
  let active: SeededDatabase | undefined;
  afterEach(() => {
    active?.cleanup();
    active = undefined;
  });

  const ACTOR: RequestActor = {
    userId: SEED.userId,
    workspaceId: SEED.workspaceId,
    organizationId: SEED.organizationId,
    role: 'owner',
  };

  test('refuses an undeliverable domain before minting anything', async () => {
    active = await seedDatabase('invite-mail-domain');
    const app = createApp({
      db: active.db,
      authenticate: async () => ACTOR,
      mailResolver: resolver(['profullstack.com']).fake,
    });

    const response = await app.request('/api/v1/team/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'preshy@profullstack.co', role: 'admin' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.message).toBe(
      'profullstack.co cannot receive email. Did you mean preshy@profullstack.com?',
    );
    expect(await queryAll(active.db, 'SELECT id FROM invitations')).toHaveLength(0);
  });

  test('invites a deliverable address as before', async () => {
    active = await seedDatabase('invite-mail-domain-ok');
    const app = createApp({
      db: active.db,
      authenticate: async () => ACTOR,
      mailResolver: resolver(['profullstack.com']).fake,
    });

    const response = await app.request('/api/v1/team/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'preshy@profullstack.com', role: 'admin' }),
    });

    expect(response.status).toBe(201);
  });
});
