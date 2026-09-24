/**
 * What a reply means, decided by rules before anything asks a model.
 *
 * A reply used to be one fact — "this address wrote back" — and that was
 * enough to stop cold outreach and nothing else. The eight labels below are
 * what the inbox, the auto-reply drafter and the suppression path each need to
 * know, and they are not equally dangerous to get wrong:
 *
 *   - `unsubscribe_request` **acts**: it suppresses the person. So it is only
 *     ever acted on when one of the phrases below matched. A model that thinks
 *     someone asked to stop gets a card for a human, never a tombstone.
 *   - `out_of_office` and `bounce` **do not count as a reply**. Treating a
 *     robot as an answer permanently removes a prospect from outreach on the
 *     strength of an autoresponder, which is silent and never noticed.
 *   - `interested`, `question` and `referral` are the ones worth a drafted
 *     answer, and the only two a machine may ever answer on its own are
 *     `interested` and `question` (see `@outreachgraph/policy`'s
 *     `decideAutoReply`).
 *
 * Everything here is pure and deterministic: same text in, same label out.
 * Rules win because they are auditable — "the subject began Automatic reply:"
 * can be read back and argued with, and "the model was 0.91 sure" cannot.
 */

export const REPLY_LABELS = [
  'interested',
  'not_interested',
  'question',
  'out_of_office',
  'unsubscribe_request',
  'referral',
  'bounce',
  'other',
] as const;

export type ReplyLabel = (typeof REPLY_LABELS)[number];

export function isReplyLabel(value: unknown): value is ReplyLabel {
  return typeof value === 'string' && (REPLY_LABELS as readonly string[]).includes(value);
}

/** Who decided a label. Only a `rule` label may take an irreversible action. */
export type ReplyLabelSource = 'rule' | 'model' | 'unclassified';

/**
 * How a campaign answers replies.
 *
 * `copilot` is the default for the same reason human approval is the default
 * everywhere else: a drafted answer waits on a card. `autonomous` is a request,
 * not a permission — it only sends when every gate in `decideAutoReply` holds,
 * and anything short of that falls back to `copilot`.
 */
export const AUTO_REPLY_MODES = ['off', 'copilot', 'autonomous'] as const;
export type AutoReplyMode = (typeof AUTO_REPLY_MODES)[number];

export function isAutoReplyMode(value: unknown): value is AutoReplyMode {
  return typeof value === 'string' && (AUTO_REPLY_MODES as readonly string[]).includes(value);
}

/** Labels worth a drafted answer. A `not_interested` gets none: answering it is pestering. */
export const DRAFTABLE_REPLY_LABELS: readonly ReplyLabel[] = ['interested', 'question', 'referral'];

/** Labels that are a machine talking, which must never count as a human reply. */
export const AUTOMATED_REPLY_LABELS: readonly ReplyLabel[] = ['out_of_office', 'bounce'];

export const DEFAULT_AUTO_REPLY_THRESHOLD = 0.85;

export interface ReplyClassification {
  readonly label: ReplyLabel;
  /** 0–1. A rule is sure by construction; a model says how sure it is. */
  readonly confidence: number;
  readonly source: ReplyLabelSource;
  /** Why, in words a reviewer can check against the message. */
  readonly reason: string;
}

export interface ReplyRuleInput {
  readonly subject?: string | undefined;
  readonly body?: string | undefined;
  /** What the mail headers already said, from `classifyAutomated`. */
  readonly automated?: 'auto_reply' | 'bounce' | 'bulk' | undefined;
}

/**
 * Subject lines autoresponders write. Anchored at the start, because "Re: out
 * of office next week?" from a person is a question about an absence, not one.
 */
const OOO_SUBJECTS: readonly RegExp[] = [
  /^\s*(?:automatic reply|auto(?:matic)?[- ]?reply|autoreply|auto-response|autosvar|réponse automatique|abwesenheitsnotiz|respuesta automática)\b/i,
  /^\s*out of (?:the )?office\b/i,
  /^\s*(?:ooo|away)\s*[:\-–]/i,
  /^\s*auto:/i,
];

/** Body phrases an absence notice uses. Only trusted on a short, question-free body. */
const OOO_PHRASES: readonly RegExp[] = [
  /\b(?:i am|i'm|i’m)\s+(?:currently\s+)?(?:out of (?:the )?office|away from (?:the|my) (?:office|desk)|on (?:annual |parental |maternity |paternity )?leave|on (?:vacation|holiday))\b/i,
  /\b(?:i will|i'll|i’ll)\s+be\s+(?:back|returning)\b.*\b(?:on|after|from)\b/i,
  /\blimited (?:access to (?:my )?)?e-?mail\b/i,
  /\bthis is an automat(?:ed|ic) (?:reply|response|message)\b/i,
];

const BOUNCE_SUBJECTS: readonly RegExp[] = [
  /^\s*(?:undeliverable|undelivered mail|delivery status notification \(failure\)|mail delivery failed|returned mail|failure notice|delivery failure|message not delivered|mail delivery subsystem)(?![a-z])/i,
];

const BOUNCE_PHRASES: readonly RegExp[] = [
  /^final-recipient:/im,
  /\b5\.1\.[0-9]\b/,
  /\b550[ -]5\.\d\.\d\b/,
  /\b(?:address|recipient) not found\b/i,
  /\buser (?:unknown|not found)\b/i,
  /\bmailbox (?:unavailable|does not exist|not found)\b/i,
  /\bno such user\b/i,
];

/**
 * Phrases that mean "stop". These suppress without a human, so each one is
 * a request addressed to us rather than a word that merely appears: "remove
 * me", not "remove"; "unsubscribe" only when it is most of what they wrote.
 */
const UNSUBSCRIBE_PHRASES: readonly RegExp[] = [
  /\b(?:please\s+)?(?:remove|delete|take)\s+me\s+(?:from|off)\b/i,
  /\bstop\s+(?:emailing|e-mailing|contacting|messaging|mailing|writing to|sending)\s+(?:me|us)\b/i,
  /\b(?:do not|don't|don’t)\s+(?:contact|email|e-mail|message|write to)\s+(?:me|us)\b/i,
  /\b(?:opt|count)\s+me\s+out\b/i,
  /\bno more (?:emails|e-mails|messages)\b/i,
  /\bunsubscribe\s+me\b/i,
];

/** A bare "Unsubscribe" reply: short enough that the word is the message. */
const BARE_UNSUBSCRIBE = /^\W*(?:please\s+)?unsubscribe\W*(?:please|thanks|thank you)?\W*$/i;

/**
 * Only what they wrote this time.
 *
 * Replies carry our own message beneath them, and our message carries an
 * unsubscribe line. Without this every reply to us would read as an
 * unsubscribe request — the footer is quoted back by every mail client there
 * is. Cut at the first quote marker, whichever kind the client used.
 */
export function newReplyText(body: string | undefined): string {
  if (!body) return '';

  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // "On Tue, 2 Sep 2026 at 10:00, Ada <ada@x> wrote:" — Gmail, Apple Mail, Thunderbird.
    if (/^on\b.*\bwrote:?\s*$/i.test(trimmed)) break;
    // Outlook's separators.
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(trimmed)) break;
    if (/^_{8,}$/.test(trimmed)) break;
    if (/^from:\s.+/i.test(trimmed) && kept.length > 0) break;
    // Our own footer, if a client quoted it without a marker.
    if (/^don't want these\? unsubscribe/i.test(trimmed)) break;
    if (trimmed.startsWith('>')) continue;
    kept.push(line);
  }

  return kept.join('\n').trim();
}

/**
 * The deterministic pass. Returns undefined when no rule is sure, which is the
 * signal to ask a model — never a guess dressed up as a rule.
 *
 * Order matters and is fixed: a bounce is checked before an absence because a
 * DSN often quotes the original's "out of office" text, and an unsubscribe is
 * checked last among the rules because an autoresponder that happens to say
 * "do not email me at this address" is still an autoresponder.
 */
export function classifyReplyByRules(input: ReplyRuleInput): ReplyClassification | undefined {
  const subject = input.subject?.trim() ?? '';
  const fresh = newReplyText(input.body);

  if (input.automated === 'bounce') {
    return rule('bounce', 'the mail headers identify a delivery failure notice');
  }
  const bounceSubject = BOUNCE_SUBJECTS.find((pattern) => pattern.test(subject));
  if (bounceSubject) {
    return rule('bounce', `the subject reads as a delivery failure ("${subject.slice(0, 60)}")`);
  }
  // Only their new text: a person quoting an old failure notice back at us is
  // still a person, and calling them a bounce would stop us hearing them.
  if (BOUNCE_PHRASES.some((pattern) => pattern.test(fresh)) && /deliver/i.test(fresh)) {
    return rule('bounce', 'the body carries a delivery status notice');
  }

  if (input.automated === 'auto_reply') {
    return rule('out_of_office', 'the mail headers mark it as an automatic reply');
  }
  if (OOO_SUBJECTS.some((pattern) => pattern.test(subject))) {
    return rule(
      'out_of_office',
      `the subject reads as an autoresponder ("${subject.slice(0, 60)}")`,
    );
  }
  // A body phrase alone is weaker evidence: "I'm on leave next week but yes,
  // send it over" is a person. So it only counts on a short message that asks
  // nothing, where the phrase is plausibly the whole point.
  const oooPhrase = OOO_PHRASES.find((pattern) => pattern.test(fresh));
  if (oooPhrase && fresh.length > 0 && fresh.length < 600 && !fresh.includes('?')) {
    return rule('out_of_office', 'the message is a short absence notice', 0.9);
  }

  const unsubscribe = UNSUBSCRIBE_PHRASES.find((pattern) => pattern.test(fresh));
  if (unsubscribe) {
    const matched = fresh.match(unsubscribe)?.[0] ?? '';
    return rule('unsubscribe_request', `they wrote "${matched.trim()}"`);
  }
  if (BARE_UNSUBSCRIBE.test(fresh) || /^\s*unsubscribe\s*$/i.test(subject)) {
    return rule('unsubscribe_request', 'the reply is the word "unsubscribe"');
  }

  return undefined;
}

function rule(label: ReplyLabel, reason: string, confidence = 1): ReplyClassification {
  return { label, confidence, source: 'rule', reason };
}

/** The subject an answer carries: theirs, with one "Re:" and never two. */
export function replySubject(
  subject: string | null | undefined,
  fallback = 'Following up',
): string {
  const base = subject?.trim() || fallback;
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}
