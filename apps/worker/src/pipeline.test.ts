import { afterEach, describe, expect, test } from 'bun:test';
import { GitHubProvider } from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../api/src/test-seed';
import { runPipeline } from './pipeline';

/** A GitHub profile with the self-declared cross-links the resolver needs. */
const PROFILE = {
  login: 'alexchen',
  id: 4242,
  name: 'Alex Chen',
  company: '@Loopwright',
  blog: 'https://loopwright.io',
  location: 'Berlin',
  email: null,
  bio: 'Agent reliability',
  twitter_username: 'alexbuilds',
  public_repos: 30,
  followers: 500,
  html_url: 'https://github.com/alexchen',
  created_at: '2015-01-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

const EVENTS = [
  {
    id: '1',
    type: 'IssuesEvent',
    created_at: hoursAgo(3),
    repo: { id: 9, name: 'loopwright/agents', url: '' },
    payload: {
      action: 'opened',
      issue: {
        title: 'Anyone know a good alternative to Stripe for cross-border payouts?',
        body: 'Fees are brutal and settlement takes days.',
        html_url: 'https://github.com/loopwright/agents/issues/12',
      },
    },
  },
];

const REPOS = [
  {
    name: 'agents',
    full_name: 'loopwright/agents',
    html_url: 'https://github.com/loopwright/agents',
    description: 'agent orchestration',
    language: 'TypeScript',
    topics: ['bun'],
    fork: false,
    stargazers_count: 40,
    created_at: hoursAgo(500),
    pushed_at: hoursAgo(10),
  },
];

/** Serves the canned GitHub payloads by URL suffix. */
function stubGitHub(): GitHubProvider {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();

    const body = url.includes('/events/public')
      ? EVENTS
      : url.includes('/repos')
        ? REPOS
        : url.includes('/users/alexchen')
          ? PROFILE
          : null;

    if (!body) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return new GitHubProvider({ fetchImpl });
}

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function fixture(label: string): Promise<SeededDatabase> {
  active = await seedDatabase(`pipeline-${label}`);

  // Give the campaign the targeting the extractor scores relevance against.
  await active.db.execute({
    sql: `INSERT INTO campaign_filters (campaign_id, technologies, keywords, updated_at)
          VALUES (?, ?, ?, ?)`,
    args: [
      SEED.campaignId,
      JSON.stringify(['TypeScript', 'bun']),
      JSON.stringify(['payouts', 'payments']),
      new Date().toISOString(),
    ],
  });
  await active.db.execute({
    sql: 'UPDATE offerings SET competitors = ? WHERE id = ?',
    args: [JSON.stringify(['Stripe']), SEED.offeringId],
  });

  return active;
}

function options(db: SeededDatabase['db']) {
  return {
    db,
    workspaceId: SEED.workspaceId,
    campaignId: SEED.campaignId,
    providers: [],
    github: stubGitHub(),
  };
}

describe('end to end', () => {
  test('takes a bare handle all the way to the approval queue', async () => {
    const { db } = await fixture('happy');

    const result = await runPipeline(options(db), 'alexchen');

    expect(result.stage).toBe('recommended');
    expect(result.personId).toBeDefined();
    expect(result.recommendationId).toBeDefined();
    expect(result.signalsStored).toBeGreaterThan(0);

    // The card is now visible to the approval queue query.
    const queue = await db.execute({
      sql: `SELECT r.id, r.action, r.network, r.priority, p.display_name
              FROM recommendations r JOIN people p ON p.id = r.person_id
             WHERE r.workspace_id = ? AND r.status = 'pending' AND r.person_id = ?`,
      args: [SEED.workspaceId, result.personId!],
    });

    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0]?.display_name).toBe('Alex Chen');
  });

  test('links the identities the profile declares', async () => {
    const { db } = await fixture('identities');
    const result = await runPipeline(options(db), 'alexchen');

    const identities = await db.execute({
      sql: 'SELECT network, handle, confidence FROM social_identities WHERE person_id = ?',
      args: [result.personId!],
    });

    const networks = identities.rows.map((r) => String(r.network));
    expect(networks).toContain('github');
    // Declared on their own profile, so it clears the merge threshold.
    expect(networks).toContain('x');
  });

  test('records provenance for every enriched field', async () => {
    const { db } = await fixture('provenance');
    const result = await runPipeline(options(db), 'alexchen');

    const provenance = await db.execute({
      sql: `SELECT field, provider, license_class FROM field_provenance
             WHERE entity_kind = 'person' AND entity_id = ?`,
      args: [result.personId!],
    });

    expect(provenance.rows.length).toBeGreaterThan(0);
    expect(provenance.rows[0]?.provider).toBe('github');
    expect(provenance.rows[0]?.license_class).toBe('public_api');
  });

  test('classifies the competitor complaint and grounds the recommendation on it', async () => {
    const { db } = await fixture('signal');
    const result = await runPipeline(options(db), 'alexchen');

    const signals = await db.execute({
      sql: 'SELECT signal_type, subtype, evidence FROM signals WHERE person_id = ?',
      args: [result.personId!],
    });

    const types = signals.rows.map((r) => String(r.signal_type));
    expect(types).toContain('competitor_mention');

    const competitor = signals.rows.find((r) => r.signal_type === 'competitor_mention');
    expect(competitor?.subtype).toBe('Stripe');
    // Verbatim words, so a reply may quote them.
    expect(String(competitor?.evidence)).toContain('alternative to Stripe');

    const recommendation = await db.execute({
      sql: 'SELECT trigger_signal_id, reason FROM recommendations WHERE id = ?',
      args: [result.recommendationId!],
    });
    expect(recommendation.rows[0]?.trigger_signal_id).toBeTruthy();
  });

  test('scores the prospect before recommending', async () => {
    const { db } = await fixture('score');
    const result = await runPipeline(options(db), 'alexchen');

    const score = await db.execute({
      sql: 'SELECT opportunity, intent FROM scores WHERE person_id = ? AND campaign_id = ?',
      args: [result.personId!, SEED.campaignId],
    });

    expect(Number(score.rows[0]?.opportunity)).toBeGreaterThan(0);
    expect(Number(score.rows[0]?.intent)).toBeGreaterThan(0);
  });

  test('advances the prospect through the pipeline states', async () => {
    const { db } = await fixture('states');
    const result = await runPipeline(options(db), 'alexchen');

    const membership = await db.execute({
      sql: 'SELECT status FROM campaign_people WHERE campaign_id = ? AND person_id = ?',
      args: [SEED.campaignId, result.personId!],
    });

    expect(membership.rows[0]?.status).toBe('awaiting_approval');
  });
});

describe('idempotence', () => {
  test('a second run reuses the person rather than duplicating them', async () => {
    const { db } = await fixture('rerun');

    const first = await runPipeline(options(db), 'alexchen');
    const second = await runPipeline(options(db), 'alexchen');

    expect(second.personId).toBe(first.personId!);

    const people = await db.execute(
      "SELECT count(*) AS n FROM people WHERE display_name = 'Alex Chen'",
    );
    expect(Number(people.rows[0]?.n)).toBe(1);
  });

  test('does not duplicate signals for the same public event', async () => {
    const { db } = await fixture('resignal');

    const first = await runPipeline(options(db), 'alexchen');
    const second = await runPipeline(options(db), 'alexchen');

    expect(second.signalsStored).toBe(0);

    const signals = await db.execute({
      sql: 'SELECT count(*) AS n FROM signals WHERE person_id = ?',
      args: [first.personId!],
    });
    // Same count as the first run produced.
    expect(Number(signals.rows[0]?.n)).toBe(first.signalsStored);
  });
});

describe('refusals', () => {
  test('stops on an unknown handle without creating a person', async () => {
    const { db } = await fixture('unknown');

    const result = await runPipeline(options(db), 'does-not-exist');

    expect(result.stage).toBe('stopped');
    expect(result.personId).toBeUndefined();

    const people = await db.execute(
      "SELECT count(*) AS n FROM people WHERE display_name != 'Jane Smith'",
    );
    expect(Number(people.rows[0]?.n)).toBe(0);
  });

  test('stops before researching a suppressed person', async () => {
    const { db } = await fixture('suppressed');
    const stamp = new Date().toISOString();

    // Suppress the GitHub account before it is ever seen.
    await db.execute({
      sql: `INSERT INTO suppression_entries (id, reason, scope, source, created_at)
            VALUES ('sup_pipe', 'consumer_opt_out', 'global', 'privacy_request', ?)`,
      args: [stamp],
    });

    // First run links the identity so the suppression key can match it.
    const first = await runPipeline(options(db), 'alexchen');
    await db.execute({
      sql: `INSERT INTO suppression_keys (match_key, suppression_id, scope, workspace_id)
            VALUES (?, 'sup_pipe', 'global', NULL)`,
      args: [`person:${first.personId!}`],
    });

    await db.execute({
      sql: 'DELETE FROM recommendations WHERE person_id = ?',
      args: [first.personId!],
    });

    const second = await runPipeline(options(db), 'alexchen');

    expect(second.stage).toBe('stopped');
    expect(second.stoppedBecause).toBe('suppressed');

    const recommendations = await db.execute({
      sql: 'SELECT count(*) AS n FROM recommendations WHERE person_id = ?',
      args: [first.personId!],
    });
    expect(Number(recommendations.rows[0]?.n)).toBe(0);

    const membership = await db.execute({
      sql: 'SELECT status FROM campaign_people WHERE person_id = ?',
      args: [first.personId!],
    });
    expect(membership.rows[0]?.status).toBe('suppressed');
  });

  test('recommends nothing when the daily limit is already spent', async () => {
    const { db } = await fixture('ratelimited');

    await db.execute({
      sql: 'UPDATE campaigns SET budget_json = ? WHERE id = ?',
      args: [JSON.stringify({ maxActionsPerDay: 0 }), SEED.campaignId],
    });

    const result = await runPipeline(options(db), 'alexchen');

    // Research still happened and is retained; only the outreach is withheld.
    expect(result.signalsStored).toBeGreaterThan(0);

    const outbound = await db.execute({
      sql: `SELECT count(*) AS n FROM recommendations
             WHERE person_id = ? AND action IN ('reply','comment','send_dm','send_email')`,
      args: [result.personId!],
    });
    expect(Number(outbound.rows[0]?.n)).toBe(0);
  });
});
