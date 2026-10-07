/**
 * Posts about a link: one per network, in the workspace's voice.
 *
 * The model reads the page (title, description, the main text) and writes a
 * post for each network asked for, sized and shaped to that network's norms
 * (`LINK_POST_FORMATS`). A person posts every one of them by hand; nothing here
 * talks to a network.
 *
 * Everything the model returns is cleaned before anyone sees it: the link is
 * stripped from the text (the card adds it in the right place), em dashes are
 * gone (a house rule: they read as machine-written), and anything over a
 * network's limit is cut at a word boundary rather than left to be rejected by
 * the composer.
 */

import {
  fitText,
  LINK_POST_FORMATS,
  isLinkPostNetwork,
  linkPostLength,
  linkPostPasteText,
  type LinkPostNetwork,
} from '@outreachgraph/domain';
import type { TextModel } from './model';

export interface LinkPage {
  readonly url: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  /** The page's main text, already stripped of markup. */
  readonly text?: string | undefined;
}

export interface LinkPostVoice {
  readonly style: string;
  readonly instructions?: string | undefined;
}

export interface LinkPostBrand {
  readonly name: string;
  readonly url?: string | undefined;
  readonly description?: string | undefined;
}

export interface LinkPostRequest {
  readonly page: LinkPage;
  readonly networks: readonly LinkPostNetwork[];
  readonly voice?: LinkPostVoice | undefined;
  /** Who is posting: the workspace's product, when it has one. */
  readonly brand?: LinkPostBrand | undefined;
  /** What the poster wants said: an angle, a call to action, a correction. */
  readonly notes?: string | undefined;
}

export interface LinkPostDraft {
  readonly network: LinkPostNetwork;
  /** The post, or for Reddit and HN the first comment. Never contains the link. */
  readonly text: string;
  readonly title?: string;
  readonly subreddit?: string;
}

const SYSTEM = `You write social media posts that share one web page. A person will read each post, maybe edit it, and post it under their own name.

Rules for every post:
- Ground every claim in the page you are given. Never invent numbers, quotes, customers or features.
- Write like a person, not a brand: plain words, specific, no hype ("game-changer", "revolutionary", "excited to share", "dive in").
- Never use em dashes or en dashes. Use commas, periods or parentheses.
- Do not put the page's URL in the text; it is added separately.
- Each network gets its own post written for that network's audience, not the same text resized.
- Follow the poster's voice and notes when given.

Return only JSON: {"posts": [{"network": "<network>", "title": "<title or null>", "text": "<post>", "subreddit": "<name or null>"}]}, one entry per network requested, in the order requested.`;

function host(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(
      /^www\./,
      '',
    );
  } catch {
    return undefined;
  }
}

/** The user prompt. Exported for tests: what the model is told is part of the contract. */
export function linkPostPrompt(request: LinkPostRequest): string {
  const { page, brand, voice, notes } = request;
  const own = brand?.url && host(brand.url) && host(brand.url) === host(page.url);

  const lines: string[] = [
    'PAGE',
    `URL: ${page.url}`,
    page.title ? `Title: ${page.title}` : '',
    page.description ? `Description: ${page.description.slice(0, 600)}` : '',
    page.text ? `Main text:\n${page.text.slice(0, 6000)}` : '(The page could not be read.)',
    '',
  ];

  if (brand) {
    lines.push(
      'POSTER',
      `Posts on behalf of: ${brand.name}${brand.url ? ` (${brand.url})` : ''}`,
      brand.description ? `What they do: ${brand.description.slice(0, 600)}` : '',
      own
        ? 'This page is their own: write as its maker, and disclose that on Reddit and HN.'
        : "This page is someone else's: write as a person sharing something worth reading, and do not pitch their own product.",
      '',
    );
  }

  if (voice) {
    lines.push(
      'VOICE',
      `Style: ${voice.style}`,
      voice.instructions ? `Instructions: ${voice.instructions.slice(0, 1000)}` : '',
      '',
    );
  }

  if (notes?.trim()) lines.push('NOTES FROM THE POSTER', notes.trim().slice(0, 1000), '');

  lines.push('NETWORKS');
  for (const network of request.networks) {
    const format = LINK_POST_FORMATS[network];
    lines.push(`${network} (${format.label}):`, ...format.norms.map((norm) => `- ${norm}`));
    if (!format.titled) lines.push('- title: null. subreddit: null.');
    else if (network !== 'reddit') lines.push('- subreddit: null.');
  }

  return lines.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
}

function jsonObject(raw: string): Record<string, unknown> | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Dashes out, the link out, quotes and stray whitespace off. */
export function cleanPostText(text: string, url?: string): string {
  let out = text;
  if (url) {
    out = out.split(url).join('');
    // The model sometimes drops the trailing slash or the scheme.
    const bare = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (bare.length > 8) {
      out = out.replace(
        new RegExp(`(?:https?://)?${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`, 'g'),
        '',
      );
    }
  }
  return out
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/^["'\u201c]+|["'\u201d]+$/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Cuts the body until the whole pasted post fits the network's limit. */
export function fitToNetwork(network: LinkPostNetwork, body: string, url: string): string {
  const format = LINK_POST_FORMATS[network];
  if (!format.limit) return body;
  let fitted = body;
  for (let i = 0; i < 6; i += 1) {
    const over = linkPostLength(network, linkPostPasteText(network, fitted, url)) - format.limit;
    if (over <= 0) return fitted;
    fitted = fitText(fitted, Math.max(20, [...fitted].length - over - 2));
  }
  return fitted;
}

/** Reads the model's answer into one draft per requested network. Unknown or missing ones are dropped. */
export function parseLinkPosts(
  raw: string,
  networks: readonly LinkPostNetwork[],
  url: string,
): LinkPostDraft[] {
  const parsed = jsonObject(raw);
  const posts = Array.isArray(parsed?.posts) ? (parsed.posts as Record<string, unknown>[]) : [];
  const drafts: LinkPostDraft[] = [];

  for (const network of networks) {
    const entry = posts.find(
      (post) =>
        typeof post.network === 'string' &&
        isLinkPostNetwork(post.network.trim().toLowerCase()) &&
        post.network.trim().toLowerCase() === network,
    );
    if (!entry) continue;
    const format = LINK_POST_FORMATS[network];

    const text = fitToNetwork(
      network,
      cleanPostText(typeof entry.text === 'string' ? entry.text : '', url),
      url,
    );
    const rawTitle = typeof entry.title === 'string' ? cleanPostText(entry.title, url) : '';
    const title =
      format.titled && rawTitle ? fitText(rawTitle, format.titleLimit ?? 300) : undefined;
    const subreddit =
      network === 'reddit' && typeof entry.subreddit === 'string'
        ? entry.subreddit
            .trim()
            .replace(/^\/?r\//i, '')
            .replace(/[^A-Za-z0-9_]/g, '')
        : '';

    // A titled network can go with an empty first comment; the others need words.
    if (format.titled ? !title : !text) continue;
    drafts.push({
      network,
      text,
      ...(title ? { title } : {}),
      ...(subreddit ? { subreddit } : {}),
    });
  }

  return drafts;
}

export interface LinkPostResult {
  readonly posts: LinkPostDraft[];
  /** The model that answered, after any fallback. */
  readonly model?: string;
}

/** One draft per network the model answered for. A refusal is an empty list. */
export async function draftLinkPosts(
  model: TextModel,
  request: LinkPostRequest,
): Promise<LinkPostResult> {
  if (request.networks.length === 0) return { posts: [] };
  const generated = await model.generate({
    system: SYSTEM,
    user: linkPostPrompt(request),
    maxTokens: 900 + request.networks.length * 600,
  });
  if (generated.refused) return { posts: [], model: generated.model };
  return {
    posts: parseLinkPosts(generated.text, request.networks, request.page.url),
    model: generated.model,
  };
}
