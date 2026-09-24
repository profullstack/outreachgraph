/**
 * The outreach composer (PRD §14, §20.7).
 *
 * The composer's only job is wording. It does not decide who to contact
 * (scoring), where (policy), or why (the recommendation engine) — by the time
 * it runs, all three are settled, and it receives their output as fixed
 * context.
 *
 * Two properties are enforced structurally rather than requested politely:
 *
 *   1. **It can only see grounded inputs.** The prompt is assembled from
 *      stored evidence, stored facts, and the customer's own offering. There
 *      is no path by which the model learns something it may not cite.
 *   2. **Its output is checked, not trusted.** Every draft runs the §14.2
 *      gates before anyone sees it. A draft that invents a specific is
 *      rejected — including on a retry — rather than shown with a warning.
 */

import {
  newReplyText,
  type ActionKind,
  type Network,
  type OutreachStyle,
  type PersonKind,
  type ReplyLabel,
} from '@outreachgraph/domain';
import { runChecks, type CheckReport, type GroundingContext } from './checks';
import type { TextModel } from './model';

export interface OfferingContext {
  readonly name: string;
  readonly category: string;
  readonly valuePropositions: readonly string[];
  readonly likelyPains: readonly string[];
  readonly competitors: readonly string[];
}

export interface ProspectContext {
  /** Absent means a person. A `company_inbox` is written to as a team. */
  readonly kind?: PersonKind;
  readonly displayName: string;
  readonly firstName?: string;
  readonly title?: string;
  readonly companyName?: string;
  readonly identityConfidence: number;
}

/** The signal that justified contact. Its excerpt is the only quotable text. */
export interface TriggerContext {
  readonly id: string;
  readonly summary: string;
  readonly evidence?: string;
  readonly sourceUrl?: string;
  readonly network: Network;
  readonly ageDescription: string;
}

export interface VoiceContext {
  readonly style: OutreachStyle;
  readonly instructions?: string;
  readonly samples?: readonly string[];
  readonly maxWords?: number;
  readonly prohibitedClaims?: readonly string[];
}

export interface ComposeInput {
  readonly action: ActionKind;
  readonly network: Network;
  readonly offering: OfferingContext;
  readonly prospect: ProspectContext;
  readonly trigger?: TriggerContext;
  readonly voice?: VoiceContext;
  readonly minIdentityConfidence: number;
  readonly priorDraftHashes?: readonly string[];
  /**
   * What this touch is for, from the cadence step that produced it — "ask for
   * an intro", "follow up on the talk". Steers the angle only. It is not
   * CONTEXT: nothing in it may be stated as fact, and it never enters the
   * grounding set, so a guidance line that names a customer cannot smuggle
   * that customer into the message.
   */
  readonly guidance?: string;
  /** Retries on a failed grounding check. Zero disables retrying. */
  readonly maxAttempts?: number;
}

export type ComposeResult =
  | {
      readonly ok: true;
      readonly body: string;
      readonly report: CheckReport;
      readonly groundedSignalIds: readonly string[];
      readonly model: string;
      readonly attempts: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'no_evidence' | 'failed_checks' | 'model_refused' | 'empty';
      readonly report?: CheckReport;
      readonly attempts: number;
      readonly lastBody?: string;
    };

/** Channel ceilings. A public reply that gets truncated is worse than none. */
const LENGTH_LIMITS: Partial<Record<Network, number>> = {
  x: 280,
  bluesky: 300,
  linkedin: 700,
  github: 500,
};

const STYLE_GUIDANCE: Record<OutreachStyle, string> = {
  relationship_first: 'Open a conversation, not a pitch. Do not mention buying, demos, or calls.',
  concise_founder: 'Two or three sentences, plain and direct, founder to founder.',
  technical: 'Speak to the specific technical problem. Assume real expertise.',
  helpful_no_pitch: 'Be useful and mention nothing you sell.',
  direct: 'State the reason for the message in the first sentence.',
  community_first: 'Contribute to the conversation as a peer already in it.',
  custom: 'Follow the supplied voice instructions exactly.',
};

export async function composeDraft(model: TextModel, input: ComposeInput): Promise<ComposeResult> {
  // Without an excerpt there is nothing quotable, and a personalised message
  // built on a summary alone is exactly the fabrication §14.1 forbids.
  if (!input.trigger?.evidence) {
    return { ok: false, reason: 'no_evidence', attempts: 0 };
  }

  const grounding = buildGrounding(input);
  const maxAttempts = Math.max(1, input.maxAttempts ?? 2);

  let lastReport: CheckReport | undefined;
  let lastBody: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const generated = await model.generate({
      cachedPrefix: buildCachedPrefix(input),
      system: buildSystem(input),
      user: buildUser(input, attempt > 1 ? lastReport : undefined),
      maxTokens: 1024,
    });

    if (generated.refused) return { ok: false, reason: 'model_refused', attempts: attempt };

    const body = stripWrapper(generated.text);
    if (!body) return { ok: false, reason: 'empty', attempts: attempt };

    lastBody = body;

    const report = runChecks({
      body,
      grounding,
      identityConfidence: input.prospect.identityConfidence,
      minIdentityConfidence: input.minIdentityConfidence,
      ...(input.priorDraftHashes ? { priorDraftHashes: input.priorDraftHashes } : {}),
      ...(LENGTH_LIMITS[input.network] === undefined
        ? {}
        : { maxLength: LENGTH_LIMITS[input.network]! }),
      ...(input.voice?.prohibitedClaims ? { prohibitedClaims: input.voice.prohibitedClaims } : {}),
    });

    lastReport = report;

    if (report.passed) {
      return {
        ok: true,
        body,
        report,
        groundedSignalIds: [input.trigger.id],
        model: generated.model,
        attempts: attempt,
      };
    }
  }

  // A draft that fails its gates is withheld, not shown with a warning. The
  // reviewer is the last line of defence, and a bad draft next to a caveat is
  // still a bad draft they might approve.
  return {
    ok: false,
    reason: 'failed_checks',
    ...(lastReport ? { report: lastReport } : {}),
    ...(lastBody ? { lastBody } : {}),
    attempts: maxAttempts,
  };
}

/** Everything the model may treat as true. Nothing else exists to it. */
function buildGrounding(input: ComposeInput): GroundingContext {
  const facts = [
    input.prospect.displayName,
    input.prospect.firstName ?? '',
    input.prospect.title ?? '',
    input.prospect.companyName ?? '',
    input.trigger?.network ?? '',
  ].filter(Boolean);

  return {
    evidence: input.trigger?.evidence ? [input.trigger.evidence, input.trigger.summary] : [],
    facts,
    offering: [
      input.offering.name,
      input.offering.category,
      ...input.offering.valuePropositions,
      ...input.offering.likelyPains,
      ...input.offering.competitors,
    ],
  };
}

/**
 * The stable half of the prompt.
 *
 * Identical for every prospect in a campaign, so it sits behind the cache
 * breakpoint — see `ClaudeModel.generate`.
 */
function buildCachedPrefix(input: ComposeInput): string {
  const voice = input.voice;

  return [
    'You write short outreach messages on behalf of a business.',
    '',
    'Absolute rules:',
    '- Only state things supported by the CONTEXT you are given. If a fact is not there, it does not exist.',
    '- Never claim to have read, watched, or used anything unless the CONTEXT shows it.',
    '- Never invent numbers, product names, companies, or shared experiences.',
    '- No flattery. Do not open by praising them or their work.',
    '- No urgency, no scarcity, no manufactured enthusiasm.',
    '- Write as one person to another. Not marketing copy.',
    '- Output only the message. No subject line, no signature, no preamble, no quotation marks.',
    '',
    `About the business: ${input.offering.name}, ${input.offering.category}.`,
    input.offering.valuePropositions.length > 0
      ? `What it does: ${input.offering.valuePropositions.join('; ')}.`
      : '',
    input.offering.likelyPains.length > 0
      ? `Problems it addresses: ${input.offering.likelyPains.join('; ')}.`
      : '',
    '',
    `Style: ${STYLE_GUIDANCE[voice?.style ?? 'relationship_first']}`,
    voice?.instructions ? `Additional voice guidance: ${voice.instructions}` : '',
    voice?.samples?.length
      ? `Match the register of these samples:\n${voice.samples.map((s) => `- ${s}`).join('\n')}`
      : '',
    voice?.prohibitedClaims?.length ? `Never claim: ${voice.prohibitedClaims.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The per-prospect half — everything after the cache breakpoint. */
function buildSystem(input: ComposeInput): string {
  const limit = LENGTH_LIMITS[input.network];
  const words = input.voice?.maxWords;

  return [
    `Channel: ${input.network}. Action: ${input.action.replace(/_/g, ' ')}.`,
    limit ? `Hard limit: ${limit} characters.` : '',
    words ? `Aim for at most ${words} words.` : 'Aim for at most 60 words.',
    input.action === 'reply' || input.action === 'comment'
      ? 'This is a public reply in an existing thread. Other people will read it. Be useful to them too.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildUser(input: ComposeInput, failed?: CheckReport): string {
  const trigger = input.trigger!;
  const inbox = input.prospect.kind === 'company_inbox';
  const company = input.prospect.companyName ?? input.prospect.displayName;
  const name = inbox
    ? `the ${company} team`
    : (input.prospect.firstName ?? input.prospect.displayName);

  // A shared inbox has no first name to greet and nobody's words to quote.
  // What it has is a company that published a way to be reached and, often,
  // a line about itself. So the message is to the team, about the company,
  // and grounded in what the site says rather than in what a person said.
  const sections = inbox
    ? [
        'CONTEXT — the only facts you may use:',
        `Recipient: the shared inbox of ${company}. Nobody specific is named; whoever handles the company's mail will read this.`,
        `What their site says: ${trigger.summary} (${trigger.network}, ${trigger.ageDescription})`,
        `The site's exact words:\n"""\n${trigger.evidence}\n"""`,
        '',
        `Write a message to ${name}. Greet the team, never a first name.`,
        'Reference what the site says specifically enough that it could not have been sent to any other company.',
      ]
    : [
        'CONTEXT — the only facts you may use:',
        `Person: ${input.prospect.displayName}${input.prospect.title ? `, ${input.prospect.title}` : ''}${
          input.prospect.companyName ? ` at ${input.prospect.companyName}` : ''
        }`,
        `What they did: ${trigger.summary} (${trigger.network}, ${trigger.ageDescription})`,
        `Their exact words:\n"""\n${trigger.evidence}\n"""`,
        '',
        `Write a message to ${name} responding to what they said.`,
        'Reference their words specifically enough that it could not have been sent to anyone else.',
      ];

  const guidance = input.guidance?.trim();
  if (guidance) {
    sections.push(
      '',
      `The purpose of this particular message: ${guidance}`,
      'Serve that purpose, but it is an instruction, not a fact — state nothing from it that the CONTEXT does not support.',
    );
  }

  if (failed) {
    // Naming the exact rejected fragments works far better than repeating the
    // rule — the model can see what it invented.
    const problems = failed.results
      .filter((r) => !r.passed && r.detail)
      .map((r) => `- ${r.detail}`)
      .join('\n');

    sections.push(
      '',
      'Your previous attempt was rejected:',
      problems,
      failed.unsupported.length > 0
        ? `Remove these entirely — nothing supports them: ${failed.unsupported.join(', ')}.`
        : '',
      'Rewrite using only the CONTEXT above.',
    );
  }

  return sections.filter(Boolean).join('\n');
}

/** Models sometimes wrap output in quotes or a code fence despite instructions. */
function stripWrapper(text: string): string {
  let out = text.trim();
  out = out.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '');
  if (out.length > 1 && /^["'"']/.test(out) && /["'"']$/.test(out)) {
    out = out.slice(1, -1);
  }
  return out.trim();
}

// ------------------------------------------------------------------ replies

/** One message in a conversation, as the reply composer sees it. */
export interface ThreadMessage {
  readonly from: 'them' | 'us';
  readonly body: string;
}

export interface ReplyComposeInput {
  readonly network: Network;
  readonly offering: OfferingContext;
  readonly prospect: ProspectContext;
  readonly voice?: VoiceContext;
  /** Everything before the message being answered, oldest first. */
  readonly thread: readonly ThreadMessage[];
  /** The message being answered. */
  readonly inbound: { readonly body: string; readonly subject?: string | undefined };
  /** What triage called it; steers the answer, never the facts. */
  readonly label: ReplyLabel;
  readonly minIdentityConfidence: number;
  readonly priorDraftHashes?: readonly string[];
  readonly maxAttempts?: number;
}

const REPLY_GUIDANCE: Partial<Record<ReplyLabel, string>> = {
  interested:
    'They want to continue. Answer what they asked for as far as the CONTEXT allows, and propose one concrete next step.',
  question:
    'Answer their question using only the CONTEXT. If the CONTEXT does not contain the answer, say you will find out rather than inventing one.',
  referral:
    'They named someone else as the right person. Thank them briefly and ask whether they would be willing to introduce you. Do not write to the other person.',
};

/**
 * Answering a message somebody sent us — the composer's reply mode.
 *
 * The same contract as `composeDraft`, applied to a conversation instead of a
 * public post: the model sees only the thread and the customer's own
 * offering, and its output runs the same §14.2 gates before anyone reads it.
 * What counts as grounded changes in one way that matters. The evidence is
 * *their* words — this message and their earlier ones — plus the last thing
 * we sent, which is what their "yes" was a yes to. A reply that answers a
 * pricing question with a number that appears nowhere in the thread or the
 * offering is rejected exactly like an invented fact in a cold message.
 */
export async function composeReply(
  model: TextModel,
  input: ReplyComposeInput,
): Promise<ComposeResult> {
  const fresh = newReplyText(input.inbound.body);
  if (!fresh) return { ok: false, reason: 'no_evidence', attempts: 0 };

  const theirs = input.thread.filter((m) => m.from === 'them').map((m) => newReplyText(m.body));
  const ours = input.thread.filter((m) => m.from === 'us').map((m) => m.body);
  const lastOurs = ours.at(-1);

  const grounding: GroundingContext = {
    evidence: [fresh, ...theirs, ...(lastOurs ? [lastOurs] : [])].filter(Boolean),
    facts: [
      input.prospect.displayName,
      input.prospect.firstName ?? '',
      input.prospect.title ?? '',
      input.prospect.companyName ?? '',
      ...(input.inbound.subject ? [input.inbound.subject] : []),
      // Everything we already said is ours to repeat: it passed these gates
      // on its way out.
      ...ours,
    ].filter(Boolean),
    offering: [
      input.offering.name,
      input.offering.category,
      ...input.offering.valuePropositions,
      ...input.offering.likelyPains,
      ...input.offering.competitors,
    ],
  };

  const maxAttempts = Math.max(1, input.maxAttempts ?? 2);
  let lastReport: CheckReport | undefined;
  let lastBody: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const generated = await model.generate({
      cachedPrefix: buildReplyPrefix(input),
      system: buildReplySystem(input),
      user: buildReplyUser(input, fresh, attempt > 1 ? lastReport : undefined),
      maxTokens: 1024,
    });

    if (generated.refused) return { ok: false, reason: 'model_refused', attempts: attempt };

    const body = stripWrapper(generated.text);
    if (!body) return { ok: false, reason: 'empty', attempts: attempt };
    lastBody = body;

    const report = runChecks({
      body,
      grounding,
      identityConfidence: input.prospect.identityConfidence,
      minIdentityConfidence: input.minIdentityConfidence,
      ...(input.priorDraftHashes ? { priorDraftHashes: input.priorDraftHashes } : {}),
      ...(LENGTH_LIMITS[input.network] === undefined
        ? {}
        : { maxLength: LENGTH_LIMITS[input.network]! }),
      ...(input.voice?.prohibitedClaims ? { prohibitedClaims: input.voice.prohibitedClaims } : {}),
    });
    lastReport = report;

    if (report.passed) {
      return {
        ok: true,
        body,
        report,
        // A reply is grounded in a conversation, not a signal.
        groundedSignalIds: [],
        model: generated.model,
        attempts: attempt,
      };
    }
  }

  return {
    ok: false,
    reason: 'failed_checks',
    ...(lastReport ? { report: lastReport } : {}),
    ...(lastBody ? { lastBody } : {}),
    attempts: maxAttempts,
  };
}

function buildReplyPrefix(input: ReplyComposeInput): string {
  const voice = input.voice;

  return [
    'You write replies on behalf of a business to people who wrote back to it.',
    '',
    'Absolute rules:',
    '- Only state things supported by the CONTEXT you are given. If a fact is not there, it does not exist.',
    '- Never invent prices, numbers, dates, customers, product names, features or availability.',
    '- If they asked something the CONTEXT cannot answer, say you will check and come back to them.',
    '- You may quote their own words back to them.',
    '- No flattery, no urgency, no manufactured enthusiasm.',
    '- Output only the message body. No subject line, no signature, no preamble, no quotation marks.',
    '',
    `About the business: ${input.offering.name}, ${input.offering.category}.`,
    input.offering.valuePropositions.length > 0
      ? `What it does: ${input.offering.valuePropositions.join('; ')}.`
      : '',
    input.offering.likelyPains.length > 0
      ? `Problems it addresses: ${input.offering.likelyPains.join('; ')}.`
      : '',
    '',
    `Style: ${STYLE_GUIDANCE[voice?.style ?? 'relationship_first']}`,
    voice?.instructions ? `Additional voice guidance: ${voice.instructions}` : '',
    voice?.prohibitedClaims?.length ? `Never claim: ${voice.prohibitedClaims.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildReplySystem(input: ReplyComposeInput): string {
  const limit = LENGTH_LIMITS[input.network];
  const words = input.voice?.maxWords;

  return [
    `Channel: ${input.network}. This is a reply in a conversation they started answering.`,
    limit ? `Hard limit: ${limit} characters.` : '',
    words ? `Aim for at most ${words} words.` : 'Aim for at most 90 words.',
    REPLY_GUIDANCE[input.label] ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildReplyUser(input: ReplyComposeInput, fresh: string, failed?: CheckReport): string {
  const name = input.prospect.firstName ?? input.prospect.displayName;
  const history = input.thread
    .slice(-6)
    .map(
      (m) =>
        `${m.from === 'us' ? 'We wrote' : 'They wrote'}:\n"""\n${
          m.from === 'us' ? m.body.slice(0, 1500) : newReplyText(m.body).slice(0, 1500)
        }\n"""`,
    );

  const sections = [
    'CONTEXT — the only facts you may use:',
    `Person: ${input.prospect.displayName}${input.prospect.title ? `, ${input.prospect.title}` : ''}${
      input.prospect.companyName ? ` at ${input.prospect.companyName}` : ''
    }`,
    ...(history.length > 0 ? ['Earlier in this conversation:', ...history] : []),
    `Their latest message${input.inbound.subject ? ` (subject: ${input.inbound.subject})` : ''}:`,
    `"""\n${fresh.slice(0, 4000)}\n"""`,
    '',
    `Write the reply to ${name}.`,
  ];

  if (failed) {
    const problems = failed.results
      .filter((r) => !r.passed && r.detail)
      .map((r) => `- ${r.detail}`)
      .join('\n');

    sections.push(
      '',
      'Your previous attempt was rejected:',
      problems,
      failed.unsupported.length > 0
        ? `Remove these entirely — nothing supports them: ${failed.unsupported.join(', ')}.`
        : '',
      'Rewrite using only the CONTEXT above.',
    );
  }

  return sections.filter(Boolean).join('\n');
}
