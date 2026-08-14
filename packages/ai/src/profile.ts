/**
 * Reading your own site to draft your profile (PRD §7 offerings, §11 targeting).
 *
 * This is the mirror image of the crawler that reads a *prospect's* site. Here
 * the page belongs to the person signing up, and what comes out is not a lead
 * but a description of their business: what they sell, who plausibly buys it,
 * and how they write.
 *
 * The output is always a draft. Everything here is the model's reading of a
 * marketing page, which is a starting point for a human to correct rather than
 * a fact about their business — so nothing is written anywhere until the person
 * has seen it and confirmed it.
 */

import { profileLimits } from '@outreachgraph/contracts';
import type { TextModel } from './model';

export interface ProfileDraft {
  readonly offering: {
    readonly name: string;
    readonly category: string;
    readonly description: string;
    readonly valuePropositions: readonly string[];
    readonly likelyPains: readonly string[];
    readonly competitors: readonly string[];
  };
  readonly icp: {
    readonly titles: readonly string[];
    readonly seniorities: readonly string[];
    readonly industries: readonly string[];
    readonly technologies: readonly string[];
    readonly keywords: readonly string[];
    readonly exclusions: readonly string[];
  };
  readonly voice: {
    readonly style: string;
    readonly instructions: string;
    readonly maxWords: number;
  };
  /** Where to look for these people, and why. Advice, not configuration. */
  readonly whereToFind: readonly string[];
}

export interface ProfileDraftResult {
  readonly ok: boolean;
  readonly draft?: ProfileDraft;
  /** Why there is no draft, in words worth showing someone. */
  readonly reason?: string;
}

const SYSTEM = [
  'You read a company website and describe the business behind it, so its own team',
  'can find the right people to talk to.',
  '',
  'Return one JSON object and nothing else:',
  '{',
  ' "offering": {"name":string,"category":string,"description":string,',
  '   "valuePropositions":string[],"likelyPains":string[],"competitors":string[]},',
  ' "icp": {"titles":string[],"seniorities":string[],"industries":string[],',
  '   "technologies":string[],"keywords":string[],"exclusions":string[]},',
  ' "voice": {"style":string,"instructions":string,"maxWords":number},',
  ' "whereToFind": string[]',
  '}',
  '',
  'Rules:',
  '- Ground the offering in what the page actually says. Do not invent products.',
  '- The ICP is an inference and may go beyond the page, but keep it plausible',
  '  and specific: real job titles, real industries, not "decision makers".',
  '- likelyPains are the problems this buyer has, in their words, not yours.',
  '- competitors only if the page names them or the category makes them obvious.',
  '- voice.style describes how this company already writes, taken from the page.',
  '- whereToFind: concrete places these buyers are active and why — a subreddit,',
  '  a GitHub topic, a conference, a job-board signal. Each entry one sentence.',
  '- Never mention LinkedIn automation. Research there is fine; automating is not.',
  '- Keep icp entries to a term of a few words. valuePropositions, likelyPains and',
  '  exclusions may be a sentence, but one sentence, under 300 characters.',
].join('\n');

/** Pulls the JSON object out of a reply that may be fenced or prefaced. */
function parseReply(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Shortens one entry to what the profile contract will accept.
 *
 * A draft that cannot be saved is worse than a shorter one. The model is asked
 * for terms and sentences and mostly obliges, but one line over the limit used
 * to fail the whole save with "that profile is incomplete" — naming no field,
 * and in a form that had no box for the offending one. Cutting on a word
 * boundary and marking the cut keeps the draft honest about what was lost.
 */
function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > max / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

function strings(value: unknown, limit = 12, max: number = profileLimits.term): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => clamp(entry.trim(), max))
    .slice(0, limit);
}

/** Sentences the model writes for a human to read, not terms to filter on. */
function sentences(value: unknown, limit = 12): string[] {
  return strings(value, limit, profileLimits.sentence);
}

function text(value: unknown, fallback = '', max: number = profileLimits.label): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return clamp(trimmed || fallback, max);
}

/**
 * Drafts a workspace profile from the text of the customer's own site.
 *
 * Never throws. A capped key, a refusal or an unparseable reply all return
 * `ok: false` with something worth reading, because the fallback is a form the
 * person fills in themselves — which is a worse first run, not a broken one.
 */
export async function draftProfile(
  model: TextModel,
  siteText: string,
  siteUrl: string,
): Promise<ProfileDraftResult> {
  if (!siteText.trim()) {
    return { ok: false, reason: 'that page had no readable text' };
  }

  let reply;
  try {
    reply = await model.generate({
      system: SYSTEM,
      user: `Site: ${siteUrl}\n\nPage text:\n${siteText.slice(0, 14_000)}`,
      maxTokens: 2000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Surfaced rather than swallowed: "the model is out of budget" is
    // something the person can act on, and silence here reads as a bug.
    return { ok: false, reason: `the model could not be reached: ${message}` };
  }

  if (reply.refused) return { ok: false, reason: 'the model declined to read that page' };

  const parsed = parseReply(reply.text);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'the model did not return a usable profile' };
  }

  const root = parsed as Record<string, unknown>;
  const offering = (root.offering ?? {}) as Record<string, unknown>;
  const icp = (root.icp ?? {}) as Record<string, unknown>;
  const voice = (root.voice ?? {}) as Record<string, unknown>;

  const name = text(offering.name);
  if (!name) return { ok: false, reason: 'the model could not identify what this company sells' };

  const maxWords = Number(voice.maxWords);

  return {
    ok: true,
    draft: {
      offering: {
        name,
        category: text(offering.category, 'unspecified'),
        description: text(offering.description, '', profileLimits.description),
        valuePropositions: sentences(offering.valuePropositions),
        likelyPains: sentences(offering.likelyPains),
        competitors: strings(offering.competitors, 8),
      },
      icp: {
        titles: strings(icp.titles),
        seniorities: strings(icp.seniorities, 8),
        industries: strings(icp.industries),
        technologies: strings(icp.technologies),
        keywords: strings(icp.keywords, 16),
        exclusions: sentences(icp.exclusions),
      },
      voice: {
        style: text(voice.style, 'direct and specific', profileLimits.style),
        instructions: text(voice.instructions, '', profileLimits.instructions),
        // A cap is what keeps a first message short enough to read on a phone.
        maxWords: Number.isFinite(maxWords) && maxWords > 0 ? Math.min(maxWords, 400) : 120,
      },
      whereToFind: sentences(root.whereToFind, 10),
    },
  };
}
