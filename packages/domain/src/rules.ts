/**
 * Automation rules, as data and arithmetic.
 *
 * The whole point of this module is the `RULE_ACTIONS` list, and specifically
 * what is missing from it: there is no way to express "send this". A rule can
 * enrol somebody on a plan, tell a human, suppress, or move a lead in the
 * funnel — and nothing else.
 *
 * That is not a limitation waiting to be lifted. An action that reaches the
 * wire directly is an action carrying its own opinion about whether it is
 * permitted, and then the product has two policy engines: the deterministic
 * one, and whatever the person adding the feature thought. The second one is
 * quieter and it wins.
 *
 * Routing everything through `enroll_cadence` means a rule can only queue
 * work. Whether that work runs, and whether it runs automatically or as a
 * one-tap human step, remains the capability matrix's decision at the moment
 * the step falls due. A rule cannot automate LinkedIn by being written
 * carelessly because a rule has no vocabulary for it.
 */

import type { SignalType } from './signal';

export const RULE_TRIGGERS = [
  'signal_received',
  'score_crossed',
  'reply_received',
  'stage_changed',
] as const;
export type RuleTrigger = (typeof RULE_TRIGGERS)[number];

/**
 * Everything a rule may do.
 *
 * Read this list as the security boundary it is. Adding `send_email` here
 * would undo the guarantee described above, whatever the implementation did.
 */
export const RULE_ACTIONS = ['enroll_cadence', 'notify', 'suppress', 'set_status'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export interface RuleCondition {
  /** For `signal_received`. */
  readonly signalType?: SignalType;
  readonly minRelevance?: number;
  readonly minConfidence?: number;
  /** Substring match on the signal summary, case-insensitive. */
  readonly contains?: string;
  /** For `score_crossed`. */
  readonly minOpportunity?: number;
  /** For `stage_changed`. */
  readonly toStatus?: string;
}

export interface RuleActionConfig {
  /** For `enroll_cadence`. */
  readonly cadenceId?: string;
  /** For `notify`. */
  readonly message?: string;
  /** For `suppress` and `set_status`. */
  readonly reason?: string;
  readonly status?: string;
}

export interface AutomationRule {
  readonly id: string;
  readonly workspaceId: string;
  readonly campaignId?: string | undefined;
  readonly name: string;
  readonly trigger: RuleTrigger;
  readonly condition: RuleCondition;
  readonly action: RuleAction;
  readonly config: RuleActionConfig;
  readonly enabled: boolean;
}

/** The event a rule is being tested against. */
export interface RuleEvent {
  readonly trigger: RuleTrigger;
  readonly personId: string;
  readonly campaignId?: string | undefined;
  /** For `signal_received`. */
  readonly signalId?: string;
  readonly signalType?: SignalType;
  readonly summary?: string;
  readonly relevance?: number;
  readonly confidence?: number;
  /** For `score_crossed`. */
  readonly opportunity?: number;
  /** For `stage_changed`. */
  readonly toStatus?: string;
}

/**
 * Whether one rule fires for one event.
 *
 * Pure and total: every unspecified condition is simply not checked, so an
 * empty condition matches every event of the right trigger. That is the
 * behaviour a user expects from leaving a filter blank, and it is why the
 * trigger itself is never optional.
 */
export function ruleMatches(rule: AutomationRule, event: RuleEvent): boolean {
  if (!rule.enabled) return false;
  if (rule.trigger !== event.trigger) return false;

  // A campaign-scoped rule never fires for another campaign. A workspace-scoped
  // rule fires for all of them.
  if (rule.campaignId && rule.campaignId !== event.campaignId) return false;

  const condition = rule.condition;

  if (condition.signalType && condition.signalType !== event.signalType) return false;

  if (condition.minRelevance !== undefined) {
    if (event.relevance === undefined || event.relevance < condition.minRelevance) return false;
  }

  if (condition.minConfidence !== undefined) {
    if (event.confidence === undefined || event.confidence < condition.minConfidence) return false;
  }

  if (condition.contains) {
    const haystack = event.summary?.toLowerCase() ?? '';
    if (!haystack.includes(condition.contains.toLowerCase())) return false;
  }

  if (condition.minOpportunity !== undefined) {
    if (event.opportunity === undefined || event.opportunity < condition.minOpportunity) {
      return false;
    }
  }

  if (condition.toStatus && condition.toStatus !== event.toStatus) return false;

  return true;
}

export interface RuleProblem {
  readonly message: string;
}

/**
 * Refuses a rule that cannot do anything, before it is saved.
 *
 * The `enroll_cadence` check is the important one: a rule pointing at no
 * cadence fires happily forever and produces nothing, which is
 * indistinguishable from a rule that is not firing at all.
 */
export function validateRule(rule: {
  readonly name: string;
  readonly trigger: string;
  readonly action: string;
  readonly config: RuleActionConfig;
}): readonly RuleProblem[] {
  const problems: RuleProblem[] = [];

  if (!rule.name.trim()) problems.push({ message: 'A rule needs a name.' });

  if (!(RULE_TRIGGERS as readonly string[]).includes(rule.trigger)) {
    problems.push({ message: `"${rule.trigger}" is not a trigger we know.` });
  }

  if (!(RULE_ACTIONS as readonly string[]).includes(rule.action)) {
    problems.push({
      message:
        `"${rule.action}" is not something a rule may do. ` +
        `A rule may only queue work: ${RULE_ACTIONS.join(', ')}.`,
    });
  }

  if (rule.action === 'enroll_cadence' && !rule.config.cadenceId) {
    problems.push({ message: 'Enrolling needs a cadence to enrol onto.' });
  }

  if (rule.action === 'set_status' && !rule.config.status) {
    problems.push({ message: 'Setting a status needs a status.' });
  }

  return problems;
}

/**
 * The key that makes a firing happen once.
 *
 * Built from the rule, the person and the specific occurrence — a signal id
 * where there is one, otherwise the trigger and a caller-supplied discriminator.
 * Without this, re-running the signal sweep re-enrols everybody it already
 * enrolled, every tick, for as long as the signal stays fresh.
 */
export function dedupeKeyFor(event: RuleEvent, discriminator?: string): string {
  const occurrence = event.signalId ?? discriminator ?? event.toStatus ?? 'once';
  return `${event.trigger}:${event.personId}:${occurrence}`;
}
