/**
 * One-click posts for the networks we are not allowed to automate.
 *
 * The capability matrix marks most social actions `manual_only`, and that is
 * not a gap waiting to be filled — automating LinkedIn messaging or X DMs
 * breaks those platforms' terms, and the PRD makes refusing to do it a
 * non-negotiable. But "the policy says a human must do it" was, in practice,
 * being delivered as "here is some text, good luck", which is why the whole
 * social side of the product went unused.
 *
 * A prefilled composer is the honest middle. The product does the writing and
 * the targeting; the human clicks once, reads what they are about to post, and
 * posts it themselves in the network's own interface, under their own account,
 * with their own judgement applied. Nothing here holds a credential, signs a
 * request, or talks to a network's API — every function returns a URL for a
 * browser to open.
 *
 * Deliberately pure and dependency-free so the same builders run in the API
 * (to record what was offered) and in the browser (to open it).
 */

export const SHARE_NETWORKS = [
  'x',
  'bluesky',
  'threads',
  'mastodon',
  'linkedin',
  'facebook',
  'reddit',
  'nextdoor',
  'telegram',
  'whatsapp',
  'hackernews',
  'email',
] as const;

export type ShareNetwork = (typeof SHARE_NETWORKS)[number];

export interface ShareInput {
  /** The post body. Trimmed to the network's limit by `buildShareLink`. */
  readonly text: string;
  /** A link to include. Required by the networks marked `requiresUrl`. */
  readonly url?: string;
  /** Used where a network separates a title from a body (Reddit, HN, email). */
  readonly title?: string;
  /** Mastodon instance to compose on. Ignored elsewhere. */
  readonly mastodonInstance?: string;
  /** Subreddit to post into, e.g. `smallbusiness`. Ignored elsewhere. */
  readonly subreddit?: string;
  /** Recipient for the mailto fallback. */
  readonly to?: string;
}

export interface ShareTarget {
  readonly network: ShareNetwork;
  readonly label: string;
  /** Maximum body length the network accepts, when it has one. */
  readonly limit?: number;
  /** True when the composer cannot be opened without a link. */
  readonly requiresUrl: boolean;
  /**
   * False where the network refuses to prefill body text.
   *
   * Facebook is the notable one: it has accepted only a URL since it removed
   * `quote`, so the user writes their own words there. Saying so in the UI is
   * better than shipping a button that silently drops the message.
   */
  readonly prefillsText: boolean;
}

export const SHARE_TARGETS: Readonly<Record<ShareNetwork, ShareTarget>> = {
  x: { network: 'x', label: 'X', limit: 280, requiresUrl: false, prefillsText: true },
  bluesky: {
    network: 'bluesky',
    label: 'Bluesky',
    limit: 300,
    requiresUrl: false,
    prefillsText: true,
  },
  threads: {
    network: 'threads',
    label: 'Threads',
    limit: 500,
    requiresUrl: false,
    prefillsText: true,
  },
  mastodon: {
    network: 'mastodon',
    label: 'Mastodon',
    limit: 500,
    requiresUrl: false,
    prefillsText: true,
  },
  linkedin: { network: 'linkedin', label: 'LinkedIn', requiresUrl: false, prefillsText: true },
  facebook: { network: 'facebook', label: 'Facebook', requiresUrl: true, prefillsText: false },
  reddit: { network: 'reddit', label: 'Reddit', requiresUrl: false, prefillsText: true },
  nextdoor: { network: 'nextdoor', label: 'Nextdoor', requiresUrl: false, prefillsText: true },
  telegram: { network: 'telegram', label: 'Telegram', requiresUrl: false, prefillsText: true },
  whatsapp: { network: 'whatsapp', label: 'WhatsApp', requiresUrl: false, prefillsText: true },
  hackernews: {
    network: 'hackernews',
    label: 'Hacker News',
    requiresUrl: true,
    prefillsText: false,
  },
  email: { network: 'email', label: 'Email', requiresUrl: false, prefillsText: true },
};

/**
 * Shortens to a limit without cutting a word in half.
 *
 * A post truncated mid-word reads as broken software rather than as a long
 * message, and these are messages sent in someone's own name.
 */
export function fitText(text: string, limit?: number): string {
  const trimmed = text.trim();
  if (!limit || trimmed.length <= limit) return trimmed;

  const cut = trimmed.slice(0, limit - 1);
  const lastBreak = cut.lastIndexOf(' ');
  return `${(lastBreak > limit * 0.6 ? cut.slice(0, lastBreak) : cut).trimEnd()}…`;
}

function q(value: string): string {
  return encodeURIComponent(value);
}

/** A hostname with no scheme or path, for a Mastodon instance the user typed. */
function instanceHost(value: string | undefined): string {
  const raw = (value ?? 'mastodon.social').trim().replace(/^https?:\/\//, '');
  const host = raw.split('/')[0] ?? '';
  return /^[a-z0-9.-]+$/i.test(host) && host.includes('.') ? host : 'mastodon.social';
}

export interface ShareLink {
  readonly network: ShareNetwork;
  readonly label: string;
  readonly url: string;
  /** The body as it will arrive in the composer, after any trimming. */
  readonly text: string;
  /** Set when the network cannot take everything we wanted to give it. */
  readonly note?: string;
}

/**
 * The compose URL for one network, or undefined when it cannot be built.
 *
 * Undefined rather than a broken link: Facebook and Hacker News genuinely
 * cannot open a composer without a URL, and a button that opens an error page
 * is worse than a button that is not offered.
 */
export function buildShareLink(network: ShareNetwork, input: ShareInput): ShareLink | undefined {
  const target = SHARE_TARGETS[network];
  if (target.requiresUrl && !input.url) return undefined;

  const text = fitText(input.text, target.limit);
  const url = input.url ?? '';
  const title = input.title?.trim() || fitText(input.text, 120);

  const link = (composed: string, note?: string): ShareLink => ({
    network,
    label: target.label,
    url: composed,
    text: target.prefillsText ? text : '',
    ...(note ? { note } : {}),
    ...(!note && target.limit && input.text.trim().length > target.limit
      ? { note: `shortened to ${target.limit} characters` }
      : {}),
  });

  switch (network) {
    case 'x':
      return link(`https://x.com/intent/post?text=${q(text)}${url ? `&url=${q(url)}` : ''}`);

    case 'bluesky':
      // Bluesky counts the URL against the same 300 characters, so it goes in
      // the text rather than as a separate parameter it does not have.
      return link(
        `https://bsky.app/intent/compose?text=${q(fitText(url ? `${text} ${url}` : text, 300))}`,
      );

    case 'threads':
      return link(
        `https://www.threads.net/intent/post?text=${q(text)}${url ? `&url=${q(url)}` : ''}`,
      );

    case 'mastodon':
      return link(
        `https://${instanceHost(input.mastodonInstance)}/share?text=${q(url ? `${text} ${url}` : text)}`,
      );

    case 'linkedin':
      // `shareActive=true` opens LinkedIn's own composer with the text in it.
      // The human posts it; nothing is submitted on their behalf, which is what
      // keeps this on the right side of the no-LinkedIn-automation rule.
      return link(
        `https://www.linkedin.com/feed/?shareActive=true&text=${q(url ? `${text}\n\n${url}` : text)}`,
      );

    case 'facebook':
      return link(
        `https://www.facebook.com/sharer/sharer.php?u=${q(url)}`,
        'Facebook only accepts a link — write your own words in its composer',
      );

    case 'reddit': {
      const base = input.subreddit
        ? `https://www.reddit.com/r/${encodeURIComponent(input.subreddit)}/submit`
        : 'https://www.reddit.com/submit';
      // A link post when there is a URL, a self post otherwise. Reddit ignores
      // `text` on a link submission, so sending both loses the message.
      return link(
        url
          ? `${base}?title=${q(title)}&url=${q(url)}`
          : `${base}?title=${q(title)}&text=${q(text)}&selftext=true`,
      );
    }

    case 'nextdoor':
      return link(
        `https://nextdoor.com/sharekit/?source=outreachgraph&body=${q(text)}` +
          (url ? `&url=${q(url)}` : ''),
      );

    case 'telegram':
      return link(`https://t.me/share/url?url=${q(url)}&text=${q(text)}`);

    case 'whatsapp':
      return link(`https://wa.me/?text=${q(url ? `${text} ${url}` : text)}`);

    case 'hackernews':
      return link(
        `https://news.ycombinator.com/submitlink?u=${q(url)}&t=${q(fitText(title, 80))}`,
        'Hacker News takes a title and a link only',
      );

    case 'email':
      return link(
        `mailto:${q(input.to ?? '')}?subject=${q(title)}&body=${q(url ? `${text}\n\n${url}` : text)}`,
      );
  }
}

/**
 * Every composer that can be built for this message.
 *
 * Ordered by where outreach like this actually gets posted rather than
 * alphabetically, because the list is read top-down and the first two or three
 * are the ones anyone clicks.
 */
export function buildShareLinks(input: ShareInput): ShareLink[] {
  const links: ShareLink[] = [];

  for (const network of SHARE_NETWORKS) {
    const link = buildShareLink(network, input);
    if (link) links.push(link);
  }

  return links;
}
