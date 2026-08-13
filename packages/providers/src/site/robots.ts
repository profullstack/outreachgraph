/**
 * robots.txt, read the way a well-behaved crawler reads it.
 *
 * This is not politeness theatre. The policy engine permits `website/observe`
 * as "permitted public web retrieval", and what makes a retrieval permitted is
 * partly that the site said it was. A crawler that ignores robots is how a
 * research tool becomes an abuse report.
 *
 * Deliberately small: only the directives that decide whether one URL may be
 * fetched. No sitemap discovery, no wildcards beyond `*` and `$`, which is what
 * the original specification defines and what almost every file actually uses.
 */

export interface RobotsRules {
  /** Path prefixes this agent must not fetch. */
  readonly disallow: readonly string[];
  /** Prefixes that override a broader disallow. */
  readonly allow: readonly string[];
  /** Seconds the site asked callers to wait between requests. */
  readonly crawlDelaySeconds?: number;
}

const EMPTY: RobotsRules = { disallow: [], allow: [] };

/**
 * Parses robots.txt for one user-agent.
 *
 * A group naming our agent wins outright; otherwise the `*` group applies. That
 * is the precedence the specification describes, and it matters: a site that
 * blocks everyone but allows us has said something specific, and a site that
 * blocks us specifically has said something even more specific.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const wanted = userAgent.toLowerCase();

  const groups: { agents: string[]; disallow: string[]; allow: string[]; delay?: number }[] = [];
  let current: (typeof groups)[number] | undefined;
  // Consecutive `User-agent` lines share one group; a rule line closes the run.
  let collectingAgents = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0]?.trim() ?? '';
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator < 0) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!collectingAgents || !current) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
        collectingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (!current) continue;
    collectingAgents = false;

    if (field === 'disallow') current.disallow.push(value);
    else if (field === 'allow') current.allow.push(value);
    else if (field === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) current.delay = delay;
    }
  }

  const named = groups.find((group) =>
    group.agents.some((agent) => agent !== '*' && wanted.includes(agent)),
  );
  const wildcard = groups.find((group) => group.agents.includes('*'));
  const chosen = named ?? wildcard;

  if (!chosen) return EMPTY;

  return {
    // An empty `Disallow:` means "nothing is disallowed" and must not be read
    // as the prefix that matches every path.
    disallow: chosen.disallow.filter((rule) => rule !== ''),
    allow: chosen.allow.filter((rule) => rule !== ''),
    ...(chosen.delay === undefined ? {} : { crawlDelaySeconds: chosen.delay }),
  };
}

function matches(rule: string, path: string): boolean {
  const anchored = rule.endsWith('$');
  const pattern = anchored ? rule.slice(0, -1) : rule;
  const segments = pattern.split('*');

  let index = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment === '') continue;

    const found = i === 0 ? (path.startsWith(segment) ? 0 : -1) : path.indexOf(segment, index);
    if (found < 0) return false;
    index = found + segment.length;
  }

  // `$` means the rule has to consume the path to its end.
  if (anchored && index !== path.length) return false;
  return true;
}

/**
 * Whether one path may be fetched.
 *
 * The longest matching rule wins, and a tie goes to `Allow` — both are what the
 * specification says, and together they are what lets a site disallow a whole
 * tree while opening one page inside it.
 */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  let bestAllow = -1;
  let bestDisallow = -1;

  for (const rule of rules.allow) {
    if (matches(rule, path)) bestAllow = Math.max(bestAllow, rule.length);
  }
  for (const rule of rules.disallow) {
    if (matches(rule, path)) bestDisallow = Math.max(bestDisallow, rule.length);
  }

  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}
