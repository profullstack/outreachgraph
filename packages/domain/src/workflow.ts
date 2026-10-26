/**
 * Custom workflows (Engineering Contract Outreach PRD §14).
 *
 * A workflow is a standing instruction — "find companies hiring engineers,
 * email their CTOs, up to 200 a day, every weekday" — written in English and
 * read into `WorkflowSettings` — the handful of choices a person makes. The
 * settings compile into the typed node graph that actually runs
 * (`workflow-graph.ts`); the English is what people read and edit.
 *
 * Nothing here is a second pipeline. Every step a workflow takes is a call
 * into machinery that already exists — campaign intake, AutoGTM targeting,
 * discovery and job-post searches, the composer, autopilot — and every message
 * still passes the deterministic policy engine at send time. A workflow only
 * decides *what to ask for and when*; it never decides what is permitted.
 *
 * Pure: the settings, their normaliser and the deterministic English reader.
 */

export const WORKFLOW_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_RUN_TRIGGERS = [
  'schedule',
  'manual',
  'event',
  'retry',
  'resume',
  'dry_run',
] as const;
export type WorkflowRunTrigger = (typeof WORKFLOW_RUN_TRIGGERS)[number];

export const WORKFLOW_RUN_STATUSES = [
  'running',
  'succeeded',
  'partial',
  'failed',
  'retry_scheduled',
  'dead_letter',
  'cancelled',
  'dry_run',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WORKFLOW_SOURCE_KINDS = ['discover', 'job_posts'] as const;
export type WorkflowSourceKind = (typeof WORKFLOW_SOURCE_KINDS)[number];

export const WORKFLOW_SCHEDULE_KINDS = ['daily', 'weekdays', 'weekly', 'manual', 'event'] as const;
export type WorkflowScheduleKind = (typeof WORKFLOW_SCHEDULE_KINDS)[number];

export const WORKFLOW_APPROVALS = ['review', 'autopilot'] as const;
export type WorkflowApproval = (typeof WORKFLOW_APPROVALS)[number];

/** The same ceiling `campaignLimitsSchema.maxActionsPerDay` enforces. */
export const MAX_WORKFLOW_DAILY_LIMIT = 1_000;
export const DEFAULT_WORKFLOW_DAILY_LIMIT = 50;
export const MAX_WORKFLOW_SOURCES = 6;
/** A job-board search per run; `MAX_SEARCH_RESULTS` is the API's own ceiling. */
export const MAX_WORKFLOW_JOB_RESULTS = 50;
const MAX_LIST = 25;
const MAX_TEXT = 300;

export interface WorkflowSource {
  readonly kind: WorkflowSourceKind;
  /** A market description for `discover`, a search keyword for `job_posts`. */
  readonly query: string;
  /** Postings per run, `job_posts` only. */
  readonly limit?: number;
}

export interface WorkflowTargeting {
  readonly titles: readonly string[];
  readonly seniorities: readonly string[];
  readonly industries: readonly string[];
  readonly countries: readonly string[];
  readonly keywords: readonly string[];
  readonly technologies: readonly string[];
  readonly exclusions: readonly string[];
  readonly employeeCountMin: number | null;
  readonly employeeCountMax: number | null;
}

export interface WorkflowOutreach {
  readonly channel: 'email';
  /** Messages a day at most. Autopilot and the policy engine enforce it. */
  readonly dailyLimit: number;
  /** `review` holds every draft for a human; `autopilot` is opt-in. */
  readonly approval: WorkflowApproval;
  /** One message per address per week unless widened; shared inboxes count once. */
  readonly maxPerAddressPerWeek: number;
}

export const WORKFLOW_EVENTS = ['reply_received'] as const;
export type WorkflowEvent = (typeof WORKFLOW_EVENTS)[number];

/** The working-hours zone the PRD names; DST is handled by the zone, not by us. */
export const DEFAULT_WORKFLOW_TIMEZONE = 'America/Los_Angeles';

export interface WorkflowSchedule {
  readonly kind: WorkflowScheduleKind;
  /** Local wall-clock hour in `timezone`, 0-23. */
  readonly hour: number;
  readonly minute: number;
  /** IANA zone, e.g. America/Los_Angeles. */
  readonly timezone: string;
  /** 0 = Sunday … 6 = Saturday, `weekly` only. */
  readonly weekday?: number;
  /** `event` only: what starts a run. */
  readonly event?: WorkflowEvent;
}

export interface WorkflowSettings {
  readonly version: 1;
  /** One sentence: what this workflow is for. */
  readonly goal: string;
  readonly sources: readonly WorkflowSource[];
  readonly targeting: WorkflowTargeting;
  readonly outreach: WorkflowOutreach;
  readonly schedule: WorkflowSchedule;
}

export const EMPTY_TARGETING: WorkflowTargeting = {
  titles: [],
  seniorities: [],
  industries: [],
  countries: [],
  keywords: [],
  technologies: [],
  exclusions: [],
  employeeCountMin: null,
  employeeCountMax: null,
};

const DEFAULT_SCHEDULE: WorkflowSchedule = {
  kind: 'weekdays',
  hour: 8,
  minute: 0,
  timezone: DEFAULT_WORKFLOW_TIMEZONE,
};

const DEFAULT_OUTREACH: WorkflowOutreach = {
  channel: 'email',
  dailyLimit: DEFAULT_WORKFLOW_DAILY_LIMIT,
  approval: 'review',
  maxPerAddressPerWeek: 1,
};

// ------------------------------------------------------------- normalising

export type NormaliseResult =
  | { readonly ok: true; readonly spec: WorkflowSettings; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Turns anything spec-shaped — a model's JSON, an API body, a stored row —
 * into a valid spec, or says why it cannot.
 *
 * Lenient about shape (clamps numbers, trims and de-duplicates lists, drops
 * unknown keys) and strict about meaning: a workflow with nowhere to find
 * people is refused, because it would run every day and do nothing.
 */
export function normaliseWorkflowSettings(raw: unknown): NormaliseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'a workflow spec must be an object' };
  }
  const input = raw as Record<string, unknown>;
  const warnings: string[] = [];

  const sources: WorkflowSource[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(input.sources) ? input.sources : []) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    const kind = oneOf(source.kind, WORKFLOW_SOURCE_KINDS);
    const query = cleanText(source.query);
    if (!kind || !query) continue;
    // A query with a dot in it reads as a website to campaign intake.
    const safeQuery = kind === 'discover' ? query.replace(/\.(?=\S)/g, ' ') : query;
    const key = `${kind}:${safeQuery.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(
      kind === 'job_posts'
        ? { kind, query: safeQuery, limit: clamp(source.limit, 1, MAX_WORKFLOW_JOB_RESULTS, 20) }
        : { kind, query: safeQuery },
    );
  }
  if (sources.length > MAX_WORKFLOW_SOURCES) {
    warnings.push(`only the first ${MAX_WORKFLOW_SOURCES} sources are kept`);
    sources.length = MAX_WORKFLOW_SOURCES;
  }
  if (sources.length === 0) {
    return {
      ok: false,
      error: 'say where to find people: a market to search ("SaaS startups") or a job keyword',
    };
  }

  const t = (input.targeting ?? {}) as Record<string, unknown>;
  let min = nullableCount(t.employeeCountMin);
  let max = nullableCount(t.employeeCountMax);
  if (min !== null && max !== null && min > max) {
    [min, max] = [max, min];
    warnings.push('company size range was reversed, so it was swapped');
  }
  const targeting: WorkflowTargeting = {
    titles: cleanList(t.titles),
    seniorities: cleanList(t.seniorities),
    industries: cleanList(t.industries),
    countries: cleanList(t.countries),
    keywords: cleanList(t.keywords),
    technologies: cleanList(t.technologies),
    exclusions: cleanList(t.exclusions),
    employeeCountMin: min,
    employeeCountMax: max,
  };

  const o = (input.outreach ?? {}) as Record<string, unknown>;
  const requested = Number(o.dailyLimit);
  if (Number.isFinite(requested) && requested > MAX_WORKFLOW_DAILY_LIMIT) {
    warnings.push(`the daily limit is capped at ${MAX_WORKFLOW_DAILY_LIMIT}`);
  }
  const outreach: WorkflowOutreach = {
    channel: 'email',
    dailyLimit: clamp(o.dailyLimit, 1, MAX_WORKFLOW_DAILY_LIMIT, DEFAULT_OUTREACH.dailyLimit),
    approval: oneOf(o.approval, WORKFLOW_APPROVALS) ?? 'review',
    maxPerAddressPerWeek: clamp(o.maxPerAddressPerWeek, 1, 7, 1),
  };

  const schedule = normaliseSchedule(input.schedule);

  const goal =
    cleanText(input.goal) ??
    `Reach ${targeting.titles[0] ?? 'decision makers'} found by ${sources[0]!.query}`;

  return { ok: true, spec: { version: 1, goal, sources, targeting, outreach, schedule }, warnings };
}

// ------------------------------------------------------------ the parser

/**
 * What the deterministic reader understood, and what it is unsure about.
 *
 * The API prefers a language model to read a prompt and falls back to this
 * when there is none (tests, a provider outage). It is also what keeps an edit
 * like "make it 100 a day" working when every model is refusing work.
 */
export interface InterpretResult {
  readonly spec: WorkflowSettings;
  readonly notes: readonly string[];
}

const TITLE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bctos?\b|chief technology officers?/i, 'CTO'],
  [/\bceos?\b|chief executive/i, 'CEO'],
  [/\bcpos?\b|chief product officers?/i, 'CPO'],
  [/\bvps? (?:of )?engineering\b|vice president,? engineering/i, 'VP of Engineering'],
  [/\bvps? (?:of )?product\b/i, 'VP of Product'],
  [/\bheads? of engineering\b/i, 'Head of Engineering'],
  [/\bheads? of product\b/i, 'Head of Product'],
  [/\bdirectors? of engineering\b|engineering directors?/i, 'Director of Engineering'],
  [/\b(?:engineering|hiring) managers?\b/i, 'Engineering Manager'],
  [/\btechnical (?:co-?)?founders?\b/i, 'Technical Co-founder'],
  [/\b(?:co-?)?founders?\b/i, 'Founder'],
  [
    /\b(?:internal|technical|in-house) (?:technical )?recruiters?\b|\btalent acquisition\b|\bhead of talent\b/i,
    'Technical Recruiter',
  ],
  [/\bcmos?\b|chief marketing officers?/i, 'CMO'],
  [/\bheads? of (?:growth|marketing)\b/i, 'Head of Marketing'],
];

const INDUSTRY_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bsaas\b/i, 'SaaS'],
  [/\bfin-?tech\b/i, 'Fintech'],
  [/\bhealth-?tech\b|\bdigital health\b/i, 'Healthtech'],
  [/\bed-?tech\b/i, 'Edtech'],
  [/\bdev(?:eloper)? ?tools?\b/i, 'Developer tools'],
  [/\b(?:ai|artificial intelligence|machine learning|ml)\b/i, 'AI'],
  [/\be-?commerce\b/i, 'E-commerce'],
  [/\bmarketplaces?\b/i, 'Marketplace'],
  [/\blogistics\b/i, 'Logistics'],
  [/\bbio-?tech\b/i, 'Biotech'],
  [/\b(?:crypto|web3|blockchain)\b/i, 'Crypto'],
  [/\bcyber ?security\b|\bsecurity\b/i, 'Security'],
  [/\binsur-?tech\b|\binsurance\b/i, 'Insurance'],
  [/\bgaming\b/i, 'Gaming'],
  [/\bsoftware\b/i, 'Software'],
];

const COUNTRY_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\b(?:united states|usa|u\.s\.a?\.?|us-based|in the us|america)\b/i, 'United States'],
  [/\bcanad(?:a|ian)\b/i, 'Canada'],
  [/\b(?:united kingdom|uk|u\.k\.|britain|british)\b/i, 'United Kingdom'],
  [/\bgerman(?:y)?\b/i, 'Germany'],
  [/\bfrance|french\b/i, 'France'],
  [/\bnetherlands|dutch\b/i, 'Netherlands'],
  [/\bireland|irish\b/i, 'Ireland'],
  [/\baustralia(?:n)?\b/i, 'Australia'],
  [/\bindia\b/i, 'India'],
  [/\bsingapore\b/i, 'Singapore'],
  [/\bisrael\b/i, 'Israel'],
  [/\bspain|spanish\b/i, 'Spain'],
  [/\bsweden|swedish\b/i, 'Sweden'],
];

const TECH_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\breact\b/i, 'React'],
  [/\bnode(?:\.?js)?\b/i, 'Node.js'],
  [/\btypescript\b/i, 'TypeScript'],
  [/\bpython\b/i, 'Python'],
  [/\bgolang\b|\bgo\b(?= developers?| engineers?)/i, 'Go'],
  [/\brust\b/i, 'Rust'],
  [/\bkubernetes\b|\bk8s\b/i, 'Kubernetes'],
  [/\baws\b/i, 'AWS'],
  [/\bnext\.?js\b/i, 'Next.js'],
  [/\bpostgres(?:ql)?\b/i, 'Postgres'],
  [/\brails\b|\bruby\b/i, 'Ruby on Rails'],
  [/\bdjango\b/i, 'Django'],
  [/\bjava\b/i, 'Java'],
  [/\bflutter\b|\breact native\b|\bmobile\b/i, 'Mobile'],
];

const ZONES: Record<string, string> = {
  utc: 'UTC',
  gmt: 'UTC',
  pt: 'America/Los_Angeles',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  pacific: 'America/Los_Angeles',
  et: 'America/New_York',
  est: 'America/New_York',
  edt: 'America/New_York',
  eastern: 'America/New_York',
  ct: 'America/Chicago',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  central: 'America/Chicago',
  mt: 'America/Denver',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  mountain: 'America/Denver',
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Reads an English description into a spec, deterministically.
 *
 * With `base`, the text is an edit: only what it mentions changes, lists it
 * names are merged in (or removed after "remove"/"drop"/"without"), and
 * everything else keeps its current value.
 */
export function interpretWorkflowPrompt(text: string, base?: WorkflowSettings): InterpretResult {
  const prompt = text.replace(/\s+/g, ' ').trim();
  const notes: string[] = [];
  const editing = base !== undefined;
  const start: WorkflowSettings = base ?? {
    version: 1,
    goal: firstSentence(prompt),
    sources: [],
    targeting: EMPTY_TARGETING,
    outreach: DEFAULT_OUTREACH,
    schedule: DEFAULT_SCHEDULE,
  };

  // Removals are read first and cut out of the text, so "remove Canada" does
  // not also add Canada back through the ordinary matchers below.
  const removals: string[] = [];
  const withoutRemovals = prompt.replace(
    /\b(?:remove|drop|without|stop targeting|no longer target)\s+([^.;]+)/gi,
    (_, phrase: string) => {
      removals.push(phrase);
      return ' ';
    },
  );

  // Exclusions are the companies to stay away from, said as "not agencies".
  // Cut out too, so "not recruiting agencies" is never read as a job search.
  const exclusions: string[] = [];
  const additive = withoutRemovals.replace(
    /\b(?:no|not|avoid|skip|exclude|excluding)\s+([a-z][a-z\s-]{2,40}?)(?=[,.;]|$| and )/gi,
    (whole: string, phrase: string) => {
      const trimmed = phrase.trim();
      if (/^(?:more than|fewer|less|later|earlier|approval|review)/i.test(trimmed)) return whole;
      exclusions.push(trimmed);
      return ' ';
    },
  );

  const pick = (patterns: readonly (readonly [RegExp, string])[], source: string) =>
    patterns.filter(([re]) => re.test(source)).map(([, label]) => label);

  // "Technical co-founder" also matches the plain founder pattern; keep the
  // more specific one only.
  const titles = dedupeFounder(pick(TITLE_PATTERNS, additive));
  const industries = pick(INDUSTRY_PATTERNS, additive);
  const countries = pick(COUNTRY_PATTERNS, additive);
  const technologies = pick(TECH_PATTERNS, additive);
  const removedText = removals.join(' ');
  const removeTitles = dedupeFounder(pick(TITLE_PATTERNS, removedText));
  const removeIndustries = pick(INDUSTRY_PATTERNS, removedText);
  const removeCountries = pick(COUNTRY_PATTERNS, removedText);
  const removeTech = pick(TECH_PATTERNS, removedText);

  const merge = (current: readonly string[], add: readonly string[], drop: readonly string[]) => {
    const dropped = new Set(drop.map((d) => d.toLowerCase()));
    const next = (editing ? [...current, ...add] : add).filter(
      (v) => !dropped.has(v.toLowerCase()),
    );
    return [...new Map(next.map((v) => [v.toLowerCase(), v])).values()];
  };

  // Company size.
  let employeeCountMin = start.targeting.employeeCountMin;
  let employeeCountMax = start.targeting.employeeCountMax;
  const range = additive.match(
    /(\d[\d,]*)\s*(?:-|–|to)\s*(\d[\d,]*)\s*(?:employees|people|staff|person)/i,
  );
  const under = additive.match(
    /(?:under|fewer than|less than|up to|below)\s*(\d[\d,]*)\s*(?:employees|people|staff)/i,
  );
  const over = additive.match(
    /(?:over|more than|at least|above)\s*(\d[\d,]*)\s*(?:employees|people|staff)/i,
  );
  if (range) {
    employeeCountMin = toInt(range[1]!);
    employeeCountMax = toInt(range[2]!);
  } else {
    if (under) employeeCountMax = toInt(under[1]!);
    if (over) employeeCountMin = toInt(over[1]!);
  }

  // Volume.
  let dailyLimit = start.outreach.dailyLimit;
  const perDay =
    additive.match(
      /(\d[\d,]*)\s*(?:qualified\s+|personal\s+|cold\s+)*(?:emails?|messages?|sends?|contacts?|leads?|people|prospects?|outreach(?:es)?)?\s*(?:\/|per|a|each|every)\s*(?:day|weekday)\b/i,
    ) ??
    additive.match(/(?:daily (?:limit|cap)|limit|cap)\s*(?:of|to|at|=)?\s*(\d[\d,]*)/i) ??
    additive.match(/(\d[\d,]*)\s*(?:a|per)\s*day/i);
  if (perDay) dailyLimit = toInt(perDay[1]!);
  if (dailyLimit > MAX_WORKFLOW_DAILY_LIMIT) {
    notes.push(`daily limit capped at ${MAX_WORKFLOW_DAILY_LIMIT}`);
  }

  // Approval. Autopilot only when asked for in so many words.
  let approval = start.outreach.approval;
  if (
    /\b(?:auto-?pilot|automatically send|send automatically|without (?:my )?(?:approval|review)|hands[- ]off|unattended)\b/i.test(
      additive,
    )
  ) {
    approval = 'autopilot';
  } else if (
    /\b(?:with (?:my )?(?:approval|review)|i(?:'ll| will)? approve|approve (?:each|every|them)|review (?:each|every|them|first)|manual approval|human approval)\b/i.test(
      additive,
    )
  ) {
    approval = 'review';
  }

  // Schedule. A time is local to the named zone, the workflow's zone otherwise.
  const prior = start.schedule;
  let hour = prior.hour;
  let minute = prior.minute;
  let timezone = prior.timezone;
  const at = additive.match(
    /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(utc|gmt|pt|pst|pdt|pacific|et|est|edt|eastern|ct|cst|cdt|central|mt|mst|mdt|mountain)?\b/i,
  );
  if (at) {
    let h = Number(at[1]);
    const meridiem = at[3]?.toLowerCase();
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    if (h >= 0 && h <= 23) {
      hour = h;
      minute = Math.min(59, Number(at[2] ?? 0));
    }
    const zone = at[4]?.toLowerCase();
    if (zone) timezone = ZONES[zone] ?? timezone;
  }
  const weekly = additive.match(
    /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
  );
  const clock = { hour, minute, timezone };
  let schedule: WorkflowSchedule;
  if (
    /\b(?:when(?:ever)? (?:a|someone|they|anyone) repl(?:y|ies)|on (?:each|every|a) reply)\b/i.test(
      additive,
    )
  ) {
    schedule = { kind: 'event', event: 'reply_received', ...clock };
  } else if (
    /\b(?:manual(?:ly)?|on demand|only when i (?:run|press)|no schedule)\b/i.test(additive)
  ) {
    schedule = { kind: 'manual', ...clock };
  } else if (weekly) {
    schedule = { kind: 'weekly', ...clock, weekday: WEEKDAYS.indexOf(weekly[1]!.toLowerCase()) };
  } else if (
    /\b(?:weekdays?|every weekday|monday (?:to|through|-) friday|business days?)\b/i.test(additive)
  ) {
    schedule = { kind: 'weekdays', ...clock };
  } else if (
    /\b(?:every day|daily|each day|7 days)\b/i.test(additive) &&
    !perDay?.[0]?.match(/daily/i)
  ) {
    schedule = { kind: 'daily', ...clock };
  } else {
    schedule = { ...prior, ...clock };
  }

  // Sources.
  const sources: WorkflowSource[] = editing ? [...start.sources] : [];
  const addSource = (source: WorkflowSource) => {
    const key = `${source.kind}:${source.query.toLowerCase()}`;
    if (!sources.some((s) => `${s.kind}:${s.query.toLowerCase()}` === key)) sources.push(source);
  };

  const MARKET =
    /\b(?:startups?|companies|businesses|agencies|firms|teams|brands|shops|stores|founders|saas|products|clinics|practices)\b/i;

  // "hiring a contract software engineer and a full stack engineer": each is a search.
  for (const hiring of additive.matchAll(
    /\b(?:hiring|recruiting for|job (?:boards?|posts?|postings?|listings?|openings?|ads?) for(?: (?:companies|employers)(?: that are)? hiring)?|open roles? for|looking to hire)\s+(?:for\s+)?([a-z][a-z0-9+#\s/-]{2,160}?)(?=[,.;]|$|\s+(?:in|at|with|who|that|to|on|every|up)\b)/gi,
  )) {
    // "startups hiring engineers" describes a market (discovery reads it); a
    // job search is a hiring phrase on its own, or one about job boards.
    const clause = additive.slice(0, hiring.index).split(/[.;]/).pop() ?? '';
    if (MARKET.test(clause) && !/\bjob(?:s| boards?| posts?| postings?)\b/i.test(clause)) continue;
    for (const part of hiring[1]!.split(/\s+and\s+/i)) {
      if (MARKET.test(part)) continue;
      const query = part.replace(/^(?:an?|some|more)\s+/i, '').trim();
      if (query.length >= 3)
        addSource({ kind: 'job_posts', query: query.slice(0, 120), limit: 20 });
    }
  }

  // "find Bay Area software companies hiring engineers and remote-first US
  // startups": each market noun phrase is a discovery search.
  for (const found of additive.matchAll(
    /\b(?:find|target|reach|search for|look for|prospect)\s+(?:out\s+)?([^.;]{3,240})/gi,
  )) {
    for (const part of found[1]!.split(
      /\s+and\s+(?=(?:[a-z0-9-]+\s+){0,6}?(?:startups?|companies|businesses|agencies|firms|teams|brands|shops|stores|founders|saas|products|clinics|practices)\b)/i,
    )) {
      if (!MARKET.test(part)) continue;
      const query = part
        .replace(/\s+(?:with|in)\s+\d.*$/i, '')
        .replace(/\s+(?:then|and then)\b.*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      addSource({ kind: 'discover', query: query.slice(0, 120) });
    }
  }

  if (sources.length === 0 && !editing) {
    // Nothing recognisably a source: search for the goal itself. Discovery
    // takes free text, so this is a weaker query rather than a broken one.
    addSource({ kind: 'discover', query: firstSentence(prompt).slice(0, 120) });
    notes.push('no market or job keyword was named, so the first sentence is the search');
  }

  // "Drop remote-first US startups": a named source goes.
  for (const phrase of removals) {
    const said = phrase
      .toLowerCase()
      .replace(/^(?:the|searching(?: for)?)\s+/, '')
      .trim();
    for (let i = sources.length - 1; i >= 0; i -= 1) {
      const query = sources[i]!.query.toLowerCase();
      if (said.length >= 4 && (said.includes(query) || query.includes(said))) sources.splice(i, 1);
    }
  }

  // "Remove job posts" / "stop searching job boards".
  if (/\b(?:job (?:posts?|boards?|postings?))\b/i.test(removedText)) {
    for (let i = sources.length - 1; i >= 0; i -= 1) {
      if (sources[i]!.kind === 'job_posts') sources.splice(i, 1);
    }
  }

  const draft = {
    version: 1 as const,
    goal: editing ? start.goal : firstSentence(prompt),
    sources,
    targeting: {
      titles: merge(start.targeting.titles, titles, removeTitles),
      seniorities: start.targeting.seniorities,
      industries: merge(start.targeting.industries, industries, removeIndustries),
      countries: merge(start.targeting.countries, countries, removeCountries),
      keywords: start.targeting.keywords,
      technologies: merge(start.targeting.technologies, technologies, removeTech),
      exclusions: merge(start.targeting.exclusions, exclusions, []),
      employeeCountMin,
      employeeCountMax,
    },
    outreach: { ...start.outreach, dailyLimit, approval },
    schedule,
  };

  const normalised = normaliseWorkflowSettings(draft);
  if (!normalised.ok) {
    // Only reachable on an edit that removed every source; keep the old ones.
    return { spec: start, notes: [...notes, normalised.error] };
  }
  return { spec: normalised.spec, notes: [...notes, ...normalised.warnings] };
}

// ------------------------------------------------------------- schedule

export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function normaliseSchedule(raw: unknown): WorkflowSchedule {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = oneOf(s.kind, WORKFLOW_SCHEDULE_KINDS) ?? DEFAULT_SCHEDULE.kind;
  const zone = typeof s.timezone === 'string' && isValidTimezone(s.timezone) ? s.timezone : null;
  const base = {
    kind,
    hour: clamp(s.hour, 0, 23, DEFAULT_SCHEDULE.hour),
    minute: clamp(s.minute, 0, 59, 0),
    timezone: zone ?? DEFAULT_WORKFLOW_TIMEZONE,
  };
  if (kind === 'weekly') return { ...base, weekday: clamp(s.weekday, 0, 6, 1) };
  if (kind === 'event')
    return { ...base, event: oneOf(s.event, WORKFLOW_EVENTS) ?? 'reply_received' };
  return base;
}

// --------------------------------------------------------------- helpers

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  return text.length > 0 ? text : undefined;
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, string>();
  for (const item of value) {
    const text = cleanText(item);
    if (text && !out.has(text.toLowerCase())) out.set(text.toLowerCase(), text.slice(0, 80));
  }
  return [...out.values()].slice(0, MAX_LIST);
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'string' ? Number(value.replace(/,/g, '')) : Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function nullableCount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function toInt(text: string): number {
  return Number(text.replace(/,/g, ''));
}

function firstSentence(text: string): string {
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return sentence.replace(/[.!?]+$/, '').slice(0, MAX_TEXT);
}

function dedupeFounder(titles: string[]): string[] {
  return titles.includes('Technical Co-founder') ? titles.filter((t) => t !== 'Founder') : titles;
}
