/**
 * Which domain a lead is, and whether it is a lead at all.
 *
 * Every importer reduces what its source gave (a homepage URL, a bare store
 * domain, a ranked host) to one key: the domain a company registered, without
 * `www`. That key is what `companies.domain` is unique on, so the same company
 * arriving from Wikidata, the Majestic Million and a SaaS directory is one row.
 *
 * The filters are rules, not a model, so importing a million rows costs no
 * model calls: infrastructure hosts (CDNs, ad and analytics beacons, link
 * shorteners), governments and the military (not buyers), adult sites, and
 * pages people rent on someone else's platform (`x.wordpress.com` is a person
 * on WordPress, not a company) are dropped before anything is stored.
 */

/** Second-level labels under which a two-letter country code takes three labels. */
const SECOND_LEVEL = /^(co|com|org|net|ac|gov|edu|ltd|plc|gob|nic|or|ne|go|mil)$/;

/** `shop.acme.co.uk` -> `acme.co.uk`: the domain a company registered. */
export function registrableDomain(host: string): string {
  const labels = host
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.');
  const secondLast = labels[labels.length - 2] ?? '';
  const last = labels[labels.length - 1] ?? '';
  const keep = labels.length >= 3 && SECOND_LEVEL.test(secondLast) && last.length === 2 ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/**
 * Platforms whose subdomains and paths are other people's pages. A subdomain
 * of one is a person renting space, never the platform, so it is dropped. The
 * platform's own root (a Wikidata entry for WordPress) is a company and
 * survives, unless the caller drops roots too: a directory item that points at
 * `anchor.fm` means "this show is on Anchor", not "Anchor is a company".
 */
export const HOSTED_PLATFORMS: ReadonlySet<string> = new Set([
  'wordpress.com',
  'blogspot.com',
  'blogger.com',
  'github.io',
  'github.com',
  'gitlab.io',
  'gitlab.com',
  'substack.com',
  'medium.com',
  'tumblr.com',
  'wixsite.com',
  'wix.com',
  'squarespace.com',
  'weebly.com',
  'webflow.io',
  'notion.site',
  'notion.so',
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
  'pages.dev',
  'workers.dev',
  'carrd.co',
  'linktr.ee',
  'myshopify.com',
  'google.com',
  'youtube.com',
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'tiktok.com',
  'reddit.com',
  'patreon.com',
  'ko-fi.com',
  'buymeacoffee.com',
  'gumroad.com',
  'beehiiv.com',
  'ghost.io',
  'typepad.com',
  'livejournal.com',
  'over-blog.com',
  'jimdo.com',
  'jimdofree.com',
  'strikingly.com',
  'webnode.com',
  'yolasite.com',
  'bandcamp.com',
  'soundcloud.com',
  'spotify.com',
  'apple.com',
  'amazon.com',
  'anchor.fm',
  'buzzsprout.com',
  'libsyn.com',
  'libsynpro.com',
  'podbean.com',
  'simplecast.com',
  'megaphone.fm',
  'transistor.fm',
  'captivate.fm',
  'podtrac.com',
  'omny.fm',
  'omnycontent.com',
  'acast.com',
  'spreaker.com',
  'iheart.com',
  'audioboom.com',
  'podomatic.com',
  'blubrry.com',
  'blubrry.net',
  'redcircle.com',
  'art19.com',
  'castos.com',
  'fireside.fm',
  'pinecast.co',
  'rss.com',
  'feedburner.com',
  'podcastics.com',
  'podigee.io',
  'ausha.co',
  'hearthis.at',
  'mixcloud.com',
  'vimeo.com',
  'twitch.tv',
  'discord.gg',
  'discord.com',
  't.me',
  'npmjs.com',
  'pypi.org',
  'crates.io',
  'huggingface.co',
  'mozilla.org',
  'wikipedia.org',
  'wikimedia.org',
  'archive.org',
  'nichedb.dev',
  'rssamplifier.com',
  'saasrow.com',
  'slickdeals.net',
  'c0upons.com',
  'coingecko.com',
]);

/**
 * Platforms and global megacorps whose root is never a lead, as a root or as
 * anything else. The top of every popularity list is these (Majestic opens
 * google.com, instagram.com, twitter.com, linkedin.com, apple.com), and none
 * of them is a buyer a campaign can reach. Shared with the site audits
 * (`auditDomain`), which skip the same roots: auditing gmail.com's homepage
 * says nothing about anyone with a gmail address.
 */
export const MEGA_PLATFORMS: ReadonlySet<string> = new Set([
  // Mailbox providers.
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'mail.ru',
  'yandex.ru',
  'yandex.com',
  'gmx.com',
  'gmx.de',
  'web.de',
  'zoho.com',
  'qq.com',
  '163.com',
  // Search, social, messaging, video.
  'google.com',
  'google.de',
  'google.co.uk',
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'blogger.com',
  'blogspot.com',
  'g.page',
  'g.co',
  'goo.gl',
  'forms.gle',
  'share.google',
  'facebook.com',
  'fb.com',
  'instagram.com',
  'whatsapp.com',
  'wa.me',
  'threads.net',
  'meta.com',
  'messenger.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'lnkd.in',
  'tiktok.com',
  'snapchat.com',
  'pinterest.com',
  'reddit.com',
  'tumblr.com',
  'quora.com',
  'discord.com',
  'discord.gg',
  'telegram.org',
  'telegram.me',
  't.me',
  'line.me',
  'vk.com',
  'vkontakte.ru',
  'ok.ru',
  'weibo.com',
  'bsky.app',
  'mastodon.social',
  'twitch.tv',
  'vimeo.com',
  'dailymotion.com',
  'flickr.com',
  'imgur.com',
  'bilibili.com',
  'zoom.us',
  'skype.com',
  'slack.com',
  'baidu.com',
  'bing.com',
  'duckduckgo.com',
  'naver.com',
  // Big tech, cloud and developer platforms.
  'apple.com',
  'microsoft.com',
  'office.com',
  'live.net',
  'sharepoint.com',
  'cloud.microsoft',
  'aka.ms',
  'windows.com',
  'xbox.com',
  'amazon.com',
  'amazon.co.uk',
  'amazon.de',
  'amzn.to',
  'aws.amazon.com',
  'alibaba.com',
  'aliexpress.com',
  'aliyun.com',
  'taobao.com',
  'tmall.com',
  'jd.com',
  'tencent.com',
  'samsung.com',
  'sony.com',
  'ibm.com',
  'oracle.com',
  'adobe.com',
  'salesforce.com',
  'nvidia.com',
  'intel.com',
  'cisco.com',
  'dell.com',
  'hp.com',
  'cloudflare.com',
  'akamai.com',
  'github.com',
  'github.io',
  'gitlab.com',
  'bitbucket.org',
  'stackoverflow.com',
  'stackexchange.com',
  'atlassian.com',
  'atlassian.net',
  'openai.com',
  'chatgpt.com',
  'anthropic.com',
  'mozilla.org',
  'opera.com',
  'godaddy.com',
  'namecheap.com',
  'wordpress.com',
  'wordpress.org',
  'wix.com',
  'wixsite.com',
  'squarespace.com',
  'shopify.com',
  'myshopify.com',
  'medium.com',
  'substack.com',
  'notion.site',
  'notion.so',
  'dropbox.com',
  'box.com',
  'paypal.com',
  'stripe.com',
  'ebay.com',
  'etsy.com',
  'netflix.com',
  'spotify.com',
  'soundcloud.com',
  'uber.com',
  'airbnb.com',
  'booking.com',
  'tripadvisor.com',
  'yelp.com',
  'trustpilot.com',
  'linktr.ee',
  'list-manage.com',
  'mailchimp.com',
  'issuu.com',
  'scribd.com',
  'slideshare.net',
  'behance.net',
  'dribbble.com',
  'unsplash.com',
  // Reference and archives.
  'wikipedia.org',
  'wikimedia.org',
  'wikidata.org',
  'wiktionary.org',
  'wikibooks.org',
  'archive.org',
  'imdb.com',
  'britannica.com',
  'doi.org',
  'researchgate.net',
  'academia.edu',
  'arxiv.org',
  'openstreetmap.org',
  'w3.org',
  'ietf.org',
  'iso.org',
]);

/**
 * Infrastructure: CDNs, ad and analytics beacons, link shorteners, DNS and
 * registries. Popular in any link graph, a buyer of nothing we sell.
 */
const INFRASTRUCTURE: ReadonlySet<string> = new Set([
  'akamai.net',
  'akamaihd.net',
  'akamaized.net',
  'akamaiedge.net',
  'edgekey.net',
  'edgesuite.net',
  'cloudfront.net',
  'amazonaws.com',
  'awsstatic.com',
  'azureedge.net',
  'azurewebsites.net',
  'windows.net',
  'msecnd.net',
  'fastly.net',
  'fastlylb.net',
  'cloudflare.net',
  'cloudflare-dns.com',
  'googleapis.com',
  'gstatic.com',
  'googleusercontent.com',
  'googlevideo.com',
  'ggpht.com',
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagmanager.com',
  'googletagservices.com',
  'google-analytics.com',
  'app-measurement.com',
  'fbcdn.net',
  'fbsbx.com',
  'twimg.com',
  'ytimg.com',
  'licdn.com',
  'jsdelivr.net',
  'unpkg.com',
  'cdnjs.com',
  'bootstrapcdn.com',
  'gravatar.com',
  'wp.com',
  'w.org',
  'schema.org',
  'w3.org',
  'ogp.me',
  'purl.org',
  'addthis.com',
  'sharethis.com',
  'addtoany.com',
  'disquscdn.com',
  'scorecardresearch.com',
  'quantserve.com',
  'adnxs.com',
  'criteo.net',
  'nr-data.net',
  'statcounter.com',
  'histats.com',
  't.co',
  'goo.gl',
  'bit.ly',
  'ow.ly',
  'tinyurl.com',
  'is.gd',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  'shorturl.at',
  'root-servers.net',
  'gtld-servers.net',
  'in-addr.arpa',
  'example.com',
  'example.org',
  'example.net',
]);

const ADULT = /(porn|xxx|hentai|xvideo|xnxx|redtube|youporn|camgirl|nude|escort|onlyfans|sexcam)/;

/** Governments and the military: public bodies, not customers. */
const PUBLIC_BODY = /(^|\.)(gov|mil|gouv|gob|govt)(\.[a-z]{2})?$|\.(int|arpa)$/;

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The hostname a URL or bare domain names, lowercased, without `www.`. */
export function hostFrom(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\d?\./, '');
  if (!HOST_PATTERN.test(host)) return null;
  // An address, not a name.
  if (/^\d+(\.\d+){3}$/.test(host)) return null;
  return host;
}

export interface LeadDomainOptions {
  /** Drop a hosted platform's own root too, not just its subdomains. */
  readonly dropPlatformRoots?: boolean;
}

function inSet(set: ReadonlySet<string>, host: string): boolean {
  if (set.has(host)) return true;
  const labels = host.split('.');
  for (let i = 1; i < labels.length - 1; i += 1) {
    if (set.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

/**
 * The lead domain for a URL or a bare domain, or null when it is not a lead:
 * unparseable, infrastructure, a public body, adult, a megacorp or platform
 * (`MEGA_PLATFORMS`), or a page on a hosted platform.
 */
export function leadDomain(
  value: string | null | undefined,
  options: LeadDomainOptions = {},
): string | null {
  const host = hostFrom(value);
  if (!host) return null;
  const domain = registrableDomain(host);
  if (!domain.includes('.')) return null;
  if (inSet(INFRASTRUCTURE, host)) return null;
  if (PUBLIC_BODY.test(domain)) return null;
  if (ADULT.test(domain)) return null;
  // Anything carrying "cdn" in its registered name is a delivery network.
  if ((domain.split('.')[0] ?? '').includes('cdn')) return null;
  // A megacorp or platform is not a lead, root or not.
  if (inSet(MEGA_PLATFORMS, host)) return null;
  if (inSet(HOSTED_PLATFORMS, host)) {
    if (options.dropPlatformRoots) return null;
    // The platform itself is a company; a page on it is somebody else's.
    if (host !== domain || !HOSTED_PLATFORMS.has(domain)) return null;
  }
  return domain;
}

/**
 * Generic and vanity ccTLDs: registered for the letters, not the place, so
 * they say nothing about where a company is.
 */
const VANITY_CCTLDS: ReadonlySet<string> = new Set([
  'io',
  'co',
  'ai',
  'me',
  'tv',
  'fm',
  'ly',
  'gg',
  'sh',
  'to',
  'cc',
  'ws',
  'la',
  'so',
  'am',
  'im',
  'vc',
  'st',
  'gl',
  'ms',
  'nu',
  'tk',
  'ml',
  'ga',
  'cf',
  'gq',
  'cx',
  'ac',
  'af',
  'bz',
  'ag',
  'lc',
  'mu',
  'sc',
  'pw',
  'eu',
]);

/** ISO 3166 alpha-2 country from a country-code top-level domain (`.uk` is GB), or null. */
export function countryFromDomain(domain: string): string | null {
  const tld = domain.split('.').pop() ?? '';
  if (!/^[a-z]{2}$/.test(tld) || VANITY_CCTLDS.has(tld)) return null;
  return tld === 'uk' ? 'GB' : tld.toUpperCase();
}
