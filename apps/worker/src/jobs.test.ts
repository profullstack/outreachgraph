import { afterEach, describe, expect, test } from 'bun:test';
import { seedDatabase, SEED, type SeededDatabase } from '../../api/src/test-seed';
import { expireSignals, markSourceUnavailable, processDeletion, rescoreProspect } from './jobs';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function fixture(label: string): Promise<SeededDatabase> {
  active = await seedDatabase(`worker-${label}`);
  return active;
}

describe('rescoreProspect', () => {
  test('writes a score row with the weights it used', async () => {
    const { db } = await fixture('rescore');
    const result = await rescoreProspect(db, SEED.campaignId, SEED.personId);

    expect(result.ok).toBe(true);

    const score = await db.execute({
      sql: 'SELECT * FROM scores WHERE campaign_id = ? AND person_id = ?',
      args: [SEED.campaignId, SEED.personId],
    });

    const row = score.rows[0];
    expect(row).toBeDefined();
    expect(Number(row?.opportunity)).toBeGreaterThan(0);
    expect(JSON.parse(String(row?.weights_json))).toHaveProperty('icpFit');
  });

  test('upserts rather than duplicating on a second run', async () => {
    const { db } = await fixture('rescore-twice');

    await rescoreProspect(db, SEED.campaignId, SEED.personId);
    await rescoreProspect(db, SEED.campaignId, SEED.personId);

    const count = await db.execute({
      sql: 'SELECT count(*) AS n FROM scores WHERE campaign_id = ? AND person_id = ?',
      args: [SEED.campaignId, SEED.personId],
    });
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  test('a fresh high-intent signal produces real intent', async () => {
    const { db } = await fixture('rescore-intent');
    await rescoreProspect(db, SEED.campaignId, SEED.personId);

    const score = await db.execute({
      sql: 'SELECT intent FROM scores WHERE person_id = ?',
      args: [SEED.personId],
    });
    expect(Number(score.rows[0]?.intent)).toBeGreaterThan(50);
  });

  test('intent falls once the signal is expired', async () => {
    const { db } = await fixture('rescore-expired');
    await db.execute({
      sql: 'UPDATE signals SET expires_at = ? WHERE id = ?',
      args: [new Date(Date.now() - 1000).toISOString(), SEED.signalId],
    });

    await rescoreProspect(db, SEED.campaignId, SEED.personId);

    const score = await db.execute({
      sql: 'SELECT intent FROM scores WHERE person_id = ?',
      args: [SEED.personId],
    });
    expect(Number(score.rows[0]?.intent)).toBe(0);
  });

  test('a disabled signal rule removes its contribution', async () => {
    const { db } = await fixture('rescore-rule');
    await db.execute({
      sql: `INSERT INTO campaign_signal_rules (campaign_id, signal_type, enabled, weight)
            VALUES (?, 'recommendation_request', 0, 1)`,
      args: [SEED.campaignId],
    });

    await rescoreProspect(db, SEED.campaignId, SEED.personId);

    const score = await db.execute({
      sql: 'SELECT intent FROM scores WHERE person_id = ?',
      args: [SEED.personId],
    });
    expect(Number(score.rows[0]?.intent)).toBe(0);
  });

  test('reports a missing campaign rather than throwing', async () => {
    const { db } = await fixture('rescore-nocampaign');
    const result = await rescoreProspect(db, 'cmp_missing', SEED.personId);

    expect(result.ok).toBe(false);
    expect(result.detail.reason).toBe('no_campaign');
  });
});

describe('expireSignals', () => {
  test('expires signals past the retention horizon', async () => {
    const { db } = await fixture('expire');
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();

    await db.execute({
      sql: 'UPDATE signals SET source_timestamp = ? WHERE id = ?',
      args: [old, SEED.signalId],
    });

    const result = await expireSignals(db, SEED.workspaceId);
    expect(result.detail.expired).toBe(1);

    const row = await db.execute({
      sql: 'SELECT expires_at FROM signals WHERE id = ?',
      args: [SEED.signalId],
    });
    expect(row.rows[0]?.expires_at).not.toBeNull();
  });

  test('leaves recent signals alone', async () => {
    const { db } = await fixture('expire-recent');
    const result = await expireSignals(db, SEED.workspaceId);

    expect(result.detail.expired).toBe(0);
  });

  test('does not touch another workspace', async () => {
    const { db } = await fixture('expire-scope');
    await db.execute({
      sql: 'UPDATE signals SET source_timestamp = ? WHERE id = ?',
      args: [new Date(Date.now() - 200 * 86_400_000).toISOString(), SEED.signalId],
    });

    const result = await expireSignals(db, 'wsp_other');
    expect(result.detail.expired).toBe(0);
  });
});

describe('source deletion (PRD §17.6)', () => {
  test('ungrounds signals whose source disappeared', async () => {
    const { db } = await fixture('source-gone');
    const stamp = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO source_documents (id, workspace_id, network, url, excerpt, fetched_at,
            availability, license_class)
            VALUES ('src_1', ?, 'x', 'https://x.com/p/1', 'original text', ?, 'available', 'public_api')`,
      args: [SEED.workspaceId, stamp],
    });
    await db.execute({
      sql: 'UPDATE signals SET source_document_id = ? WHERE id = ?',
      args: ['src_1', SEED.signalId],
    });

    const result = await markSourceUnavailable(db, 'src_1');
    expect(result.detail.signalsUngrounded).toBe(1);

    const doc = await db.execute(
      "SELECT availability, excerpt FROM source_documents WHERE id = 'src_1'",
    );
    expect(doc.rows[0]?.availability).toBe('unavailable');
    expect(doc.rows[0]?.excerpt).toBeNull();

    // The signal survives as a record, but can no longer ground a claim.
    const signal = await db.execute({
      sql: 'SELECT evidence FROM signals WHERE id = ?',
      args: [SEED.signalId],
    });
    expect(signal.rows[0]?.evidence).toBeNull();
  });
});

describe('processDeletion', () => {
  test('removes derived data and records what it deleted', async () => {
    const { db } = await fixture('deletion');
    const stamp = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO privacy_requests (id, kind, status, source_channel, subject_match_keys, received_at)
            VALUES ('pri_1', 'delete', 'received', 'drop', '[]', ?)`,
      args: [stamp],
    });
    await db.execute({
      sql: `INSERT INTO deletion_jobs (id, privacy_request_id, person_id, status, created_at)
            VALUES ('del_1', 'pri_1', ?, 'pending', ?)`,
      args: [SEED.personId, stamp],
    });

    const result = await processDeletion(db, 'del_1');
    expect(result.ok).toBe(true);

    const job = await db.execute(
      "SELECT status, deleted_counts_json FROM deletion_jobs WHERE id = 'del_1'",
    );
    expect(job.rows[0]?.status).toBe('completed');
    expect(JSON.parse(String(job.rows[0]?.deleted_counts_json))).toHaveProperty('signals');

    const request = await db.execute("SELECT status FROM privacy_requests WHERE id = 'pri_1'");
    expect(request.rows[0]?.status).toBe('completed');

    const person = await db.execute({
      sql: 'SELECT status, display_name FROM people WHERE id = ?',
      args: [SEED.personId],
    });
    expect(person.rows[0]?.status).toBe('deleted');
    expect(person.rows[0]?.display_name).toBe('[deleted]');
  });

  test('is idempotent', async () => {
    const { db } = await fixture('deletion-idempotent');
    const stamp = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO deletion_jobs (id, person_id, status, created_at)
            VALUES ('del_2', ?, 'pending', ?)`,
      args: [SEED.personId, stamp],
    });

    await processDeletion(db, 'del_2');
    const second = await processDeletion(db, 'del_2');

    expect(second.ok).toBe(true);
    expect(second.detail.alreadyDone).toBe(true);
  });

  test('reports a missing job rather than throwing', async () => {
    const { db } = await fixture('deletion-missing');
    const result = await processDeletion(db, 'del_nope');

    expect(result.ok).toBe(false);
  });
});
