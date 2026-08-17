/**
 * Message quality gates (PRD §14.1, §14.2).
 *
 * Every check here is deterministic. A model must never be the thing that
 * decides whether its own output is grounded — that is the same mistake as
 * letting an LLM decide policy, and it fails in exactly the way you cannot
 * detect: confidently.
 *
 * The grounding check is the load-bearing one. It works by inverting the
 * usual question. Rather than asking "is this claim true?" — undecidable — it
 * asks "does every specific assertion in this draft appear in the evidence we
 * stored?" Anything specific and unsourced is flagged, whether or not it
 * happens to be true. That is the standard PRD §14.1 sets: no stored evidence,
 * no claim.
 */

import type { QualityCheck, QualityCheckResult } from '@outreachgraph/domain';

export interface GroundingContext {
  /** Verbatim excerpts from the signals this draft may cite. */
  readonly evidence: readonly string[];
  /** Facts we hold about the person and their company. */
  readonly facts: readonly string[];
  /** The customer's own offering — safe to assert, they wrote it. */
  readonly offering: readonly string[];
}

export interface CheckInput {
  readonly body: string;
  readonly subject?: string;
  readonly grounding: GroundingContext;
  readonly identityConfidence: number;
  readonly minIdentityConfidence: number;
  /** Similarity hashes of drafts already sent from this workspace. */
  readonly priorDraftHashes?: readonly string[];
  /** Channel ceiling, e.g. 280 for a public reply. */
  readonly maxLength?: number;
  /** Claims the customer has forbidden, from the voice profile. */
  readonly prohibitedClaims?: readonly string[];
}

export interface CheckReport {
  readonly results: readonly QualityCheckResult[];
  readonly passed: boolean;
  /** Set when grounding failed; the specific unsupported fragments. */
  readonly unsupported: readonly string[];
  readonly similarityHash: string;
}

/**
 * Flattery the composer must not produce (PRD §13.3).
 *
 * These are the phrases that signal a message was generated rather than
 * written — the "I loved your recent post" register, which reads as false
 * familiarity precisely because it is.
 */
const FLATTERY_PATTERNS: readonly RegExp[] = [
  /\bi (?:loved|really enjoyed|absolutely loved)\b/i,
  /\bbig fan of\b/i,
  /\bhuge fan\b/i,
  /\byour (?:amazing|incredible|fantastic|brilliant|inspiring)\b/i,
  /\blove what you(?:'re| are) doing\b/i,
  /\bfollowing your work\b/i,
  /\bcame across your (?:profile|work) and was (?:impressed|blown away)\b/i,
];

/** Manipulative urgency and mass-mail tells (PRD §13.3, §18). */
const SPAM_PATTERNS: readonly RegExp[] = [
  /\bact (?:now|fast)\b/i,
  /\blimited time\b/i,
  /\bdon'?t miss out\b/i,
  /\bexclusive offer\b/i,
  /\b(?:100%|guaranteed) (?:free|results)\b/i,
  /\bquick question\b/i,
  /\bjust bumping this\b/i,
  /\bcircling back\b/i,
  /\bper my last\b/i,
  /\$\d+[kK]?\s*(?:in|of)\s*(?:savings|revenue)\b/i,
];

/**
 * Sensitive categories that must never appear in outbound copy, even when a
 * public post revealed them (PRD §17.4).
 */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /\b(?:diagnos(?:ed|is)|illness|cancer|depression|anxiety|disability|medication)\b/i,
  /\b(?:pregnan|maternity|paternity)\w*\b/i,
  /\b(?:divorce|bereave|passed away|funeral)\w*\b/i,
  /\b(?:church|mosque|synagogue|muslim|christian|jewish|hindu)\b/i,
  /\b(?:democrat|republican|liberal|conservative|voted for)\b/i,
  /\b(?:laid off|fired|struggling financially|bankrupt)\b/i,
  /\b(?:union|striking)\b/i,
];

/** Words too common to count as a specific claim. */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'then',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'as',
  'so',
  'i',
  'we',
  'you',
  'they',
  'he',
  'she',
  'me',
  'us',
  'them',
  'my',
  'our',
  'your',
  'their',
  'his',
  'her',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'can',
  'could',
  'will',
  'would',
  'should',
  'may',
  'might',
  'must',
  'not',
  'no',
  'yes',
  'about',
  'into',
  'over',
  'under',
  'after',
  'before',
  'when',
  'while',
  'how',
  'what',
  'saw',
  'noticed',
  'ran',
  'into',
  'similar',
  'issue',
  'one',
  'pattern',
  'found',
  'useful',
  'testing',
  'team',
  'hi',
  'hey',
  'hello',
  'thanks',
  'thank',
  'cheers',
  'best',
  'regards',
  'happy',
  'help',
  'worth',
  'quick',
  'work',
  'works',
  'working',
  'build',
  'built',
  'building',
  'use',
  'used',
  'using',
  'make',
  'made',
  'get',
  'much',
  'many',
  'more',
  'most',
  'less',
  'same',
  'other',
  'another',
  'also',
  'just',
  'only',
  'still',
  'way',
]);

/**
 * Contraction and possessive endings, removed before a capitalised word is
 * read as a name.
 *
 * "I'd" is not a proper noun, but it is capitalised mid-sentence and so was
 * extracted as one — and nothing could ever support it, because `normalize`
 * turns the apostrophe into a space and leaves the untraceable token "i d".
 * Any draft written in the first person failed its own grounding gate, twice,
 * and was withheld. Stripping the ending also fixes the opposite error:
 * "Stripe's" normalised to "stripe s" and did not match stored evidence
 * reading "Stripe", so a correctly grounded name was rejected as invented.
 */
const CONTRACTION_SUFFIX = /['’](?:s|d|m|t|ll|ve|re)$/i;

/**
 * Distinct content words a draft must share with the evidence to count as
 * grounded. Two is enough to rule out generic outreach ("would you be open to
 * a chat?") without demanding the draft quote verbatim.
 */
const MIN_EVIDENCE_OVERLAP = 2;

/** Count of distinct meaningful words the draft and the evidence share. */
export function evidenceOverlap(body: string, evidence: readonly string[]): number {
  if (evidence.length === 0) return 0;

  const evidenceWords = new Set(
    normalize(evidence.join(' '))
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );

  const shared = new Set(
    normalize(body)
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w) && evidenceWords.has(w)),
  );

  return shared.size;
}

export function runChecks(input: CheckInput): CheckReport {
  const results: QualityCheckResult[] = [];
  // Hash with the per-prospect facts removed, so the same template sent to
  // different people collides rather than looking unique.
  const similarityHash = similarityFingerprint(input.body, input.grounding.facts);

  const { unsupported } = findUnsupportedClaims(input.body, input.grounding);

  // Does the draft actually engage with the evidence? Measured as shared
  // content words, not as extracted claims: a well-grounded message often
  // paraphrases in plain lowercase prose ("settlement taking days") and has
  // no capitalised or numeric specifics to extract at all.
  const overlap = evidenceOverlap(input.body, input.grounding.evidence);
  const groundingRequired = input.grounding.evidence.length > 0;

  results.push({
    check: 'grounding',
    passed: !groundingRequired || overlap >= MIN_EVIDENCE_OVERLAP,
    ...(groundingRequired && overlap < MIN_EVIDENCE_OVERLAP
      ? { detail: 'the draft does not reference anything the prospect actually said' }
      : {}),
  });

  results.push({
    check: 'unsupported_claim',
    passed: unsupported.length === 0,
    ...(unsupported.length > 0
      ? { detail: `no stored evidence supports: ${unsupported.slice(0, 5).join(', ')}` }
      : {}),
  });

  results.push({
    check: 'identity_confidence',
    passed: input.identityConfidence >= input.minIdentityConfidence,
    ...(input.identityConfidence < input.minIdentityConfidence
      ? {
          detail:
            `identity confidence ${round(input.identityConfidence)} is below ` +
            `${round(input.minIdentityConfidence)}`,
        }
      : {}),
  });

  const flattery = firstMatch(input.body, FLATTERY_PATTERNS);
  results.push({
    check: 'excessive_flattery',
    passed: flattery === undefined,
    ...(flattery ? { detail: `reads as manufactured warmth: "${flattery}"` } : {}),
  });

  const spam = firstMatch(input.body, SPAM_PATTERNS);
  const tooLong = input.maxLength !== undefined && input.body.length > input.maxLength;
  const linkCount = (input.body.match(/https?:\/\//g) ?? []).length;

  results.push({
    check: 'spam_pattern',
    passed: spam === undefined && !tooLong && linkCount <= 1,
    ...(spam
      ? { detail: `spam phrasing: "${spam}"` }
      : tooLong
        ? { detail: `${input.body.length} characters exceeds the ${input.maxLength} limit` }
        : linkCount > 1
          ? { detail: `${linkCount} links; at most one is credible` }
          : {}),
  });

  const duplicate = input.priorDraftHashes?.includes(similarityHash) ?? false;
  results.push({
    check: 'duplicate_similarity',
    passed: !duplicate,
    ...(duplicate ? { detail: 'this message has already been sent to someone else' } : {}),
  });

  const prohibited = (input.prohibitedClaims ?? []).find((claim) =>
    input.body.toLowerCase().includes(claim.toLowerCase()),
  );
  const sensitive = firstMatch(input.body, SENSITIVE_PATTERNS);

  results.push({
    check: 'sensitive_topic',
    passed: sensitive === undefined && prohibited === undefined,
    ...(sensitive
      ? { detail: `references a sensitive category: "${sensitive}"` }
      : prohibited
        ? { detail: `contains a prohibited claim: "${prohibited}"` }
        : {}),
  });

  // The policy gate is evaluated by the engine, not here. Recording it keeps
  // the §14.2 list complete and makes the omission visible if it is skipped.
  results.push({ check: 'policy', passed: true, detail: 'evaluated by the policy engine' });

  return {
    results,
    passed: results.every((r) => r.passed),
    unsupported,
    similarityHash,
  };
}

/**
 * Splits a draft into the specific assertions it makes, and checks each
 * against the stored evidence.
 *
 * "Specific" means a capitalised term, a number, or a quoted phrase — the
 * things that make a message feel researched, and therefore the things that
 * do damage when invented. Ordinary prose is not checked; the sentence
 * "we ran into something similar" asserts nothing checkable.
 */
export function findUnsupportedClaims(
  body: string,
  grounding: GroundingContext,
): { unsupported: string[]; allowed: string[] } {
  const haystack = normalize(
    [...grounding.evidence, ...grounding.facts, ...grounding.offering].join(' '),
  );

  const unsupported: string[] = [];
  const allowed: string[] = [];

  for (const claim of extractClaims(body)) {
    if (haystack.includes(normalize(claim))) allowed.push(claim);
    else unsupported.push(claim);
  }

  return { unsupported: [...new Set(unsupported)], allowed: [...new Set(allowed)] };
}

/** Capitalised terms, quoted phrases and figures — the checkable specifics. */
export function extractClaims(body: string): string[] {
  const claims: string[] = [];

  // Quoted phrases: an explicit claim about what someone said. Only double
  // quotes delimit one. An apostrophe is not a quote mark, and treating it as
  // one made every pair of contractions in a draft look like a quotation: "I've
  // seen this. Curious what you'd try" yielded the claim "ve seen this. Curious
  // what you", which no evidence can support. Single quotes are left out for
  // the same reason — they are indistinguishable from the apostrophe in "I'd".
  for (const match of body.matchAll(/["“”]([^"“”]{4,120})["“”]/g)) {
    if (match[1]) claims.push(match[1]);
  }

  // Figures, including percentages and money — never safe to invent. No
  // trailing \b: it would never match after '%', silently dropping the unit
  // and comparing a bare "40" against the evidence.
  for (const match of body.matchAll(/\b\d+(?:\.\d+)?%?/g)) {
    if (match[0] && match[0].length > 1) claims.push(match[0]);
  }

  // Capitalised terms not at the start of a sentence: product and company
  // names, technologies. Sentence-initial words are skipped because
  // capitalisation there carries no information.
  const sentences = body.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    for (let i = 1; i < words.length; i += 1) {
      const trimmed = words[i]!.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      const word = trimmed.replace(CONTRACTION_SUFFIX, '');
      if (word.length < 3) continue;
      if (!/^\p{Lu}/u.test(word)) continue;
      if (STOPWORDS.has(word.toLowerCase())) continue;
      claims.push(word);
    }
  }

  return [...new Set(claims)];
}

/**
 * Order-insensitive fingerprint of a message's content words.
 *
 * `personalization` lists the per-prospect variables — name, title, employer —
 * which are removed before hashing. That is what makes this catch the classic
 * mail-merge: one template sent to a thousand people differs only in those
 * tokens, so with them stripped every copy hashes identically (PRD §18).
 * Without stripping, the varying name would make each copy look unique, which
 * is precisely the case the check exists to find.
 */
export function similarityFingerprint(
  body: string,
  personalization: readonly string[] = [],
): string {
  const excluded = new Set(
    personalization.flatMap((fact) => normalize(fact).split(/\s+/)).filter(Boolean),
  );

  const words = normalize(body)
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w) && !excluded.has(w))
    .sort();

  let hash = 2166136261;
  for (const word of words) {
    for (let i = 0; i < word.length; i += 1) {
      hash ^= word.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function failedChecks(report: CheckReport): QualityCheck[] {
  return report.results.filter((r) => !r.passed).map((r) => r.check);
}

function firstMatch(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return undefined;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s%.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
