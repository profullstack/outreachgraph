/**
 * What a company's site runs, read from its own HTML.
 *
 * BuiltWith-style detection, without BuiltWith: the scripts, stylesheets and
 * markers a page loads name the tools behind it (a chat widget, a CRM's form
 * embed, a scheduling link, a store platform). This is what makes a
 * "competitor switchers" list possible — Hunter's Technology filter — and,
 * because each match keeps the exact marker it came from, a claim like "your
 * site runs Intercom" is grounded in something the page itself shows.
 *
 * Deterministic and offline: one pass of regular expressions over HTML the
 * crawl already fetched. A tool is named only on a marker specific to it.
 */

export interface DetectedTechnology {
  readonly name: string;
  readonly category: string;
  /** The text on the page that identified it. */
  readonly evidence: string;
}

const FINGERPRINTS: ReadonlyArray<readonly [string, string, RegExp]> = [
  // Chat and support
  ['Intercom', 'support', /widget\.intercom\.io|js\.intercomcdn\.com/i],
  ['Drift', 'support', /js\.driftt\.com|drift\.com\/include/i],
  ['Zendesk', 'support', /static\.zdassets\.com|\.zendesk\.com\/embeddable/i],
  ['Crisp', 'support', /client\.crisp\.chat/i],
  ['Freshdesk', 'support', /widget\.freshworks\.com|freshchat\.com/i],
  ['tawk.to', 'support', /embed\.tawk\.to/i],
  ['LiveChat', 'support', /cdn\.livechatinc\.com/i],
  ['Help Scout', 'support', /beacon-v2\.helpscout\.net/i],
  ['Tidio', 'support', /code\.tidio\.co/i],
  // CRM and marketing automation
  ['HubSpot', 'crm', /js\.hs-scripts\.com|js\.hsforms\.net|js\.hs-analytics\.net/i],
  ['Salesforce Pardot', 'crm', /pi\.pardot\.com|go\.pardot\.com/i],
  ['Marketo', 'crm', /munchkin\.marketo\.net|mktoForms/i],
  ['ActiveCampaign', 'crm', /trackcmp\.net|activehosted\.com/i],
  ['Mailchimp', 'email', /chimpstatic\.com|list-manage\.com/i],
  ['Klaviyo', 'email', /static\.klaviyo\.com/i],
  ['ConvertKit', 'email', /convertkit\.com\/[\w/-]*\.js|ck\.page/i],
  ['Customer.io', 'email', /assets\.customer\.io/i],
  ['Apollo', 'sales', /assets\.apollo\.io/i],
  ['Clearbit', 'sales', /tag\.clearbitscripts\.com|x\.clearbitjs\.com/i],
  // Analytics and product
  [
    'Google Analytics',
    'analytics',
    /googletagmanager\.com\/gtag|google-analytics\.com\/analytics\.js/i,
  ],
  ['Google Tag Manager', 'analytics', /googletagmanager\.com\/gtm\.js/i],
  ['Segment', 'analytics', /cdn\.segment\.com/i],
  ['Mixpanel', 'analytics', /cdn\.mxpnl\.com|mixpanel\.com\/libs/i],
  ['Amplitude', 'analytics', /cdn\.amplitude\.com/i],
  ['Heap', 'analytics', /cdn\.heapanalytics\.com/i],
  ['Hotjar', 'analytics', /static\.hotjar\.com/i],
  ['FullStory', 'analytics', /fullstory\.com\/s\/fs\.js|edge\.fullstory\.com/i],
  ['PostHog', 'analytics', /posthog\.com\/static|i\.posthog\.com/i],
  ['Plausible', 'analytics', /plausible\.io\/js/i],
  ['Microsoft Clarity', 'analytics', /clarity\.ms\/tag/i],
  // Scheduling and forms
  ['Calendly', 'scheduling', /assets\.calendly\.com|calendly\.com\/[\w-]+/i],
  ['Chili Piper', 'scheduling', /js\.chilipiper\.com/i],
  ['Typeform', 'forms', /embed\.typeform\.com/i],
  ['Jotform', 'forms', /jotform\.com\/jsform/i],
  // Payments and commerce
  ['Stripe', 'payments', /js\.stripe\.com/i],
  ['Paddle', 'payments', /cdn\.paddle\.com/i],
  ['Chargebee', 'payments', /js\.chargebee\.com/i],
  ['Shopify', 'ecommerce', /cdn\.shopify\.com|myshopify\.com/i],
  ['WooCommerce', 'ecommerce', /woocommerce/i],
  ['BigCommerce', 'ecommerce', /bigcommerce\.com/i],
  // CMS and site builders
  ['WordPress', 'cms', /\/wp-content\/|\/wp-includes\//i],
  ['Webflow', 'cms', /assets\.website-files\.com|data-wf-page/i],
  ['Wix', 'cms', /static\.wixstatic\.com|wix\.com/i],
  ['Squarespace', 'cms', /static1\.squarespace\.com/i],
  ['Framer', 'cms', /framerusercontent\.com/i],
  ['Ghost', 'cms', /content="Ghost /i],
  ['Next.js', 'framework', /\/_next\/static\//i],
  // Hosting and CDN
  ['Cloudflare', 'cdn', /cdnjs\.cloudflare\.com|challenges\.cloudflare\.com/i],
  ['Vercel', 'hosting', /vercel-insights|\/_vercel\//i],
  ['Netlify', 'hosting', /netlify/i],
];

export function detectTechnologies(html: string): DetectedTechnology[] {
  if (!html) return [];
  const found: DetectedTechnology[] = [];
  for (const [name, category, pattern] of FINGERPRINTS) {
    const match = pattern.exec(html);
    if (match) found.push({ name, category, evidence: match[0].slice(0, 120) });
  }
  return found;
}

/** Detected tools that are one of the competitors the product names, matched by name. */
export function competitorMatches(
  detected: readonly DetectedTechnology[],
  competitors: readonly string[],
): DetectedTechnology[] {
  const wanted = competitors.map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return [];
  return detected.filter((tech) => {
    const name = tech.name.toLowerCase();
    return wanted.some(
      (competitor) =>
        name === competitor ||
        name.startsWith(`${competitor} `) ||
        competitor.startsWith(`${name} `),
    );
  });
}
