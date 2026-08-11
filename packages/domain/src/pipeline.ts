/**
 * The prospect state machine (PRD §8).
 *
 * Transitions are declared here rather than scattered across services so an
 * invalid move is a type-level and runtime error in one place, and so the
 * worker can resume a prospect from whatever state it crashed in.
 */

export const PROSPECT_STATUS = [
  'discovered',
  'enriching',
  'resolved',
  'researching',
  'qualified',
  'unqualified',
  'recommended',
  'awaiting_approval',
  'approved',
  'executed',
  'waiting',
  'responded',
  'qualified_opportunity',
  'not_interested',
  'suppressed',
  'error',
] as const;

export type ProspectStatus = (typeof PROSPECT_STATUS)[number];

export function isProspectStatus(value: unknown): value is ProspectStatus {
  return typeof value === 'string' && (PROSPECT_STATUS as readonly string[]).includes(value);
}

/**
 * Allowed forward transitions. `suppressed` and `error` are reachable from
 * anywhere and so are handled separately rather than repeated in every row.
 */
const TRANSITIONS: Readonly<Record<ProspectStatus, readonly ProspectStatus[]>> = {
  discovered: ['enriching', 'unqualified'],
  enriching: ['resolved', 'unqualified'],
  resolved: ['researching', 'unqualified'],
  researching: ['qualified', 'unqualified'],
  qualified: ['recommended', 'researching', 'unqualified'],
  unqualified: ['researching'],
  recommended: ['awaiting_approval', 'approved', 'qualified'],
  awaiting_approval: ['approved', 'qualified', 'not_interested'],
  approved: ['executed', 'qualified'],
  executed: ['waiting', 'responded'],
  waiting: ['responded', 'researching', 'not_interested'],
  responded: ['qualified_opportunity', 'not_interested', 'qualified'],
  qualified_opportunity: ['not_interested'],
  not_interested: [],
  suppressed: [],
  error: ['discovered', 'enriching', 'resolved', 'researching'],
};

/** Reachable from any state — a person can opt out at any point (PRD §6.6). */
const ALWAYS_REACHABLE: readonly ProspectStatus[] = ['suppressed', 'error'];

/** Once here, a prospect never re-enters the pipeline without an explicit reset. */
const TERMINAL: readonly ProspectStatus[] = ['suppressed', 'not_interested'];

export function isTerminalStatus(status: ProspectStatus): boolean {
  return TERMINAL.includes(status);
}

export function canTransition(from: ProspectStatus, to: ProspectStatus): boolean {
  if (from === to) return true;
  // Suppression outranks everything, including terminal states.
  if (to === 'suppressed') return true;
  if (isTerminalStatus(from)) return false;
  if (ALWAYS_REACHABLE.includes(to)) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ProspectStatus, to: ProspectStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal prospect transition: ${from} -> ${to}`);
  }
}

export function nextStatuses(from: ProspectStatus): readonly ProspectStatus[] {
  if (isTerminalStatus(from)) return from === 'suppressed' ? [] : ['suppressed'];
  return [...new Set([...TRANSITIONS[from], ...ALWAYS_REACHABLE])];
}

/** Statuses where the prospect is waiting on a human in the approval queue. */
export function needsHumanAttention(status: ProspectStatus): boolean {
  return status === 'awaiting_approval' || status === 'responded';
}
