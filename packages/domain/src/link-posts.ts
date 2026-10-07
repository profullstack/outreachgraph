/**
 * A post about a link, written once per network, posted by a person.
 *
 * Anthony shares a page (a launch, a blog post, a customer story) and wants
 * it on LinkedIn, X, Reddit, Hacker News and the rest. None of those may be
 * posted to by the product: LinkedIn forbids automation, Reddit and HN have no
 * write API we may use, Facebook's composer takes a link and nothing else. So
 * the product writes the words, sized to each network's own norms, and hands
 * each one over as a card: the text, a character count against the network's
 * limit, a button that opens the network's composer with as much prefilled as
 * it allows, and the few steps left for a human.
 *
 * Pure and dependency-free, like `share-links`, so the API builds the card and
 * the browser can rebuild the Open link after the text is edited.
 */

import { buildShareLink, type ShareNetwork } from './share-links';

export const LINK_POST_NETWORKS = [
  'linkedin',
  'x',
  'reddit',
  'hackernews',
  'facebook',
  'bluesky',
  'mastodon',
  'threads',
] as const satisfies readonly ShareNetwork[];

export type LinkPostNetwork = (typeof LINK_POST_NETWORKS)[number];

export const LINK_POST_STATUSES = ['open', 'done', 'skipped'] as const;
export type LinkPostStatus = (typeof LINK_POST_STATUSES)[number];

export function isLinkPostNetwork(value: string): value is LinkPostNetwork {
  return (LINK_POST_NETWORKS as readonly string[]).includes(value);
}

export interface LinkPostFormat {
  readonly network: LinkPostNetwork;
  readonly label: string;
  /** Hard limit of the whole post as the network counts it; absent when there is none worth stating. */
  readonly limit?: number;
  /** Characters the network charges for any link, when it shortens links (X, Mastodon). */
  readonly linkCost?: number;
  /** True when the link sits inside the pasted text; false when the network has its own URL field. */
  readonly linkInText: boolean;
  /** True when a title is the post (Reddit, HN) and the text is an optional first comment. */
  readonly titled: boolean;
  readonly titleLimit?: number;
  /** What the writer is told about the network. One line each; the model reads them. */
  readonly norms: readonly string[];
}

export const LINK_POST_FORMATS: Readonly<Record<LinkPostNetwork, LinkPostFormat>> = {
  linkedin: {
    network: 'linkedin',
    label: 'LinkedIn',
    limit: 3000,
    linkInText: true,
    titled: false,
    norms: [
      '600-1300 characters. The first line is the hook: it is all anyone sees before "see more".',
      'Short paragraphs of one to three sentences, a blank line between them.',
      'A professional, first-person point of view: why this matters to people who do the work.',
      'End with a plain question or takeaway, then at most three relevant hashtags on their own line.',
      'No emojis as bullet points, no "I am thrilled to announce".',
    ],
  },
  x: {
    network: 'x',
    label: 'X',
    limit: 280,
    linkCost: 23,
    linkInText: true,
    titled: false,
    norms: [
      'At most 250 characters of text, because the link is added after it.',
      'One or two punchy sentences: the single most interesting point, not a summary.',
      'At most one hashtag, and only if it is one people actually follow.',
    ],
  },
  reddit: {
    network: 'reddit',
    label: 'Reddit',
    linkInText: false,
    titled: true,
    titleLimit: 300,
    norms: [
      'title: plain and descriptive, under 120 characters, no clickbait, no hype words.',
      'text: the first comment, 2-5 sentences saying why it is worth reading and, if the poster made it, disclosing that plainly.',
      'subreddit: the single best-fitting real, active subreddit that allows link posts (name only, no r/).',
      'Redditors punish marketing: no superlatives, no calls to action, no hashtags, no emojis.',
    ],
  },
  hackernews: {
    network: 'hackernews',
    label: 'Hacker News',
    linkInText: false,
    titled: true,
    titleLimit: 80,
    norms: [
      "title: the page's own title, shortened to 80 characters if needed. Never editorialize.",
      'Prefix "Show HN: " only when the poster built the thing and people can try it.',
      'text: an optional first comment for a Show HN or the author, 2-4 plain sentences; empty otherwise.',
      'No marketing language, no emojis, no hashtags, no exclamation marks.',
    ],
  },
  facebook: {
    network: 'facebook',
    label: 'Facebook',
    limit: 63206,
    linkInText: false,
    titled: false,
    norms: [
      '1-3 short, conversational paragraphs, under 500 characters.',
      'The link preview shows the page title and image, so do not repeat the title.',
      'No hashtags.',
    ],
  },
  bluesky: {
    network: 'bluesky',
    label: 'Bluesky',
    limit: 300,
    linkInText: true,
    titled: false,
    norms: [
      'The whole post including the link is 300 characters, so keep the text under 200.',
      'Conversational and specific; Bluesky rewards a real opinion over an announcement.',
      'No hashtags unless one is genuinely used there.',
    ],
  },
  mastodon: {
    network: 'mastodon',
    label: 'Mastodon',
    limit: 500,
    linkCost: 23,
    linkInText: true,
    titled: false,
    norms: [
      'Under 400 characters of text.',
      'Plain and informative; the fediverse dislikes marketing tone.',
      'End with 1-3 CamelCase hashtags: Mastodon has no algorithm and hashtags are how posts are found.',
    ],
  },
  threads: {
    network: 'threads',
    label: 'Threads',
    limit: 500,
    linkInText: true,
    titled: false,
    norms: ['Under 350 characters of text.', 'Casual and conversational, one clear point.'],
  },
};

const URL_PATTERN = /https?:\/\/\S+/g;

/** The text a person pastes: the body, and the link where the network has no field for it. */
export function linkPostPasteText(network: LinkPostNetwork, body: string, url: string): string {
  const text = body.trim();
  if (!LINK_POST_FORMATS[network].linkInText || !url || text.includes(url)) return text;
  return text ? `${text}\n\n${url}` : url;
}

/**
 * The body back out of pasted text a person edited: the trailing link the
 * card added is dropped, so it is not added twice.
 */
export function linkPostBodyFromText(network: LinkPostNetwork, text: string, url: string): string {
  const trimmed = text.trim();
  if (!LINK_POST_FORMATS[network].linkInText || !url) return trimmed;
  return trimmed.endsWith(url) ? trimmed.slice(0, -url.length).trim() : trimmed;
}

/** Length as the network counts it: X and Mastodon charge a flat 23 for any link. */
export function linkPostLength(network: LinkPostNetwork, text: string): number {
  const cost = LINK_POST_FORMATS[network].linkCost;
  const chars = [...text];
  if (cost === undefined) return chars.length;
  const links = text.match(URL_PATTERN) ?? [];
  const linkChars = links.reduce((sum, link) => sum + [...link].length, 0);
  return chars.length - linkChars + links.length * cost;
}

export interface LinkPostCardInput {
  readonly network: LinkPostNetwork;
  /** The page being shared. */
  readonly url: string;
  /** The post (or, for Reddit and HN, the first comment). Without the link. */
  readonly body: string;
  readonly title?: string | null | undefined;
  readonly subreddit?: string | null | undefined;
  readonly mastodonInstance?: string | null | undefined;
}

export interface LinkPostCardView {
  readonly network: LinkPostNetwork;
  readonly label: string;
  /** Ready to paste. For Reddit and HN, the first comment. */
  readonly text: string;
  readonly title?: string;
  readonly subreddit?: string;
  readonly chars: number;
  readonly limit?: number;
  readonly overLimit: boolean;
  readonly openUrl?: string;
  readonly openLabel: string;
  readonly steps: readonly string[];
}

/** Everything a hand-off card shows for one network. Pure; the browser re-runs it after an edit. */
export function linkPostCard(input: LinkPostCardInput): LinkPostCardView {
  const format = LINK_POST_FORMATS[input.network];
  const body = input.body.trim();
  const text = linkPostPasteText(input.network, body, input.url);
  const title = input.title?.trim() || undefined;
  const subreddit =
    input.subreddit
      ?.trim()
      .replace(/^\/?r\//i, '')
      .replace(/[^A-Za-z0-9_]/g, '') || undefined;
  const chars = format.titled ? [...(title ?? '')].length : linkPostLength(input.network, text);
  const limit = format.titled ? format.titleLimit : format.limit;

  // The composer gets the body without the link: every builder adds the URL
  // itself, in whichever field the network has for it.
  const share = buildShareLink(input.network, {
    text: body,
    url: input.url,
    ...(title ? { title } : {}),
    ...(subreddit ? { subreddit } : {}),
    ...(input.mastodonInstance ? { mastodonInstance: input.mastodonInstance } : {}),
  });

  return {
    network: input.network,
    label: format.label,
    text,
    ...(title ? { title } : {}),
    ...(subreddit ? { subreddit } : {}),
    chars,
    ...(limit ? { limit } : {}),
    overLimit: limit !== undefined && chars > limit,
    ...(share ? { openUrl: share.url } : {}),
    openLabel: `Open ${format.label}`,
    steps: linkPostSteps(input.network, { hasText: body.length > 0, subreddit }),
  };
}

function linkPostSteps(
  network: LinkPostNetwork,
  options: { readonly hasText: boolean; readonly subreddit?: string | undefined },
): string[] {
  const label = LINK_POST_FORMATS[network].label;
  const done = 'Press Mark done.';

  switch (network) {
    case 'reddit':
      return [
        options.subreddit
          ? `Check that r/${options.subreddit} allows link posts (the rules are in its sidebar).`
          : 'Pick a subreddit that allows link posts.',
        `Open ${label}: the title and link are filled in.`,
        'Press Post.',
        ...(options.hasText ? ['Paste the text as the first comment.'] : []),
        done,
      ];
    case 'hackernews':
      return [
        `Open ${label}: the title and link are filled in.`,
        'Press submit.',
        ...(options.hasText ? ['Paste the text as the first comment.'] : []),
        done,
      ];
    case 'facebook':
      return [
        'Press Copy.',
        `Open ${label}: it shows the link preview.`,
        'Paste the text above the preview and press Post.',
        done,
      ];
    default:
      return [
        'Press Copy.',
        `Open ${label}: the post is already written in the composer.`,
        'If the box opened empty, paste. Read it once, then press Post.',
        done,
      ];
  }
}
