/**
 * Matching a campaign's terms in the words prospects actually use.
 *
 * Campaign matching is literal. A campaign listening for "payments provider"
 * does not match "our Stripe fees are killing us" — which is the post that
 * indicates intent, because someone who states your category by name is
 * usually already talking to your competitor. Every term a campaign is given
 * is the seller's vocabulary, and the signal is written in the buyer's.
 *
 * So terms are expanded before they are searched. Three rules keep that from
 * turning a targeted campaign into a firehose:
 *
 *   1. **Expansions are additive, never replacements.** The original term
 *      always survives, so expansion can only widen a search and never quietly
 *      stop it matching what the user typed.
 *   2. **No single words, no generic ones.** "payments" on its own matches
 *      every fintech thread on the internet. Expansions have to be at least as
 *      specific as the term they came from.
 *   3. **Without a model this is the identity function.** The pipeline is
 *      required to run end to end on an empty `.env`, so a missing key makes
 *      matching literal again rather than making listening fail.
 */

import type { TextModel } from './model';

/** How many phrases one term may expand into. */
export const MAX_EXPANSIONS_PER_TERM = 6;

/** Below this, a phrase matches too much to be worth searching for. */
const MIN_PHRASE_LENGTH = 4;

const SYSTEM = [
  'You rewrite a sales-intent search term into the phrases real people use.',
  '',
  'Return one JSON object and nothing else:',
  '{"expansions": [string]}',
  '',
  'Rules:',
  '- Write how a frustrated or curious practitioner writes, not how a vendor writes.',
  '- Prefer complaints, questions and comparisons over category nouns.',
  '- A competitor named in a complaint is a strong expansion.',
  `- At most ${MAX_EXPANSIONS_PER_TERM} phrases, each at least two words.`,
  '- No hashtags, no marketing language, no single generic words.',
  '- If the term is already how people speak, return an empty array.',
].join('\n');

export interface ExpansionResult {
  readonly term: string;
  readonly expansions: readonly string[];
}

/**
 * Asks the model how a term is said in the wild.
 *
 * Returns the term's expansions only. Merging them with the original set is
 * the caller's job, so the cache can store what was generated separately from
 * what is searched.
 */
export async function expandTerm(model: TextModel, term: string): Promise<ExpansionResult> {
  const cleaned = term.trim();
  if (cleaned.length < MIN_PHRASE_LENGTH) return { term: cleaned, expansions: [] };

  const result = await model.generate({
    system: SYSTEM,
    user: `Term: ${cleaned}`,
    maxTokens: 400,
  });

  if (result.refused) return { term: cleaned, expansions: [] };

  return { term: cleaned, expansions: sanitise(parseExpansions(result.text), cleaned) };
}

function parseExpansions(text: string): readonly string[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    const list = (parsed as { expansions?: unknown }).expansions;
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    // A model that returned prose instead of JSON has told us nothing. Failing
    // closed here means literal matching, which is the behaviour without a key.
    return [];
  }
}

/**
 * Drops expansions that would widen the search past usefulness.
 *
 * The single-word rule is the important one. One noun from this domain
 * ("payments", "auth", "billing") matches an entire industry's small talk, and
 * a campaign that starts matching everything is indistinguishable from one
 * that is broken.
 */
function sanitise(candidates: readonly string[], term: string): readonly string[] {
  const seen = new Set<string>([term.toLowerCase()]);
  const kept: string[] = [];

  for (const candidate of candidates) {
    const phrase = candidate.trim().replace(/\s+/g, ' ');
    const lower = phrase.toLowerCase();

    if (phrase.length < MIN_PHRASE_LENGTH) continue;
    if (!phrase.includes(' ')) continue;
    if (seen.has(lower)) continue;

    seen.add(lower);
    kept.push(phrase);

    if (kept.length >= MAX_EXPANSIONS_PER_TERM) break;
  }

  return kept;
}

/**
 * Merges terms with their expansions into one search set.
 *
 * Pure, so the same merge runs in the listening loop and in tests without a
 * model. Originals come first and are never dropped: a user who typed a term
 * has a right to expect it searched, whatever the expansion decided.
 */
export function mergeTerms(
  terms: readonly string[],
  expansions: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  const add = (value: string): void => {
    const phrase = value.trim();
    const lower = phrase.toLowerCase();
    if (phrase.length < MIN_PHRASE_LENGTH || seen.has(lower)) return;
    seen.add(lower);
    merged.push(phrase);
  };

  for (const term of terms) add(term);
  for (const term of terms) {
    for (const expansion of expansions.get(term.trim().toLowerCase()) ?? []) add(expansion);
  }

  return merged;
}
