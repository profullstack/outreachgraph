import { afterEach, describe, expect, test } from 'bun:test';
import { now } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { isNonBuyerDesk, ownDomains, personOnOwnDomain, refuseRecipient } from './recipient-guard';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

describe('ownDomains', () => {
  test('spans the organization, its people and mailboxes, and skips shared hosts', async () => {
    seeded = await seedDatabase('own-domains-org');
    const stamp = now();
    await seeded.db.batch([
      {
        sql: `UPDATE offerings SET url = 'https://www.ugig.net/jobs' WHERE id = ?`,
        args: [SEED.offeringId],
      },
      {
        // A teammate's workspace in the same organization sells another product.
        sql: `INSERT INTO workspaces (id, organization_id, name, slug, min_outreach_confidence,
              created_at, updated_at) VALUES ('wsp_team', ?, 'Team', 'team', 0.85, ?, ?)`,
        args: [SEED.organizationId, stamp, stamp],
      },
      {
        sql: `INSERT INTO offerings (id, workspace_id, name, category, url, created_at, updated_at)
              VALUES ('off_team', 'wsp_team', 'CoinPay', 'payments', 'coinpayportal.com', ?, ?)`,
        args: [stamp, stamp],
      },
      {
        sql: `INSERT INTO offerings (id, workspace_id, name, category, url, created_at, updated_at)
              VALUES ('off_repo', 'wsp_team', 'Repo', 'tools', 'https://github.com/acme/tool', ?, ?)`,
        args: [stamp, stamp],
      },
      {
        sql: `INSERT INTO users (id, email, name, created_at, updated_at)
              VALUES ('usr_gmail', 'someone@gmail.com', 'Someone', ?, ?)`,
        args: [stamp, stamp],
      },
      {
        sql: `INSERT INTO organization_members (organization_id, user_id, role, created_at)
              VALUES (?, 'usr_gmail', 'member', ?)`,
        args: [SEED.organizationId, stamp],
      },
      {
        sql: `INSERT INTO users (id, email, name, created_at, updated_at)
              VALUES ('usr_mate', 'preshy@profullstack.com', 'Mate', ?, ?)`,
        args: [stamp, stamp],
      },
      {
        sql: `INSERT INTO organization_members (organization_id, user_id, role, created_at)
              VALUES (?, 'usr_mate', 'member', ?)`,
        args: [SEED.organizationId, stamp],
      },
    ]);

    const own = await ownDomains(seeded.db, SEED.workspaceId);
    expect(own.has('ugig.net')).toBe(true);
    expect(own.has('coinpayportal.com')).toBe(true);
    // A teammate's company address; the seed user's example.com is reserved.
    expect(own.has('profullstack.com')).toBe(true);
    expect(own.has('example.com')).toBe(false);
    expect(own.has('github.com')).toBe(false);
    expect(own.has('gmail.com')).toBe(false);
  });

  test('a person at one of our domains is ours; a prospect elsewhere is not', async () => {
    seeded = await seedDatabase('own-domains-person');
    expect(
      await personOnOwnDomain(seeded.db, SEED.workspaceId, SEED.personId, new Set(['ugig.net'])),
    ).toBe(false);
    expect(
      await personOnOwnDomain(seeded.db, SEED.workspaceId, SEED.personId, new Set(['acme.com'])),
    ).toBe(true);
  });
});

const OWN = new Set(['ugig.net', 'coinpayportal.com']);

describe('refuseRecipient', () => {
  test('desks that file tickets are refused, however they are spelled', () => {
    for (const address of [
      'support@acme.com',
      'Support+EU@acme.com',
      'help.desk@acme.com',
      'abuse@host.example',
      'security@host.example',
      'no-reply@acme.com',
      'noreply-billing@acme.com',
    ]) {
      expect(isNonBuyerDesk(address)).toBe(true);
    }
  });

  test('the shared inboxes small companies actually read stay allowed', () => {
    for (const address of ['hello@acme.com', 'info@acme.com', 'sales@acme.com', 'jane@acme.com']) {
      expect(refuseRecipient(address, OWN)).toBeUndefined();
    }
  });

  test('press, media and hiring desks are not buyers either', () => {
    for (const address of [
      'press@acme.com',
      'media@acme.com',
      'recruitment@acme.com',
      'hiring@acme.com',
    ]) {
      expect(isNonBuyerDesk(address)).toBe(true);
    }
  });

  test('a fragment cut out of job-board text is refused', () => {
    expect(refuseRecipient('+hn@dat.com', OWN)).toContain('not a usable address');
    expect(refuseRecipient('jane@', OWN)).toContain('not a usable address');
    expect(refuseRecipient('jane+hn@dat.com', OWN)).toBeUndefined();
  });

  test('the workspace’s own domains are never prospects, subdomains included', () => {
    expect(refuseRecipient('hello@ugig.net', OWN)).toContain('own products');
    expect(refuseRecipient('jane@mail.coinpayportal.com', OWN)).toContain('own products');
    expect(refuseRecipient('jane@notugig.net', OWN)).toBeUndefined();
  });

  test('says which desk it is', () => {
    expect(refuseRecipient('abuse@host.example', OWN)).toBe(
      'abuse@host.example is a abuse desk, not a buyer',
    );
  });
});
