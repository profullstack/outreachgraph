/**
 * Rules, and the thing a rule cannot do.
 *
 * The design claim is that a rule may only *queue* work: whether that work
 * happens, and whether automatically or as a human step, stays the policy
 * engine's decision. The first test in the last block is the one that pins it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  newId,
  ruleMatches,
  validateRule,
  RULE_ACTIONS,
  type AutomationRule,
  type RuleEvent,
} from '@outreachgraph/domain';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { createCadence } from './cadence';
import { createRule, runRules, setRuleEnabled } from './rules';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rul_1',
    workspaceId: SEED.workspaceId,
    name: 'Test rule',
    trigger: 'signal_received',
    condition: {},
    action: 'notify',
    config: {},
    enabled: true,
    ...overrides,
  };
}

function event(overrides: Partial<RuleEvent> = {}): RuleEvent {
  return {
    trigger: 'signal_received',
    personId: SEED.personId,
    campaignId: SEED.campaignId,
    signalId: 'sig_1',
    signalType: 'pain',
    summary: 'complained about Stripe fees',
    relevance: 0.8,
    confidence: 0.9,
    ...overrides,
  };
}

async function cadence(db: Client): Promise<string> {
  const created = await createCadence(db, {
    workspaceId: SEED.workspaceId,
    campaignId: SEED.campaignId,
    name: 'Rule plan',
    status: 'active',
    steps: [
      {
        position: 0,
        network: 'email',
        action: 'send_email',
        delayHours: 0,
        stopOnReply: true,
      },
    ],
  });

  if (!created.created) throw new Error('cadence not created');
  return created.cadenceId;
}

describe('ruleMatches', () => {
  test('an empty condition matches every event of that trigger', () => {
    expect(ruleMatches(rule(), event())).toBe(true);
  });

  test('a different trigger never matches', () => {
    expect(ruleMatches(rule({ trigger: 'reply_received' }), event())).toBe(false);
  });

  test('a disabled rule never matches', () => {
    expect(ruleMatches(rule({ enabled: false }), event())).toBe(false);
  });

  test('matches on signal type', () => {
    expect(ruleMatches(rule({ condition: { signalType: 'pain' } }), event())).toBe(true);
    expect(ruleMatches(rule({ condition: { signalType: 'hiring' } }), event())).toBe(false);
  });

  test('matches on a relevance floor', () => {
    expect(ruleMatches(rule({ condition: { minRelevance: 0.5 } }), event())).toBe(true);
    expect(ruleMatches(rule({ condition: { minRelevance: 0.95 } }), event())).toBe(false);
  });

  test('matches text case-insensitively', () => {
    expect(ruleMatches(rule({ condition: { contains: 'STRIPE' } }), event())).toBe(true);
    expect(ruleMatches(rule({ condition: { contains: 'adyen' } }), event())).toBe(false);
  });

  test('a campaign-scoped rule ignores another campaign', () => {
    const scoped = rule({ campaignId: 'cmp_other' });

    expect(ruleMatches(scoped, event())).toBe(false);
    expect(ruleMatches(scoped, event({ campaignId: 'cmp_other' }))).toBe(true);
  });

  test('a workspace-scoped rule fires for every campaign', () => {
    expect(ruleMatches(rule(), event({ campaignId: 'cmp_anything' }))).toBe(true);
  });

  test('a threshold on a field the event lacks does not match', () => {
    // Absent is not zero. Treating it as zero would fire every score rule on
    // every prospect who has not been scored yet.
    expect(ruleMatches(rule({ condition: { minOpportunity: 60 } }), event())).toBe(false);
  });
});

describe('validateRule', () => {
  test('accepts a well-formed rule', () => {
    expect(
      validateRule({
        name: 'Hot leads',
        trigger: 'signal_received',
        action: 'enroll_cadence',
        config: { cadenceId: 'cad_1' },
      }),
    ).toEqual([]);
  });

  test('refuses an action that would reach the wire', () => {
    // The security boundary. `send_email` is not a missing feature.
    const problems = validateRule({
      name: 'Blast',
      trigger: 'signal_received',
      action: 'send_email',
      config: {},
    });

    expect(problems.some((p) => p.message.includes('only queue work'))).toBe(true);
  });

  test('refuses enrolling onto no cadence', () => {
    // Fires happily forever and produces nothing, which is indistinguishable
    // from a rule that is not firing at all.
    const problems = validateRule({
      name: 'Enrol',
      trigger: 'signal_received',
      action: 'enroll_cadence',
      config: {},
    });

    expect(problems).toHaveLength(1);
  });

  test('refuses a nameless rule', () => {
    expect(
      validateRule({ name: '  ', trigger: 'signal_received', action: 'notify', config: {} }),
    ).toHaveLength(1);
  });
});

describe('runRules', () => {
  test('enrols a matching prospect on a cadence', async () => {
    seeded = await seedDatabase('rules-enroll');
    const { db } = seeded;
    const cadenceId = await cadence(db);

    await createRule(db, {
      workspaceId: SEED.workspaceId,
      name: 'Pain means outreach',
      trigger: 'signal_received',
      condition: { signalType: 'pain' },
      action: 'enroll_cadence',
      config: { cadenceId },
    });

    const result = await runRules(db, SEED.workspaceId, event());

    expect(result.applied).toBe(1);
    expect(await queryAll(db, 'SELECT id FROM cadence_enrollments')).toHaveLength(1);
  });

  test('fires once per event however often it is replayed', async () => {
    // Re-running the signal sweep must not re-enrol everybody it already
    // enrolled, every tick, for as long as the signal stays fresh.
    seeded = await seedDatabase('rules-once');
    const { db } = seeded;
    const cadenceId = await cadence(db);

    await createRule(db, {
      workspaceId: SEED.workspaceId,
      name: 'Once',
      trigger: 'signal_received',
      condition: {},
      action: 'enroll_cadence',
      config: { cadenceId },
    });

    await runRules(db, SEED.workspaceId, event());
    const second = await runRules(db, SEED.workspaceId, event());

    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await queryAll(db, 'SELECT id FROM cadence_enrollments')).toHaveLength(1);
  });

  test('a different signal fires the rule again', async () => {
    seeded = await seedDatabase('rules-newsignal');
    const { db } = seeded;
    const cadenceId = await cadence(db);

    await createRule(db, {
      workspaceId: SEED.workspaceId,
      name: 'Each signal',
      trigger: 'signal_received',
      condition: {},
      action: 'notify',
      config: { message: 'saw something' },
    });

    await runRules(db, SEED.workspaceId, event({ signalId: 'sig_1' }));
    const second = await runRules(db, SEED.workspaceId, event({ signalId: 'sig_2' }));

    expect(second.applied).toBe(1);
    expect(cadenceId).toBeTruthy();
  });

  test('suppresses, and the tombstone is what stops later contact', async () => {
    seeded = await seedDatabase('rules-suppress');
    const { db } = seeded;

    await createRule(db, {
      workspaceId: SEED.workspaceId,
      name: 'Opt out',
      trigger: 'signal_received',
      condition: { contains: 'unsubscribe' },
      action: 'suppress',
      config: { reason: 'asked to stop' },
    });

    await runRules(db, SEED.workspaceId, event({ summary: 'please unsubscribe me' }));

    const key = await queryOne<{ match_key: string }>(
      db,
      'SELECT match_key FROM suppression_keys LIMIT 1',
    );
    expect(key?.match_key).toBe(`person:${SEED.personId}`);
  });

  test('records a firing that could not be applied', async () => {
    // A rule that matches constantly and is refused every time looks identical
    // to a working rule from a counter.
    seeded = await seedDatabase('rules-refused');
    const { db } = seeded;

    await createRule(db, {
      workspaceId: SEED.workspaceId,
      name: 'Broken',
      trigger: 'signal_received',
      condition: {},
      action: 'enroll_cadence',
      config: { cadenceId: 'cad_missing' },
    });

    const result = await runRules(db, SEED.workspaceId, event());

    expect(result.fired).toBe(1);
    expect(result.applied).toBe(0);

    const run = await queryOne<{ outcome: string; detail: string }>(
      db,
      'SELECT outcome, detail FROM rule_runs LIMIT 1',
    );
    expect(run?.outcome).toBe('skipped');
    expect(run?.detail).toContain('no such cadence');
  });

  test('a disabled rule does not fire', async () => {
    seeded = await seedDatabase('rules-disabled');
    const { db } = seeded;

    const ruleId = await createRule(db, {
      workspaceId: SEED.workspaceId,
      name: 'Off',
      trigger: 'signal_received',
      condition: {},
      action: 'notify',
      config: {},
    });

    expect(await setRuleEnabled(db, SEED.workspaceId, ruleId, false)).toBe(true);
    expect((await runRules(db, SEED.workspaceId, event())).fired).toBe(0);
  });

  test('does not read another workspace’s rules', async () => {
    seeded = await seedDatabase('rules-isolation');
    const { db } = seeded;

    await createRule(db, {
      workspaceId: SEED.workspaceId,
      name: 'Mine',
      trigger: 'signal_received',
      condition: {},
      action: 'notify',
      config: {},
    });

    expect((await runRules(db, 'wsp_other', event())).considered).toBe(0);
  });
});

describe('the boundary', () => {
  test('there is no action that reaches the wire', () => {
    // If this list ever grows a sending action, the guarantee that a rule can
    // only queue work is gone, whatever that action's implementation does.
    expect([...RULE_ACTIONS]).toEqual(['enroll_cadence', 'notify', 'suppress', 'set_status']);
  });

  test('an enrolled prospect still goes through the capability matrix', async () => {
    // A rule enrolling somebody onto a LinkedIn plan does not make LinkedIn
    // automatable. The step is resolved when it falls due, and lands as a
    // human step.
    seeded = await seedDatabase('rules-still-gated');
    const { db } = seeded;

    const created = await createCadence(db, {
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      name: 'LinkedIn plan',
      status: 'active',
      steps: [
        {
          position: 0,
          network: 'linkedin',
          action: 'send_dm',
          delayHours: 0,
          stopOnReply: true,
        },
      ],
    });
    if (!created.created) throw new Error('not created');

    await createRule(db, {
      workspaceId: SEED.workspaceId,
      name: 'Enrol on LinkedIn plan',
      trigger: 'signal_received',
      condition: {},
      action: 'enroll_cadence',
      config: { cadenceId: created.cadenceId },
    });

    await runRules(db, SEED.workspaceId, event());

    // The rule enrolled them; it did not decide the step was permitted. No
    // action row exists, because nothing has been executed.
    expect(await queryAll(db, 'SELECT id FROM cadence_enrollments')).toHaveLength(1);
    expect(await queryAll(db, 'SELECT id FROM actions')).toHaveLength(0);
    expect(newId('ruleRun').startsWith('rrn_')).toBe(true);
  });
});
