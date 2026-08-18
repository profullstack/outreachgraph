/**
 * Running automation rules.
 *
 * A rule can only ever queue work — see `packages/domain/src/rules.ts` for why
 * that is a security boundary rather than a missing feature. This module is
 * the part that reads the rules, decides which fired, and performs the four
 * things a rule is allowed to do.
 *
 * Every firing is recorded, including the ones that did nothing. A rule that
 * matches constantly and is refused every time looks identical to a working
 * rule from a counter, and is the most common way an automation quietly stops
 * mattering.
 */

import {
  dedupeKeyFor,
  newId,
  ruleMatches,
  type AutomationRule,
  type RuleAction,
  type RuleActionConfig,
  type RuleCondition,
  type RuleEvent,
  type RuleTrigger,
  type SignalType,
} from '@outreachgraph/domain';
import { now, queryAll, type Client } from '@outreachgraph/db';
import { enrollInCadence } from './cadence';
import { recordStatus } from './stages';
import { emitEvent } from './events';

export interface RunRulesResult {
  readonly considered: number;
  readonly fired: number;
  readonly applied: number;
  readonly skipped: number;
}

/**
 * Applies every rule that matches one event.
 *
 * Returns a report rather than throwing: one badly configured rule must not
 * cost the others their turn, and an event that matches nothing is the normal
 * case rather than a failure.
 */
export async function runRules(
  db: Client,
  workspaceId: string,
  event: RuleEvent,
): Promise<RunRulesResult> {
  const rules = await loadRules(db, workspaceId, event.trigger);

  let fired = 0;
  let applied = 0;
  let skipped = 0;

  for (const rule of rules) {
    if (!ruleMatches(rule, event)) continue;
    fired += 1;

    const key = dedupeKeyFor(event);

    // Claimed before the work, not after. A crash between doing the work and
    // recording it would otherwise redo the work on the next tick, and the
    // work here is "put a person on an outreach plan".
    const claimed = await claim(db, rule, event, key);
    if (!claimed) {
      skipped += 1;
      continue;
    }

    try {
      const outcome = await apply(db, rule, event);
      await finish(db, rule.id, key, outcome.applied ? 'applied' : 'skipped', outcome.detail);
      if (outcome.applied) applied += 1;
      else skipped += 1;

      await emitEvent(db, {
        workspaceId,
        ...(event.campaignId ? { campaignId: event.campaignId } : {}),
        personId: event.personId,
        phase: 'system',
        level: outcome.applied ? 'info' : 'warn',
        message: `Rule "${rule.name}": ${outcome.detail}`,
        detail: { ruleId: rule.id, action: rule.action },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await finish(db, rule.id, key, 'failed', detail.slice(0, 300));
      skipped += 1;
    }
  }

  return { considered: rules.length, fired, applied, skipped };
}

interface ApplyOutcome {
  readonly applied: boolean;
  readonly detail: string;
}

/**
 * Performs one rule's action.
 *
 * Note what is absent: there is no branch that sends anything. `enroll_cadence`
 * hands the person to the cadence engine, which resolves each step against the
 * capability matrix when it falls due — so a rule cannot decide that a step is
 * permitted, only that it should be considered.
 */
async function apply(db: Client, rule: AutomationRule, event: RuleEvent): Promise<ApplyOutcome> {
  switch (rule.action) {
    case 'enroll_cadence': {
      const cadenceId = rule.config.cadenceId;
      if (!cadenceId) return { applied: false, detail: 'no cadence configured' };

      const campaignId = event.campaignId ?? rule.campaignId;
      if (!campaignId) return { applied: false, detail: 'no campaign to enrol into' };

      const result = await enrollInCadence(db, {
        cadenceId,
        workspaceId: rule.workspaceId,
        campaignId,
        personId: event.personId,
      });

      return result.enrolled
        ? { applied: true, detail: `enrolled on cadence ${cadenceId}` }
        : { applied: false, detail: result.reason };
    }

    case 'suppress': {
      // Always permitted, and deliberately so: this action only ever
      // restricts, so there is nothing for a gate to protect against.
      const suppressionId = newId('suppression');
      await db.execute({
        sql: `INSERT INTO suppression_entries (id, workspace_id, scope, reason, source, created_at)
              VALUES (?, ?, 'workspace', ?, 'automation_rule', ?)`,
        args: [suppressionId, rule.workspaceId, rule.config.reason ?? `rule: ${rule.name}`, now()],
      });
      await db.execute({
        sql: `INSERT INTO suppression_keys (match_key, suppression_id, scope, workspace_id)
              VALUES (?, ?, 'workspace', ?)`,
        args: [`person:${event.personId}`, suppressionId, rule.workspaceId],
      });

      return { applied: true, detail: 'suppressed' };
    }

    case 'set_status': {
      const status = rule.config.status;
      const campaignId = event.campaignId ?? rule.campaignId;
      if (!status || !campaignId) return { applied: false, detail: 'no status or campaign' };

      const moved = await recordStatus(db, {
        workspaceId: rule.workspaceId,
        campaignId,
        personId: event.personId,
        status,
        reason: rule.config.reason ?? `rule: ${rule.name}`,
      });

      return moved.changed
        ? { applied: true, detail: `moved to ${status}` }
        : { applied: false, detail: `already ${status}` };
    }

    case 'notify': {
      // Notifications ride the workflow event stream rather than a second
      // delivery mechanism, so a rule's output appears in the same place the
      // user already watches the pipeline.
      return {
        applied: true,
        detail: rule.config.message ?? `matched "${rule.name}"`,
      };
    }

    default: {
      // Unreachable while `RuleAction` is exhaustive. Fails closed anyway,
      // because a future action arriving here unimplemented must do nothing
      // rather than fall through to something.
      return { applied: false, detail: 'unknown action' };
    }
  }
}

/** Reserves the firing. Returns false when this rule already ran for this event. */
async function claim(
  db: Client,
  rule: AutomationRule,
  event: RuleEvent,
  key: string,
): Promise<boolean> {
  try {
    await db.execute({
      sql: `INSERT INTO rule_runs (id, rule_id, workspace_id, person_id, outcome,
            occurred_at, dedupe_key)
            VALUES (?, ?, ?, ?, 'applied', ?, ?)`,
      args: [newId('ruleRun'), rule.id, rule.workspaceId, event.personId, now(), key],
    });
    return true;
  } catch {
    // The unique index rejected it: this rule has already run for this event.
    return false;
  }
}

async function finish(
  db: Client,
  ruleId: string,
  key: string,
  outcome: string,
  detail: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE rule_runs SET outcome = ?, detail = ? WHERE rule_id = ? AND dedupe_key = ?`,
    args: [outcome, detail.slice(0, 300), ruleId, key],
  });
}

async function loadRules(
  db: Client,
  workspaceId: string,
  trigger: RuleTrigger,
): Promise<readonly AutomationRule[]> {
  const rows = await queryAll<{
    id: string;
    workspace_id: string;
    campaign_id: string | null;
    name: string;
    trigger: string;
    condition_json: string;
    action: string;
    action_json: string;
    enabled: number;
  }>(
    db,
    `SELECT id, workspace_id, campaign_id, name, trigger, condition_json, action,
            action_json, enabled
       FROM automation_rules
      WHERE workspace_id = ? AND trigger = ? AND enabled = 1`,
    [workspaceId, trigger],
  );

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    ...(row.campaign_id ? { campaignId: row.campaign_id } : {}),
    name: row.name,
    trigger: row.trigger as RuleTrigger,
    condition: parse<RuleCondition>(row.condition_json),
    action: row.action as RuleAction,
    config: parse<RuleActionConfig>(row.action_json),
    enabled: row.enabled === 1,
  }));
}

function parse<T>(json: string): T {
  try {
    const value: unknown = JSON.parse(json);
    return (typeof value === 'object' && value !== null ? value : {}) as T;
  } catch {
    return {} as T;
  }
}

// ------------------------------------------------------------------ writing

export interface CreateRuleInput {
  readonly workspaceId: string;
  readonly campaignId?: string | undefined;
  readonly name: string;
  readonly trigger: RuleTrigger;
  readonly condition: RuleCondition;
  readonly action: RuleAction;
  readonly config: RuleActionConfig;
  readonly enabled?: boolean;
}

export async function createRule(db: Client, input: CreateRuleInput): Promise<string> {
  const id = newId('rule');
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO automation_rules (id, workspace_id, campaign_id, name, trigger,
          condition_json, action, action_json, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.workspaceId,
      input.campaignId ?? null,
      input.name.trim(),
      input.trigger,
      JSON.stringify(input.condition),
      input.action,
      JSON.stringify(input.config),
      input.enabled === false ? 0 : 1,
      stamp,
      stamp,
    ],
  });

  return id;
}

export async function setRuleEnabled(
  db: Client,
  workspaceId: string,
  ruleId: string,
  enabled: boolean,
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE automation_rules SET enabled = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
    args: [enabled ? 1 : 0, now(), ruleId, workspaceId],
  });

  return (result.rowsAffected ?? 0) > 0;
}

/** Builds the event a newly stored signal represents. */
export function signalEvent(input: {
  readonly personId: string;
  readonly campaignId?: string | undefined;
  readonly signalId: string;
  readonly signalType: SignalType;
  readonly summary: string;
  readonly relevance: number;
  readonly confidence: number;
}): RuleEvent {
  return {
    trigger: 'signal_received',
    personId: input.personId,
    ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    signalId: input.signalId,
    signalType: input.signalType,
    summary: input.summary,
    relevance: input.relevance,
    confidence: input.confidence,
  };
}
