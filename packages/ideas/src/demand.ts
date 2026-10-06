/**
 * Demand: finding people who asked for "a site/app/tool that does X", and
 * grouping them into ideas worth building.
 *
 * Ported from myna asks (mynaposter PR #127), the pipeline that found the posts
 * typeheard.com was built for. Pure functions only; storage, the scan schedule
 * and the build hand-off live in the API.
 *
 *   classifyAsk   is this post somebody asking for a tool, how sure, what do they want
 *   askTerms      what an ask is about, as words
 *   bestIdea      the existing idea an ask belongs to, if any
 *   demandScore   people count most, then attention
 *
 * Patterns, not a model, find candidates: this runs over every post of a
 * couple of dozen subreddits. A model (the judge, see judge.ts) takes a second
 * look and throws out the founders pitching their own tool in the shape of a
 * question.
 */

// ------------------------------------------------------------------ words

const STOPWORDS = new Set(
  (
    'a about above after again against all am an and any are aren as at be because been before being below between both but by ' +
    'can cannot could couldn did didn do does doesn doing don down during each few for from further had hadn has hasn have haven ' +
    'having he her here hers herself him himself his how i if in into is isn it its itself just me more most my myself no nor not ' +
    'now of off on once only or other ought our ours ourselves out over own same shan she should shouldn so some such than that ' +
    'the their theirs them themselves then there these they this those through to too under until up very was wasn we were weren ' +
    'check try via still even back going done say said tell asked ask well right sure maybe thanks please ' +
    'across within without around toward towards along upon per plus versus unless whether though although ' +
    'what when where which while who whom why will with won would wouldn you your yours yourself yourselves ' +
    'new now out ship shipped ships shipping release released releases version update updated updates post posted posting blog ' +
    'read more here link thread today week day time make makes made get gets got use used using one two three next last also ' +
    'like want need know think see look going come take way thing things lot bit really much many good great best better'
  ).split(/\s+/),
);

/** Ordinary English that cannot be a subject on its own. */
const COMMON = new Set(
  (
    'free cost costs money price paid pay pays cheap expensive worth spend spent buy bought sell sold ' +
    'play playing played game games anyone someone everyone nobody everybody people person folks ' +
    'thing things stuff bit lots plenty part parts side sides place places home house world life lives living ' +
    'week weeks month months year years day days hour hours minute minutes today tomorrow yesterday ' +
    'big small large little long short high low easy hard simple quick fast slow early late ' +
    'full empty half whole every each both few many much more most less least ' +
    'old young real true false right wrong sure certain clear obvious ' +
    'start starts started stop stops stopped keep keeps kept turn turns turned ' +
    'help helps helped need needs needed want wants wanted try tries tried ' +
    'made makes making take takes taken give gives given come comes coming ' +
    'look looks looking feel feels felt seem seems find finds found ' +
    'built build builds open opens opened close closed closes run running ' +
    'work works working done doing goes going gone ' +
    'talk talks said says saying tell tells told ask asks asked ' +
    'call calls called move moves moved change changes changed ' +
    'problem problems question questions answer answers idea ideas reason reasons ' +
    'actually probably maybe perhaps definitely honestly literally basically ' +
    'anything something nothing everything someone anybody ' +
    'better best worse worst great good bad nice cool awesome amazing'
  ).split(/\s+/),
);

export const contentful = (term: string): boolean =>
  term.split(' ').some((word) => word && !COMMON.has(word));

const clean = (text: string): string =>
  text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[\w.@-]+/g, ' ')
    .replace(/[`*_~>#[\]()|]/g, ' ')
    .toLowerCase();

const isTerm = (word: string): boolean =>
  word.length >= 3 && word.length <= 32 && !STOPWORDS.has(word) && !/^\d+$/.test(word);

/** The words of a text, in order, with the noise gone. */
export function termsOf(text: string): string[] {
  return clean(text)
    .split(/[^a-z0-9+#.-]+/)
    .map((word) => word.replace(/^[#.-]+|[.-]+$/g, ''))
    .filter(Boolean)
    .filter(isTerm);
}

// ------------------------------------------------------------------ detection

/** The things a person asks for. "Is there a ___" only counts when the blank is one of these. */
const NOUN =
  '(?:web ?apps?|apps?|sites?|websites?|tools?|services?|software|platforms?|programs?|extensions?|plugins?|add-?ons?|bots?|apis?|saas|' +
  'solutions?|alternatives?|products?|marketplaces?|directory|directories|trackers?|dashboards?|cli|utility|utilities|providers?|subscriptions?|' +
  'managers?|editors?|generators?|planners?|organi[sz]ers?|schedulers?|readers?|players?|launchers?|converters?|downloaders?|clients?|viewers?|' +
  'calculators?|finders?|builders?|makers?|blockers?|recorders?|scanners?|monitors?|notifiers?|aggregators?|crm|erp|widgets?|keyboards?|browsers?)';
const GAP = "(?:[\\w'+-]+\\s+){0,5}?";
const ART = '(?:a|an|any|some|good|decent)';
const rx = (source: string): RegExp => new RegExp(source, 'i');

const PATTERNS: Array<[kind: string, weight: number, pattern: RegExp]> = [
  ['is-there', 0.65, rx(`\\b(?:is|are) there (?:${ART}\\s+)?${GAP}${NOUN}\\b`)],
  [
    'does-it-exist',
    0.6,
    rx(`\\bdoes (?:this|something like this|such an? \\w+|a \\w+ like this) (?:even )?exist\\b`),
  ],
  [
    'anyone-know',
    0.65,
    rx(
      `\\b(?:does|do) (?:anyone|anybody|any of you|you guys|y'?all) know (?:of )?${ART}?\\s*${GAP}${NOUN}\\b`,
    ),
  ],
  [
    'anyone-know',
    0.6,
    rx(`\\b(?:anyone|anybody) (?:know|knows|recommend|use) (?:of )?${ART}\\s+${GAP}${NOUN}\\b`),
  ],
  ['looking-for', 0.6, rx(`\\b(?:looking|searching|hunting) for ${ART}?\\s*${GAP}${NOUN}\\b`)],
  [
    'wish',
    0.6,
    rx(
      `\\b(?:i )?wish (?:there (?:was|were|existed)|someone (?:would|made|built)|i could find)\\b`,
    ),
  ],
  [
    'someone-build',
    0.6,
    rx(`\\b(?:someone|somebody) (?:should|needs to|please|pls) (?:make|build|create)\\b`),
  ],
  [
    'recommend',
    0.55,
    rx(`\\b(?:recommendations?|suggestions?|recs) (?:for|on) ${ART}?\\s*${GAP}${NOUN}\\b`),
  ],
  [
    'recommend',
    0.55,
    rx(
      `\\bcan (?:anyone|someone|you|somebody) (?:recommend|suggest|point me to) ${ART}?\\s*${GAP}${NOUN}\\b`,
    ),
  ],
  [
    'need',
    0.5,
    rx(
      `\\bi(?:'m| am)? (?:need|want|looking for) (?:a|an|some)\\s+${GAP}${NOUN} (?:that|which|to|for|where|with)\\b`,
    ),
  ],
  [
    'what-do-you-use',
    0.5,
    rx(
      `\\bwhat (?:app|tool|site|software|service|platform)s? (?:do|does|are|should) (?:you|everyone|people|i|y'?all)\\b`,
    ),
  ],
  ['recommend', 0.55, rx(`\\b${NOUN} (?:recommendations?|suggestions?|recs)\\b`)],
  [
    'best-for',
    0.5,
    rx(`\\b(?:best|any good|good) ${GAP}${NOUN}(?:\\s+(?:for|to|that|with)\\b|\\s*\\?)`),
  ],
  [
    'how-do-you-manage',
    0.4,
    rx(
      `\\bhow (?:do|does|are) (?:you|everyone|people|y'?all|small businesses|agencies|teams|others) (?:keep track of|track|manage|handle|organi[sz]e|automate|monitor|schedule)\\b`,
    ),
  ],
  ['alternative', 0.45, rx(`\\b(?:alternatives?|replacement) (?:to|for) [\\w.-]+`)],
  ['would-pay', 0.45, rx(`\\bi(?:'d| would) (?:happily |gladly )?pay for ${ART}?\\s*\\w+`)],
];

/** Posts that use the words of an ask but are somebody selling or researching. */
const PITCHES: Array<[weight: number, pattern: RegExp]> = [
  [
    0.35,
    /\b(?:i|we)(?:'ve| have)? (?:just |finally |recently |solo-?|also )?(?:built|made|launched|created|shipped|released|coded|developed)\b/i,
  ],
  [0.3, /\b(?:so i|so we|and i|and we) (?:\w+-)?(?:built|made|launched|created)\b/i],
  [
    0.3,
    /\b(?:i'?m|we'?re|i am|we are) (?:building|making|launching|creating|developing|working on)\b/i,
  ],
  [
    0.3,
    /\bmy (?:app|tool|saas|startup|side ?project|product|extension|platform|website|site|mvp)\b/i,
  ],
  [
    0.3,
    /\b(?:roast my|feedback on my|check out my|beta testers?|waitlist|promo code|discount code)\b/i,
  ],
  [0.5, /\[(?:hiring|for hire|task|offer)\]|\b(?:we'?re hiring|for hire)\b/i],
  [
    0.45,
    /\b(?:would you (?:\w+ ){0,3}(?:use|pay|buy)|willing to pay|is there (?:a )?(?:market|demand)|like mine|my idea|what (?:kind of )?(?:apps?|problems?|software|tools?)\b.{0,40}\b(?:would|do) you|brainstorm(?:ing)?|(?:startup|saas|app) ideas|looking for (?:real )?problems|validat(?:e|ing|ion) (?:my|an|the|this) idea)\b/i,
  ],
  [
    0.35,
    /\b(?:in case anyone (?:needs|wants) it|weekend project|introducing|i present|open-?sourced? (?:my|our))\b/i,
  ],
];

export interface AskVerdict {
  /** 0-1. */
  score: number;
  kind: string;
  wants: string[];
}

const GENERIC = new Set(
  (
    'app apps site sites website websites tool tools service services software platform platforms program programs extension ' +
    'extensions plugin plugins addon addons bot bots api apis saas solution solutions alternative alternatives product products ' +
    'web online free paid open source anyone anybody someone somebody looking search searching recommend recommendation ' +
    'recommendations suggestion suggestions exist exists existing wish thanks reddit subreddit help question similar ' +
    'basically simple easy able allow allows lets let'
  ).split(/\s+/),
);

const LEAD =
  /^(?:(?:that|which|where|to|for|so|lets?|let me|allows?(?: me| you| us)?(?: to)?|allowing|with|can|could|will|would|also|and|or|it|me|you|us|i|we|be able to|is able to|helps?(?: me| you)?(?: to)?|the|a|an|my|your|just|actually|automatically|both)\s+)+/i;
const BODY_WISH =
  /\b(?:i (?:want|need|would like|'d like) (?:it|something|one|an? \w+) to|it (?:should|must|needs to|has to)(?: be able to)?|should be able to|must (?:be able to|have|support)|needs to (?:be able to|support)|ideally(?: it)?(?: would)?|bonus (?:if|points if) it)\b/i;
const CONNECTOR =
  /\b(?:that|which|where|to|for|so i can|lets? (?:me|you|us|users)|allows? (?:me|you|us)|with)\b/i;

function splitWants(clause: string): string[] {
  return clause
    .split(/\s*(?:,|;|:|\band\b|\bor\b|&|\+|\/|\bplus\b|\bas well as\b|\bthen\b)\s*/i)
    .map((part) =>
      part
        .replace(LEAD, '')
        .replace(/[\s"'`*_).?!-]+$/g, '')
        .replace(/^[\s"'`*_(-]+/g, '')
        .trim(),
    )
    .filter(
      (part) =>
        part.length >= 3 &&
        part.length <= 80 &&
        termsOf(part).some((term) => contentful(term) && !GENERIC.has(term)),
    );
}

const sentenceAround = (text: string, index: number): { start: number; end: number } => {
  const before = text.slice(0, index);
  const start =
    Math.max(
      before.lastIndexOf('. '),
      before.lastIndexOf('? '),
      before.lastIndexOf('! '),
      before.lastIndexOf('\n'),
    ) + 1;
  const rest = text.slice(index);
  const ends = [rest.search(/[.?!](?:\s|$)/), rest.indexOf('\n')].filter((value) => value >= 0);
  return { start, end: ends.length ? index + Math.min(...ends) : text.length };
};

/** What they want the thing to do, in their own words. */
export function extractWants(source: string, matchEnd: number, body = ''): string[] {
  const { end } = sentenceAround(source, Math.max(0, matchEnd - 1));
  let clause = source.slice(matchEnd, end);
  const connector = clause.search(CONNECTOR);
  if (connector >= 0 && connector < 40) clause = clause.slice(connector);
  const wants = splitWants(clause);
  for (const line of body.split('\n')) {
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.{3,120})$/.exec(line);
    if (bullet?.[1]) wants.push(...splitWants(bullet[1]).slice(0, 2));
  }
  for (const sentence of body.split(/(?<=[.?!])\s+|\n/).slice(0, 40)) {
    const wish = BODY_WISH.exec(sentence);
    if (wish) wants.push(...splitWants(sentence.slice(wish.index + wish[0].length)).slice(0, 4));
  }
  const seen = new Set<string>();
  return wants
    .filter((want) => {
      const key = want.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

const ASKING =
  /\b(?:is there|are there|does (?:anyone|anybody) know(?: of)?|anyone know(?: of)?|looking for|searching for|can (?:anyone|someone|you) (?:recommend|suggest)|any(?:one)? (?:recommend(?:ations?)?|suggestions?)|recommend(?:ations?)?|suggestions?|you can recommend(?: to me)?|i need|i want|i wish there (?:was|were)|someone (?:should|please) (?:make|build)|does (?:this|such a thing|something like this) exist|(?:some|any)(?:one|body) (?:should |pls |please )?(?:make|build|create)|help|please|pls|thanks)\b/gi;

/** "Is there a free habit tracker that syncs?" becomes "free habit tracker that syncs". */
export function titleWant(title: string): string | undefined {
  const left = title
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\bi will not promote\b/gi, ' ')
    .replace(ASKING, ' ')
    .replace(/[?!.:]+/g, ' ')
    .replace(/^\s*(?:a|an|any|some|the|me|for|to|of)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:a|an|any|some|the|for|good|decent)\s+)+/i, '')
    .trim();
  if (left.length < 4 || left.length > 80) return undefined;
  return termsOf(left).some((term) => contentful(term) && !GENERIC.has(term)) ? left : undefined;
}

/** Is this post somebody asking for a tool, how sure are we, and what do they want? */
export function classifyAsk(title: string, body = ''): AskVerdict {
  const cleanBody = body.replace(/\r/g, '').slice(0, 4000);
  let best:
    { kind: string; weight: number; inTitle: boolean; end: number; source: string } | undefined;
  for (const [kind, weight, pattern] of PATTERNS) {
    for (const [source, inTitle] of [
      [title, true],
      [cleanBody, false],
    ] as const) {
      const match = pattern.exec(source);
      if (!match) continue;
      const total = weight + (inTitle ? 0.15 : 0);
      if (!best || total > best.weight + (best.inTitle ? 0.15 : 0))
        best = { kind, weight, inTitle, end: match.index + match[0].length, source };
    }
  }
  if (!best) return { score: 0, kind: '', wants: [] };
  let score = best.weight + (best.inTitle ? 0.15 : 0) + (/\?\s*$/.test(title.trim()) ? 0.1 : 0);
  let penalty = 0;
  const whole = `${title}\n${cleanBody}`;
  for (const [weight, pattern] of PITCHES) if (pattern.test(whole)) penalty += weight;
  score = Math.max(0, Math.min(1, score - Math.min(0.6, penalty)));

  let wants = extractWants(best.source, best.end, cleanBody);
  if (!wants.length && best.inTitle && cleanBody) {
    const first =
      cleanBody.split(/(?<=[.?!])\s+|\n/).find((sentence) => CONNECTOR.test(sentence)) ?? '';
    const at = first.search(CONNECTOR);
    if (at >= 0) wants = splitWants(first.slice(at)).slice(0, 6);
  }
  const fromTitle = titleWant(title);
  if (fromTitle && !wants.some((want) => fromTitle.toLowerCase().includes(want.toLowerCase())))
    wants = [fromTitle, ...wants].slice(0, 8);
  if (!wants.length) wants = [title.replace(/\s+/g, ' ').trim().slice(0, 80)];
  return { score: Number(score.toFixed(3)), kind: best.kind, wants };
}

// ------------------------------------------------------------------ grouping

const stem = (word: string): string =>
  word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;

/** What an ask is about, as single words, with the words of asking taken out. */
export function askTerms(ask: { title: string; wants: string[]; label?: string | null }): string[] {
  const words = termsOf(`${ask.label ?? ''} ${ask.wants.join(' ')} ${ask.title}`)
    .filter((term) => !term.includes(' ') && contentful(term) && !GENERIC.has(term))
    .map(stem);
  return [...new Set(words)];
}

export const labelTerms = (label: string | null | undefined): Set<string> =>
  new Set(
    termsOf(label ?? '')
      .filter((term) => !term.includes(' ') && contentful(term) && !GENERIC.has(term))
      .map(stem),
  );

/** Shared terms over the smaller set, so a short ask is not punished by a big idea's long tail. */
export function similarity(
  terms: string[],
  ideaTerms: string[],
): { shared: number; score: number } {
  const set = new Set(ideaTerms);
  const shared = terms.filter((term) => set.has(term)).length;
  const smaller = Math.min(terms.length, ideaTerms.length);
  return { shared, score: smaller ? shared / smaller : 0 };
}

export interface IdeaRef {
  id: string;
  label: string;
  named: boolean;
  terms: string[];
}

/**
 * The idea this ask belongs to, or undefined for a new one. When the judge has
 * named both, the names must share a word too: "playlist video downloader" and
 * "digital signage software" share wants and are still not one thing.
 */
export function bestIdea(
  ideas: IdeaRef[],
  ask: { title: string; wants: string[]; label?: string | null },
): IdeaRef | undefined {
  const terms = askTerms(ask);
  const named = labelTerms(ask.label);
  let best: { idea: IdeaRef; score: number } | undefined;
  for (const idea of ideas) {
    if (named.size && idea.named) {
      const theirs = labelTerms(idea.label);
      if (![...named].some((term) => theirs.has(term))) continue;
    }
    const match = similarity(terms, idea.terms);
    if (match.shared >= 2 && match.score >= 0.34 && (!best || match.score > best.score))
      best = { idea, score: match.score };
  }
  return best?.idea;
}

const IDEA_TERMS = 15;

/** The terms an idea's asks share, most shared first. */
export function ideaTermsOf(
  asks: Array<{ title: string; wants: string[]; label?: string | null }>,
): string[] {
  const counts = new Map<string, number>();
  for (const ask of asks)
    for (const term of askTerms(ask)) counts.set(term, (counts.get(term) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, IDEA_TERMS)
    .map(([term]) => term);
}

/** One number to sort ideas by: distinct people count most, then attention. */
export function demandScore(
  asks: Array<{ author: string; score?: number | null; comments?: number | null }>,
): { askers: number; demand: number } {
  const askers =
    new Set(asks.map((ask) => ask.author.toLowerCase()).filter((a) => a && a !== '[deleted]'))
      .size || Math.min(asks.length, 1);
  const attention = asks.reduce(
    (sum, ask) =>
      sum +
      Math.log2(1 + Math.max(0, ask.score ?? 0)) +
      Math.log2(1 + Math.max(0, ask.comments ?? 0)),
    0,
  );
  return { askers, demand: Number((askers * 10 + attention).toFixed(1)) };
}

// ------------------------------------------------------------------- worth

/** Launches whose words match an idea: the competition it would walk into. */
export function rivalsFor(
  idea: { label: string; terms: string[] },
  launches: Array<{ title: string; url: string }>,
): Array<{ title: string; url: string }> {
  const named = labelTerms(idea.label);
  return launches.filter((launch) => {
    const terms = askTerms({ title: launch.title, wants: [] });
    const match = similarity(terms, idea.terms);
    return match.shared >= 2 && match.score >= 0.5 && terms.some((t) => named.has(t));
  });
}

export type WorthVerdict = 'build' | 'validate' | 'watch' | 'crowded';

/**
 * Worth building AND selling, not only wanted. Demand (different people asking,
 * and the attention they got) is the base. On top:
 *
 *   paid     each source showing money (a case study's revenue, an asker saying
 *            they would pay) adds 15, up to three: willingness to pay is the
 *            difference between a feature request and a business.
 *   reach    each further place it comes up (another subreddit, Ask HN, a
 *            newsletter) adds 8, up to four: one forum is one community's quirk.
 *   rivals   one recent launch means a market exists (+5); a few is a fight
 *            (-5); four or more is crowded (-20).
 *
 * The verdict: 'build' needs both demand and money; 'validate' has one of them;
 * 'crowded' is any idea with four or more matching launches.
 */
export function worthScore(input: {
  demand: number;
  askers: number;
  sources: string[];
  paidSources: string[];
  rivals: number;
}): { worth: number; paid: number; reach: number; verdict: WorthVerdict } {
  const paid = Math.min(new Set(input.paidSources).size, 3);
  const reach = Math.min(Math.max(new Set(input.sources).size - 1, 0), 4);
  const rivalry = input.rivals >= 4 ? -20 : input.rivals >= 2 ? -5 : input.rivals === 1 ? 5 : 0;
  const worth = Number((input.demand + paid * 15 + reach * 8 + rivalry).toFixed(1));
  const verdict: WorthVerdict =
    input.rivals >= 4
      ? 'crowded'
      : input.askers >= 2 && paid >= 1
        ? 'build'
        : input.askers >= 2 || paid >= 1
          ? 'validate'
          : 'watch';
  return { worth, paid, reach, verdict };
}

/** Words that say a product exists without saying what it does. */
const VAGUE = new Set(
  (
    'mobile desktop game games successful profitable business businesses startup startups company companies idea ideas ' +
    'money revenue income mrr arr month monthly year million side project projects new best small big viral digital ai ' +
    'agent agents assistant own first one simple niche directory marketplace community content newsletter course'
  ).split(/\s+/),
);

/**
 * Does this name a product someone could build, rather than "a successful
 * mobile app" or "$20K/month app"? It needs one word that is neither generic
 * nor vague: "timer", "invoice", "transcription", "vet".
 */
export function specificLabel(label: string | null | undefined): boolean {
  if (!label || /\$|\d/.test(label)) return false;
  return termsOf(label).some(
    (term) =>
      !term.includes(' ') && contentful(term) && !GENERIC.has(term) && !VAGUE.has(stem(term)),
  );
}
