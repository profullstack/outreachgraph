/**
 * Buyer leads from public communities: the model's three jobs.
 *
 *   judge     score each post for buyer intent toward one brand (0-100), with a
 *             one-line reason. A vendor announcing its own product, a contest,
 *             a news link or a hiring post is not a buyer, however well it
 *             matches the keywords: those are what a keyword match is mostly
 *             made of, and the digest is only worth opening if they are gone.
 *   draft     a reply a human can paste into the thread. Helpful first,
 *             disclosed affiliation, the product named once and only where it
 *             answers the question. Never posted by the product.
 *   suggest   keywords and subreddits for a brand, so a monitor works the
 *             moment it is created from nothing but a name and a URL.
 *
 * No model, a refusal or unreadable output all mean "no verdict": the caller
 * falls back to the deterministic wording classifier and says so.
 */

import type { TextModel } from './model';

export interface LeadBrand {
  readonly name: string;
  readonly url?: string | undefined;
  readonly description?: string | undefined;
}

export interface LeadJudgeInput {
  readonly id: string;
  readonly source: string;
  readonly title?: string | undefined;
  readonly text: string;
}

export interface LeadJudgement {
  readonly id: string;
  /** 0-100: how likely the author is to buy something like the brand soon. */
  readonly intent: number;
  readonly reason: string;
}

function brandBlock(brand: LeadBrand): string {
  return [
    `Brand: ${brand.name}`,
    brand.url ? `URL: ${brand.url}` : '',
    brand.description ? `What it does: ${brand.description.slice(0, 800)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const JUDGE_SYSTEM = `You read public posts from Reddit, Hacker News and Bluesky and score each one for BUYER INTENT toward one brand: how likely the author is a potential customer who would welcome hearing about a product like it right now.

Score 0-100:
- 80-100: the author is actively looking for, comparing, or asking for recommendations on a tool/service in the brand's category, or is unhappy with a competitor and wants an alternative.
- 60-79: the author has a concrete problem the brand solves, right now, and is asking for help with it.
- 30-59: on-topic but no sign this author wants a product: news, opinions, tutorials, people already happily using a tool, learning or studying a topic, general discussion.
- 0-29: not a buyer. Vendors announcing or promoting their own product, courses and training ads, changelogs, contests, challenges, games, job posts, memes, the brand's own posts, or posts where the keyword means something else.

Be strict: 60 or more only when this author would plausibly welcome a product suggestion today. When unsure, score below 50.

Return exactly one result for every post, in the order given.
reason: one short sentence a salesperson would find useful ("asking for a SIEM alternative to Splunk for a 20-person team").
Return only JSON: {"results": [{"id": "<id>", "intent": 0, "reason": "..."}]}.`;

/** Judge up to ten posts per call. Returns [] when the model gives nothing usable. */
export async function judgeLeads(
  model: TextModel,
  brand: LeadBrand,
  posts: readonly LeadJudgeInput[],
): Promise<LeadJudgement[]> {
  if (!posts.length) return [];
  const user =
    `${brandBlock(brand)}\n\n` +
    posts
      .map(
        (post) =>
          `--- id: ${post.id}\nsource: ${post.source}\n${post.title ? `title: ${post.title}\n` : ''}` +
          post.text.replace(/\s+/g, ' ').slice(0, 1200),
      )
      .join('\n\n');
  const generated = await model.generate({ system: JUDGE_SYSTEM, user, maxTokens: 2000 });
  if (generated.refused) return [];
  return parseLeadJudgements(generated.text);
}

function jsonObject(raw: string): Record<string, unknown> | undefined {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function parseLeadJudgements(raw: string): LeadJudgement[] {
  const parsed = jsonObject(raw);
  const results = Array.isArray(parsed?.results)
    ? (parsed.results as Record<string, unknown>[])
    : [];
  return results
    .filter((entry) => typeof entry.id === 'string' || typeof entry.id === 'number')
    .map((entry) => {
      const intent = Number(entry.intent);
      return {
        id: String(entry.id).trim(),
        intent: Number.isFinite(intent) ? Math.max(0, Math.min(100, Math.round(intent))) : 0,
        reason: typeof entry.reason === 'string' ? entry.reason.trim().slice(0, 240) : '',
      };
    });
}

const DRAFT_SYSTEM = `You write a reply to a public community post on behalf of someone who works on a product. A human will read your draft, edit it and post it themselves.

Rules:
- Answer the person's actual question or problem first, with something genuinely useful even if they never use the product.
- Mention the product at most once, only where it fits, and disclose the affiliation plainly ("I work on X" / "I built X").
- Match the community's tone: plain, short, no marketing language, no emojis, no hashtags, no exclamation marks.
- 40-120 words. No greeting line, no sign-off, no links other than the product URL (at most once).
- Never claim features you were not told about. Never invent numbers or customers.
Return only the reply text.`;

export interface LeadReplyInput {
  readonly source: string;
  readonly container?: string | undefined;
  readonly title?: string | undefined;
  readonly text: string;
}

/** A reply draft, or undefined when the model refused or returned nothing. */
export async function draftLeadReply(
  model: TextModel,
  brand: LeadBrand,
  post: LeadReplyInput,
): Promise<string | undefined> {
  const user =
    `${brandBlock(brand)}\n\nPost (${post.source}${post.container ? `, ${post.container}` : ''}):\n` +
    `${post.title ? `${post.title}\n\n` : ''}${post.text.slice(0, 3000)}`;
  const generated = await model.generate({ system: DRAFT_SYSTEM, user, maxTokens: 600 });
  if (generated.refused) return undefined;
  const text = generated.text
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  return text.length > 0 ? text.slice(0, 2000) : undefined;
}

export interface MonitorSuggestion {
  readonly keywords: readonly string[];
  readonly subreddits: readonly string[];
}

const SUGGEST_SYSTEM = `You set up social listening for a product. Given the brand, return:
- keywords: 6-12 short phrases (1-4 words) that a potential BUYER would write in a post when they need this kind of product: the category name, the problems it solves, and the 2-4 best-known competitors. Lowercase. No brand name of the product itself.
- subreddits: 6-12 real, active, public subreddits where those buyers post (names only, no r/ prefix).
Return only JSON: {"keywords": ["..."], "subreddits": ["..."]}.`;

export async function suggestMonitor(
  model: TextModel,
  brand: LeadBrand,
): Promise<MonitorSuggestion | undefined> {
  const generated = await model.generate({
    system: SUGGEST_SYSTEM,
    user: brandBlock(brand),
    maxTokens: 800,
  });
  if (generated.refused) return undefined;
  return parseMonitorSuggestion(generated.text);
}

export function parseMonitorSuggestion(raw: string): MonitorSuggestion | undefined {
  const parsed = jsonObject(raw);
  if (!parsed) return undefined;
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? [
          ...new Set(
            value
              .map((v) =>
                String(v)
                  .trim()
                  .replace(/^\/?r\//i, ''),
              )
              .filter(Boolean),
          ),
        ]
      : [];
  const keywords = list(parsed.keywords)
    .map((k) => k.toLowerCase())
    .filter((k) => k.length >= 3 && k.length <= 60)
    .slice(0, 12);
  const subreddits = list(parsed.subreddits)
    .filter((s) => /^[A-Za-z0-9_]{2,21}$/.test(s))
    .slice(0, 12);
  if (keywords.length === 0 && subreddits.length === 0) return undefined;
  return { keywords, subreddits };
}
