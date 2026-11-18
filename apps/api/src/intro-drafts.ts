/**
 * Boardy-style introductions that run themselves (PRD §38, "auto-draft").
 *
 * The consent rule of §38 stands: a member is shown to other members only
 * after their own click. What changes is everything around that click:
 *
 *   - **Drafts.** Every member gets a card written for them from their
 *     profile and their products (`draftIntroCard`), kept closed. While it is
 *     still the draft (`auto_drafted`) it is rewritten as their products
 *     change; the first edit of their own makes it theirs.
 *   - **A count before the click.** A closed card is matched against open and
 *     drafted cards, but only the number comes back ("4 members look like a
 *     fit"): no name, no text, nothing of anybody who has not said yes.
 *   - **Weekly match email.** Closed: the count and a link to turn the card
 *     on. Open: the top three open matches and pending requests. Off with one
 *     toggle (`mail_off`).
 *   - **Request and accept email.** The asked member hears about a request;
 *     both hear about an acceptance, with the other's address.
 */

import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  cleanIntroTopics,
  draftIntroCard,
  newId,
  rankIntroMatches,
  type IntroCard,
  type IntroCardDraft,
} from '@outreachgraph/domain';
import { mailBody, promoFor, sendSafely, type CalendarOptions } from './crm';
import { blockedWith, findIntroMatches, linkedWith } from './intros';

const DAY_MS = 86_400_000;

/** Platform mail: sent from the system workspace's own mailbox. */
export interface IntroMailOptions extends CalendarOptions {
  /** The workspace whose connected mailbox sends member notifications. */
  readonly systemWorkspaceId?: string | undefined;
}

function parseJsonList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

interface MemberRow {
  id: string;
  email: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  job_title: string | null;
  company_domain: string | null;
  card_id: string | null;
  display_name: string | null;
  headline: string | null;
  looking_for: string | null;
  can_offer: string | null;
  topics: string | null;
}

function sameDraft(row: MemberRow, draft: IntroCardDraft): boolean {
  return (
    row.display_name === draft.displayName &&
    row.headline === draft.headline &&
    row.looking_for === draft.lookingFor &&
    row.can_offer === draft.canOffer &&
    (row.topics ?? '[]') === JSON.stringify(draft.topics)
  );
}

/**
 * Writes or refreshes the draft card of every member whose card is missing or
 * still an untouched, closed draft. Never opens a card, never touches one the
 * member wrote. Returns how many cards were written.
 */
export async function draftIntroCards(db: Client): Promise<number> {
  const members = await queryAll<MemberRow>(
    db,
    `SELECT u.id, u.email, u.name, up.first_name, up.last_name, up.job_title, up.company_domain,
       ic.id AS card_id, ic.display_name, ic.headline, ic.looking_for, ic.can_offer, ic.topics
     FROM users u
       JOIN (SELECT DISTINCT user_id FROM organization_members) m ON m.user_id = u.id
       LEFT JOIN user_profiles up ON up.user_id = u.id
       LEFT JOIN intro_cards ic ON ic.user_id = u.id
     WHERE ic.id IS NULL OR (ic.auto_drafted = 1 AND ic.is_open = 0)
     LIMIT 1000`,
  );

  let written = 0;
  for (const member of members) {
    const offerings = await queryAll<{
      name: string;
      category: string | null;
      description: string | null;
      value_propositions: string | null;
      likely_pains: string | null;
    }>(
      db,
      `SELECT o.name, o.category, o.description, o.value_propositions, o.likely_pains
       FROM offerings o
         JOIN workspaces w ON w.id = o.workspace_id
         JOIN organization_members m ON m.organization_id = w.organization_id
       WHERE m.user_id = ?
       ORDER BY o.created_at ASC LIMIT 4`,
      [member.id],
    );
    const draft = draftIntroCard({
      name: member.name,
      email: member.email,
      firstName: member.first_name,
      lastName: member.last_name,
      jobTitle: member.job_title,
      companyDomain: member.company_domain,
      offerings: offerings.map((o) => ({
        name: o.name,
        category: o.category,
        description: o.description,
        valuePropositions: parseJsonList(o.value_propositions),
        likelyPains: parseJsonList(o.likely_pains),
      })),
    });
    // Nothing to offer means nothing worth drafting yet.
    if (!draft.canOffer || !draft.displayName) continue;
    if (member.card_id && sameDraft(member, draft)) continue;

    const stamp = now();
    if (member.card_id) {
      await db.execute({
        sql: `UPDATE intro_cards SET display_name = ?, headline = ?, looking_for = ?,
                can_offer = ?, topics = ?, updated_at = ?
              WHERE id = ? AND auto_drafted = 1 AND is_open = 0`,
        args: [
          draft.displayName,
          draft.headline,
          draft.lookingFor,
          draft.canOffer,
          JSON.stringify(draft.topics),
          stamp,
          member.card_id,
        ],
      });
    } else {
      await db.execute({
        sql: `INSERT INTO intro_cards (id, user_id, is_open, display_name, headline, looking_for,
                can_offer, topics, opened_at, created_at, updated_at, auto_drafted)
              VALUES (?, ?, 0, ?, ?, ?, ?, ?, NULL, ?, ?, 1)
              ON CONFLICT DO NOTHING`,
        args: [
          newId('introCard'),
          member.id,
          draft.displayName,
          draft.headline,
          draft.lookingFor,
          draft.canOffer,
          JSON.stringify(draft.topics),
          stamp,
          stamp,
        ],
      });
    }
    written += 1;
  }
  return written;
}

interface PoolRow {
  id: string;
  user_id: string;
  display_name: string;
  headline: string;
  looking_for: string;
  can_offer: string;
  topics: string;
}

function toCard(row: PoolRow): IntroCard {
  let topics: string[] = [];
  try {
    topics = cleanIntroTopics(JSON.parse(row.topics));
  } catch {
    topics = [];
  }
  return {
    id: row.id,
    displayName: row.display_name,
    headline: row.headline,
    lookingFor: row.looking_for,
    canOffer: row.can_offer,
    topics,
  };
}

/**
 * How many members look like a fit for this member's card, open or not.
 *
 * Counted against open cards and untouched drafts. Only the number leaves
 * here: a draft is never shown to anybody, and this is how a member learns
 * whether switching on is worth it.
 */
export async function previewMatchCount(db: Client, userId: string): Promise<number> {
  const own = await queryOne<PoolRow>(
    db,
    `SELECT id, user_id, display_name, headline, looking_for, can_offer, topics
     FROM intro_cards WHERE user_id = ?`,
    [userId],
  );
  if (!own) return 0;
  const [blocked, linked] = await Promise.all([blockedWith(db, userId), linkedWith(db, userId)]);
  const pool = await queryAll<PoolRow>(
    db,
    `SELECT id, user_id, display_name, headline, looking_for, can_offer, topics
     FROM intro_cards
     WHERE user_id <> ? AND (is_open = 1 OR auto_drafted = 1)
     ORDER BY updated_at DESC LIMIT 2000`,
    [userId],
  );
  const candidates = pool
    .filter((row) => !blocked.has(row.user_id) && !linked.has(row.user_id))
    .map(toCard);
  return rankIntroMatches(toCard(own), candidates, 50).length;
}

function appBase(options: IntroMailOptions): string {
  return (options.appUrl ?? 'http://localhost:8080').replace(/\/$/, '');
}

async function sendToMember(
  db: Client,
  options: IntroMailOptions,
  to: string,
  subject: string,
  lines: (string | null)[],
  links: [string, string][],
  key: string,
): Promise<boolean> {
  const body = mailBody(lines, links);
  const promo = await promoFor(to);
  const off = `${appBase(options)}/intros#mail`;
  return sendSafely(
    { db, options, workspaceId: options.systemWorkspaceId ?? 'system' },
    {
      to,
      subject,
      text: `${body.text}\n\nStop these emails: ${off}${promo.text ? `\n\n${promo.text}` : ''}`,
      html: `${body.html}\n<p style="font-size:12px"><a href="${off}">Stop these emails</a></p>${promo.html ? `\n${promo.html}` : ''}`,
      kind: 'transactional',
      idempotencyKey: key,
    },
  );
}

/**
 * The weekly match email, at most once a week per member, and only when
 * there is something to say. Returns how many went out.
 */
export async function sendIntroDigests(
  db: Client,
  options: IntroMailOptions & { readonly now?: Date },
): Promise<number> {
  const at = options.now ?? new Date();
  const weekAgo = new Date(at.getTime() - 7 * DAY_MS).toISOString();
  const members = await queryAll<{
    user_id: string;
    email: string;
    is_open: number | bigint;
    display_name: string;
  }>(
    db,
    `SELECT ic.user_id, u.email, ic.is_open, ic.display_name
     FROM intro_cards ic JOIN users u ON u.id = ic.user_id
     WHERE ic.mail_off = 0 AND u.email_verified_at IS NOT NULL
       AND (ic.match_mailed_at IS NULL OR ic.match_mailed_at < ?)
     ORDER BY ic.match_mailed_at ASC LIMIT 200`,
    [weekAgo],
  );

  let sent = 0;
  const week = at.toISOString().slice(0, 10);
  for (const member of members) {
    const link = `${appBase(options)}/intros`;
    const pending = await queryOne<{ n: number | bigint }>(
      db,
      `SELECT COUNT(*) AS n FROM intro_requests
       WHERE target_user_id = ? AND status = 'pending' AND expires_at > ?`,
      [member.user_id, at.toISOString()],
    );
    const waiting = Number(pending?.n ?? 0);
    let subject: string;
    let lines: (string | null)[];
    if (Number(member.is_open) === 1) {
      const matches = await findIntroMatches(db, member.user_id, 3).catch(() => []);
      if (matches.length === 0 && waiting === 0) continue;
      subject =
        waiting > 0
          ? `${String(waiting)} intro request(s) waiting for you`
          : `${String(matches.length)} people worth meeting this week`;
      lines = [
        `Hi ${member.display_name},`,
        '',
        waiting > 0 ? `${String(waiting)} member(s) asked to be introduced to you.` : null,
        matches.length > 0 ? 'People worth meeting this week:' : null,
        ...matches.map((m) => `- ${m.card.displayName}: ${m.card.headline || m.card.canOffer}`),
      ];
    } else {
      const count = await previewMatchCount(db, member.user_id);
      if (count === 0) continue;
      subject =
        count === 1
          ? '1 member looks like a fit for you'
          : `${String(count)} members look like a fit for you`;
      lines = [
        `Hi ${member.display_name},`,
        '',
        `We wrote you an intro card from your profile and products, and ${String(count)} OutreachGraph members look like a fit.`,
        'It is off: nobody sees it until you turn it on. Check the wording, then one click puts you in front of them. Every introduction still needs both sides to say yes.',
      ];
    }
    const delivered = await sendToMember(
      db,
      options,
      member.email,
      subject,
      lines,
      [['Open your intros', link]],
      `intro-digest:${member.user_id}:${week}`,
    );
    if (delivered) {
      await db.execute({
        sql: 'UPDATE intro_cards SET match_mailed_at = ? WHERE user_id = ?',
        args: [at.toISOString(), member.user_id],
      });
      sent += 1;
    }
  }
  return sent;
}

async function memberEmail(db: Client, userId: string): Promise<string | undefined> {
  const row = await queryOne<{ email: string }>(db, 'SELECT email FROM users WHERE id = ?', [
    userId,
  ]);
  return row?.email;
}

/** The asked member hears about a request. */
export async function mailIntroRequested(
  db: Client,
  options: IntroMailOptions,
  request: { id: string; note: string; card: IntroCard; targetUserId: string },
): Promise<void> {
  const to = await memberEmail(db, request.targetUserId);
  if (!to) return;
  await sendToMember(
    db,
    options,
    to,
    `${request.card.displayName} would like an introduction`,
    [
      `${request.card.displayName}${request.card.headline ? `, ${request.card.headline}` : ''}, asked to be introduced to you.`,
      `Their note: ${request.note}`,
      'Accept and you both get each other’s email. Decline and they are not told.',
    ],
    [['Answer the request', `${appBase(options)}/intros`]],
    `intro-request:${request.id}`,
  );
}

/** Both sides hear about an acceptance, each with the other's address. */
export async function mailIntroAccepted(
  db: Client,
  options: IntroMailOptions,
  request: { id: string; requesterUserId: string; targetUserId: string },
): Promise<void> {
  const [a, b] = await Promise.all([
    queryOne<{ email: string; display_name: string | null }>(
      db,
      `SELECT u.email, ic.display_name FROM users u LEFT JOIN intro_cards ic ON ic.user_id = u.id
       WHERE u.id = ?`,
      [request.requesterUserId],
    ),
    queryOne<{ email: string; display_name: string | null }>(
      db,
      `SELECT u.email, ic.display_name FROM users u LEFT JOIN intro_cards ic ON ic.user_id = u.id
       WHERE u.id = ?`,
      [request.targetUserId],
    ),
  ]);
  if (!a || !b) return;
  for (const [me, them, side] of [
    [a, b, 'requester'],
    [b, a, 'target'],
  ] as const) {
    await sendToMember(
      db,
      options,
      me.email,
      `You're introduced: ${them.display_name ?? them.email}`,
      [
        `${them.display_name ?? 'They'} and you both said yes.`,
        `Reach them at ${them.email}. A short hello with why you wanted to meet goes a long way.`,
      ],
      [['Your intros', `${appBase(options)}/intros`]],
      `intro-accepted:${request.id}:${side}`,
    );
  }
}
