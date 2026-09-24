/**
 * Hand-off cards: the product's answer for everything it may not do itself.
 *
 * Production's approval queue held 200 cards and "approve all" could approve
 * none of them: 175 were LinkedIn engagement ("Automated engagement is
 * prohibited") and 25 were X replies with no connected account. Both are
 * `manual_only`, which the approve route treated exactly like `deny`, so the
 * only thing a reviewer could do with a card the product could not send was
 * skip it. The work the product exists to set up never reached a human.
 *
 * A `manual_only` decision is not a refusal. It means "a person must press the
 * button", so approving one now produces a card that makes pressing it take
 * about thirty seconds from a phone: the exact words to paste, a link to the
 * exact post or profile, a few numbered steps, and "Mark done".
 */

import { INTERNAL_ACTION_KINDS, type ActionKind, type Network } from '@outreachgraph/domain';
import { queryAll, type Client } from '@outreachgraph/db';
import { resolveContactAddress } from './repository';

/**
 * The gates whose `manual_only` means "a human can do this", as opposed to one
 * that happens to share the decision.
 *
 * Only these two: the capability matrix saying the network forbids automation,
 * and an API-capable network with no account connected. Every prohibition on
 * contacting the person (suppressed, deleted, believed a minor), every rate
 * limit and the budget answer `deny`, which stays a refusal — a hand-off card
 * is a way to do permitted work by hand, never a way around a "no".
 */
export const HANDOFF_GATES: readonly string[] = ['capability_mode', 'no_connected_account'];

/** True when a policy result should become a hand-off card rather than a hold. */
export function isHandoffDecision(decision: { decision: string; gate?: string | undefined }) {
  return (
    decision.decision === 'manual_only' &&
    decision.gate !== undefined &&
    HANDOFF_GATES.includes(decision.gate)
  );
}

/** What the card shows. Everything a phone needs, nothing it has to look up. */
export interface Handoff {
  readonly actionId: string;
  readonly recommendationId: string;
  readonly personId: string;
  readonly personName: string;
  readonly network: string;
  readonly action: string;
  /** Ready to paste. Empty when nothing was drafted; the card still works. */
  readonly text: string;
  /** Where to go and do it. Absent only when we know no URL for this person. */
  readonly openUrl?: string;
  /** Label for the open button: "Open the post", "Open the profile". */
  readonly openLabel: string;
  readonly steps: readonly string[];
  readonly reason: string;
  readonly createdAt: string;
}

/** The raw facts a hand-off is built from. */
export interface HandoffFacts {
  readonly actionId: string;
  readonly recommendationId: string;
  readonly personId: string;
  readonly personName: string;
  readonly network: string;
  readonly action: string;
  readonly text: string | null;
  readonly signalUrl: string | null;
  readonly profileUrl: string | null;
  readonly handle: string | null;
  readonly email?: string | undefined;
  readonly subject?: string | null;
  readonly reason: string;
  readonly createdAt: string;
}

/**
 * Actions that act on a person rather than on something they wrote.
 *
 * For these the profile is the place to go even when a post triggered the
 * card: you follow or message a person from their profile, not from a post.
 */
const PROFILE_ACTIONS: readonly string[] = ['follow', 'connect', 'send_dm'];

/** Actions a hand-off can describe. Research and bookkeeping never reach a human. */
const HANDOFF_ACTIONS: readonly ActionKind[] = [
  'follow',
  'like',
  'reply',
  'comment',
  'connect',
  'send_dm',
  'send_email',
];

/**
 * A profile URL from a handle, for identities discovered without one.
 *
 * Most identity rows carry `profile_url`, but plenty were written from a
 * handle alone; a card with no Open button is a card that takes three minutes
 * instead of thirty seconds.
 */
export function profileUrlFromHandle(network: string, handle: string): string | undefined {
  const bare = handle.trim().replace(/^@/, '');
  if (!bare) return undefined;
  if (/^https?:\/\//i.test(bare)) return bare;

  switch (network as Network) {
    case 'x':
      return `https://x.com/${encodeURIComponent(bare)}`;
    case 'linkedin':
      return `https://www.linkedin.com/in/${encodeURIComponent(bare)}`;
    case 'github':
      return `https://github.com/${encodeURIComponent(bare)}`;
    case 'bluesky':
      return `https://bsky.app/profile/${encodeURIComponent(bare)}`;
    case 'reddit':
      return `https://www.reddit.com/user/${encodeURIComponent(bare)}`;
    case 'youtube':
      return `https://www.youtube.com/@${encodeURIComponent(bare)}`;
    case 'instagram':
      return `https://www.instagram.com/${encodeURIComponent(bare)}`;
    case 'mastodon': {
      // user@instance, the only form that says where the account lives.
      const [user, host] = bare.split('@');
      return user && host ? `https://${host}/@${encodeURIComponent(user)}` : undefined;
    }
    default:
      return undefined;
  }
}

/** Builds the card from its facts. Pure, so the wording is testable. */
export function describeHandoff(facts: HandoffFacts): Handoff {
  const text = facts.text ?? '';
  const profile =
    facts.profileUrl ??
    (facts.handle ? profileUrlFromHandle(facts.network, facts.handle) : undefined);

  let openUrl: string | undefined;
  let openLabel: string;

  if (facts.network === 'email' || facts.action === 'send_email') {
    openUrl = facts.email ? mailto(facts.email, facts.subject ?? undefined, text) : undefined;
    openLabel = 'Open your mail app';
  } else if (PROFILE_ACTIONS.includes(facts.action)) {
    openUrl = profile ?? facts.signalUrl ?? undefined;
    openLabel = profile ? 'Open the profile' : 'Open the post';
  } else {
    openUrl = facts.signalUrl ?? profile ?? undefined;
    openLabel = facts.signalUrl ? 'Open the post' : 'Open the profile';
  }

  return {
    actionId: facts.actionId,
    recommendationId: facts.recommendationId,
    personId: facts.personId,
    personName: facts.personName,
    network: facts.network,
    action: facts.action,
    text,
    ...(openUrl ? { openUrl } : {}),
    openLabel,
    steps: stepsFor(facts.action, facts.network, text.length > 0, openLabel),
    reason: facts.reason,
    createdAt: facts.createdAt,
  };
}

/** Two to four steps, in the words of the network's own buttons. */
function stepsFor(action: string, network: string, hasText: boolean, openLabel: string): string[] {
  const open = `${openLabel}.`;
  const done = 'Press Mark done.';

  switch (action) {
    case 'reply':
    case 'comment':
      return hasText
        ? [open, `Paste the ${action} and post it.`, done]
        : [open, `Write a short ${action} and post it.`, done];
    case 'like':
      return [open, network === 'linkedin' ? 'Press Like.' : 'Like it.', done];
    case 'follow':
      return [open, 'Press Follow.', done];
    case 'connect':
      return hasText
        ? [open, 'Press Connect, then Add a note.', 'Paste the note and send.', done]
        : [open, 'Press Connect.', done];
    case 'send_dm':
      return hasText
        ? [open, 'Press Message.', 'Paste the message and send.', done]
        : [open, 'Press Message, write a short note and send.', done];
    case 'send_email':
      return hasText
        ? [open, 'Check the message and send it.', done]
        : [open, 'Write it and send.', done];
    default:
      return [open, 'Do what the card says.', done];
  }
}

function mailto(address: string, subject: string | undefined, body: string): string {
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  const query = params.toString().replace(/\+/g, '%20');
  return `mailto:${address}${query ? `?${query}` : ''}`;
}

interface HandoffRow {
  action_id: string;
  recommendation_id: string;
  person_id: string;
  display_name: string;
  kind: string;
  network: string;
  action_body: string | null;
  draft_body: string | null;
  draft_subject: string | null;
  signal_url: string | null;
  profile_url: string | null;
  handle: string | null;
  reason: string;
  created_at: string;
}

/**
 * Pending hand-offs for a workspace, oldest first.
 *
 * "Pending" is a manual action still `queued`. Narrowed to the actions a human
 * can do because the same shape is written by auto-approval for research —
 * internal `manual` rows production has in the thousands, none of which is a
 * thing anyone should be asked to open a tab for.
 *
 * The text prefers the action's own body (what was approved, including any
 * edit) and falls back to the current draft, so a card approved before its
 * draft was written picks the wording up once it exists.
 */
export async function listHandoffs(
  db: Client,
  workspaceId: string,
  options: { readonly limit: number; readonly actionId?: string },
): Promise<Handoff[]> {
  const kinds = HANDOFF_ACTIONS.filter(
    (kind) => !(INTERNAL_ACTION_KINDS as readonly string[]).includes(kind),
  );
  const placeholders = kinds.map(() => '?').join(', ');
  const one = options.actionId ? 'AND a.id = ?' : '';

  const rows = await queryAll<HandoffRow>(
    db,
    `SELECT a.id AS action_id, a.recommendation_id, a.person_id, a.kind, a.network,
            a.body AS action_body, a.created_at,
            p.display_name, r.reason,
            s.source_url AS signal_url,
            (SELECT d.body FROM drafts d WHERE d.recommendation_id = a.recommendation_id
              ORDER BY d.updated_at DESC LIMIT 1) AS draft_body,
            (SELECT d.subject FROM drafts d WHERE d.recommendation_id = a.recommendation_id
              ORDER BY d.updated_at DESC LIMIT 1) AS draft_subject,
            (SELECT si.profile_url FROM social_identities si
              WHERE si.person_id = a.person_id AND si.network = a.network
                AND si.profile_url IS NOT NULL AND trim(si.profile_url) <> ''
              ORDER BY si.confidence DESC LIMIT 1) AS profile_url,
            (SELECT si.handle FROM social_identities si
              WHERE si.person_id = a.person_id AND si.network = a.network
                AND si.handle IS NOT NULL AND trim(si.handle) <> ''
              ORDER BY si.confidence DESC LIMIT 1) AS handle
       FROM actions a
       JOIN recommendations r ON r.id = a.recommendation_id
       JOIN people p ON p.id = a.person_id
  LEFT JOIN signals s ON s.id = r.trigger_signal_id
      WHERE a.workspace_id = ? AND a.mode = 'manual' AND a.status = 'queued'
        AND a.kind IN (${placeholders}) ${one}
   ORDER BY a.created_at ASC
      LIMIT ?`,
    [workspaceId, ...kinds, ...(options.actionId ? [options.actionId] : []), options.limit],
  );

  const handoffs: Handoff[] = [];

  for (const row of rows) {
    // Only email needs a lookup, and only one per card; social rows carry
    // everything in the query above.
    const email =
      row.network === 'email' ? await resolveContactAddress(db, row.person_id) : undefined;

    handoffs.push(
      describeHandoff({
        actionId: row.action_id,
        recommendationId: row.recommendation_id,
        personId: row.person_id,
        personName: row.display_name,
        network: row.network,
        action: row.kind,
        text: row.action_body ?? row.draft_body,
        signalUrl: row.signal_url,
        profileUrl: row.profile_url,
        handle: row.network === 'email' ? null : row.handle,
        email: email?.address,
        subject: row.draft_subject,
        reason: row.reason,
        createdAt: row.created_at,
      }),
    );
  }

  return handoffs;
}
