/**
 * The workflow definition that runs: a typed, versioned node graph
 * (Engineering Contract Outreach PRD §14 "Runtime / safety").
 *
 * English is read into `WorkflowSettings` (`workflow.ts`); settings compile
 * into this graph; a person may then edit any node's inputs directly. What is
 * stored, versioned and executed is the graph, and only after
 * `validateWorkflowDefinition` accepts it:
 *
 *   - every node is one of a fixed set of step types — an unknown action is
 *     refused, never improvised;
 *   - the graph is acyclic, and every reference resolves;
 *   - a `send` is reachable only through contact verification, de-duplication,
 *     a draft and an approval node, so no edit can produce a graph that sends
 *     an unchecked message;
 *   - each node's inputs are clamped to the same limits the API enforces.
 *
 * None of this decides whether a message may go out. Each send still passes
 * the deterministic policy engine at execution time; the graph only decides
 * what the product is asked to do. No node can hold code: configs are plain
 * data checked field by field.
 */

import {
  DEFAULT_WORKFLOW_TIMEZONE,
  EMPTY_TARGETING,
  MAX_WORKFLOW_DAILY_LIMIT,
  MAX_WORKFLOW_JOB_RESULTS,
  normaliseSchedule,
  normaliseWorkflowSettings,
  WORKFLOW_APPROVALS,
  type WorkflowSchedule,
  type WorkflowSettings,
  type WorkflowSource,
  type WorkflowTargeting,
} from './workflow';

export const WORKFLOW_NODE_TYPES = [
  'discover_opportunities',
  'enrich',
  'verify_contact',
  'score_filter',
  'deduplicate',
  'draft',
  'approval',
  'send',
  'wait',
  'classify_reply',
  'branch',
  'log_crm',
  'notify',
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

/** The labels reply triage assigns (PRD §4.E); a branch routes on these. */
export const WORKFLOW_REPLY_LABELS = [
  'interested',
  'question',
  'referral',
  'no_current_opening',
  'not_interested',
  'out_of_office',
  'unsubscribe',
  'bounce',
  'unknown',
] as const;
export type WorkflowReplyLabel = (typeof WORKFLOW_REPLY_LABELS)[number];

export const WORKFLOW_NOTIFY_ON = ['positive_reply', 'run_failed', 'daily_summary'] as const;

/** Steps that change state when run, and so carry an idempotency key. */
export const SIDE_EFFECT_NODE_TYPES: readonly WorkflowNodeType[] = [
  'discover_opportunities',
  'verify_contact',
  'score_filter',
  'deduplicate',
  'approval',
  'send',
];

/** What must stand between finding someone and sending them anything. */
const SEND_PREREQUISITES: readonly WorkflowNodeType[] = [
  'verify_contact',
  'deduplicate',
  'draft',
  'approval',
];

export const MAX_WORKFLOW_NODES = 40;
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface WorkflowNode {
  readonly id: string;
  readonly type: WorkflowNodeType;
  readonly label: string;
  /** Nodes that must finish first. Empty for a starting node. */
  readonly after: readonly string[];
  /** Reply labels this node handles; only valid after a `branch`. */
  readonly when?: readonly WorkflowReplyLabel[];
  readonly config: Readonly<Record<string, unknown>>;
}

export interface WorkflowDefinition {
  readonly version: 2;
  readonly goal: string;
  readonly nodes: readonly WorkflowNode[];
  readonly schedule: WorkflowSchedule;
}

export const NODE_TYPE_LABELS: Record<WorkflowNodeType, string> = {
  discover_opportunities: 'Discover opportunities',
  enrich: 'Enrich company and person',
  verify_contact: 'Verify contact',
  score_filter: 'Score and filter',
  deduplicate: 'De-duplicate',
  draft: 'Draft from evidence',
  approval: 'Approval',
  send: 'Send (policy-checked)',
  wait: 'Wait',
  classify_reply: 'Classify reply',
  branch: 'Branch on reply',
  log_crm: 'Log to CRM',
  notify: 'Notify',
};

// ------------------------------------------------------------- validation

export type ValidateResult =
  | {
      readonly ok: true;
      readonly definition: WorkflowDefinition;
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Accepts a definition only when it is safe to store and run.
 *
 * Errors are collected rather than thrown at the first, so an editor can show
 * every problem at once.
 */
export function validateWorkflowDefinition(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['a workflow definition must be an object'] };
  }
  const input = raw as Record<string, unknown>;
  const errors: string[] = [];
  const warnings: string[] = [];

  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  if (rawNodes.length === 0) errors.push('a workflow needs at least one step');
  if (rawNodes.length > MAX_WORKFLOW_NODES) {
    errors.push(`a workflow has at most ${MAX_WORKFLOW_NODES} steps`);
  }

  const nodes: WorkflowNode[] = [];
  const ids = new Set<string>();
  for (const [index, item] of rawNodes.slice(0, MAX_WORKFLOW_NODES).entries()) {
    const node = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    const where = id || `step ${index + 1}`;
    if (!NODE_ID.test(id)) {
      errors.push(`${where}: ids are lowercase letters, digits and dashes`);
      continue;
    }
    if (ids.has(id)) {
      errors.push(`${id}: the id is used twice`);
      continue;
    }
    ids.add(id);
    if (!(WORKFLOW_NODE_TYPES as readonly unknown[]).includes(node.type)) {
      errors.push(`${id}: unknown action “${String(node.type)}”`);
      continue;
    }
    const type = node.type as WorkflowNodeType;
    const configured = normaliseNodeConfig(type, node.config);
    for (const problem of configured.errors) errors.push(`${id}: ${problem}`);
    const when = Array.isArray(node.when)
      ? node.when.filter((label): label is WorkflowReplyLabel =>
          (WORKFLOW_REPLY_LABELS as readonly unknown[]).includes(label),
        )
      : undefined;
    if (Array.isArray(node.when) && when && when.length !== node.when.length) {
      errors.push(`${id}: “when” takes reply labels only (${WORKFLOW_REPLY_LABELS.join(', ')})`);
    }
    nodes.push({
      id,
      type,
      label:
        typeof node.label === 'string' && node.label.trim()
          ? node.label.trim().slice(0, 80)
          : NODE_TYPE_LABELS[type],
      after: Array.isArray(node.after)
        ? [...new Set(node.after.filter((a): a is string => typeof a === 'string'))]
        : [],
      ...(when && when.length > 0 ? { when } : {}),
      config: configured.config,
    });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    for (const parent of node.after) {
      if (parent === node.id) errors.push(`${node.id}: a step cannot follow itself`);
      else if (!byId.has(parent))
        errors.push(`${node.id}: follows “${parent}”, which does not exist`);
    }
    if (node.when && !node.after.some((p) => byId.get(p)?.type === 'branch')) {
      errors.push(`${node.id}: reply conditions need a branch step before it`);
    }
  }

  if (errors.length === 0) {
    const order = topologicalOrder(nodes);
    if (!order) errors.push('the steps form a cycle; a workflow must always move forward');
  }

  const count = (type: WorkflowNodeType) => nodes.filter((n) => n.type === type).length;
  if (count('discover_opportunities') === 0) {
    errors.push('add a “discover opportunities” step: a workflow needs somewhere to find people');
  }
  for (const single of ['send', 'approval', 'score_filter'] as const) {
    if (count(single) > 1) errors.push(`only one “${NODE_TYPE_LABELS[single]}” step is allowed`);
  }

  if (errors.length === 0) {
    const send = nodes.find((n) => n.type === 'send');
    if (send) {
      const before = new Set([...ancestors(nodes, send.id)].map((id) => byId.get(id)!.type));
      const missing = SEND_PREREQUISITES.filter((type) => !before.has(type));
      if (missing.length > 0) {
        errors.push(
          `every send must come after ${missing.map((t) => `“${NODE_TYPE_LABELS[t]}”`).join(', ')}`,
        );
      }
    } else {
      warnings.push('no send step: this workflow researches and drafts but never sends');
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const goal =
    typeof input.goal === 'string' && input.goal.trim()
      ? input.goal.replace(/\s+/g, ' ').trim().slice(0, 300)
      : 'Custom workflow';
  return {
    ok: true,
    definition: { version: 2, goal, nodes, schedule: normaliseSchedule(input.schedule) },
    warnings,
  };
}

/** Kahn's algorithm; `undefined` when there is a cycle. Stable in input order. */
export function topologicalOrder(nodes: readonly WorkflowNode[]): string[] | undefined {
  const indegree = new Map(nodes.map((n) => [n.id, n.after.length]));
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    for (const parent of node.after)
      children.set(parent, [...(children.get(parent) ?? []), node.id]);
  }
  const queue = nodes.filter((n) => n.after.length === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) queue.push(child);
    }
  }
  return order.length === nodes.length ? order : undefined;
}

function ancestors(nodes: readonly WorkflowNode[], id: string): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [...(byId.get(id)?.after ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(byId.get(next)?.after ?? []));
  }
  return seen;
}

/** Each step type's inputs, clamped. Unknown keys are dropped. */
export function normaliseNodeConfig(
  type: WorkflowNodeType,
  raw: unknown,
): { config: Record<string, unknown>; errors: string[] } {
  const c = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<
    string,
    unknown
  >;
  const errors: string[] = [];
  switch (type) {
    case 'discover_opportunities': {
      const source = c.source === 'job_posts' ? 'job_posts' : 'discover';
      const query = typeof c.query === 'string' ? c.query.replace(/\s+/g, ' ').trim() : '';
      if (!query) errors.push('say what to search for');
      // A dot reads as a website to campaign intake; a market is not a URL.
      const safe = (source === 'discover' ? query.replace(/\.(?=\S)/g, ' ') : query).slice(0, 200);
      return {
        config:
          source === 'job_posts'
            ? { source, query: safe, limit: clamp(c.limit, 1, MAX_WORKFLOW_JOB_RESULTS, 20) }
            : { source, query: safe },
        errors,
      };
    }
    case 'enrich':
      return { config: { findEmail: c.findEmail !== false }, errors };
    case 'verify_contact':
      return {
        config: {
          // Not switchable: the PRD requires a contactability proof.
          requireVerified: true,
          allowSharedInbox: c.allowSharedInbox === true,
        },
        errors,
      };
    case 'score_filter': {
      const t = normaliseTargeting(c);
      return { config: { ...t }, errors };
    }
    case 'deduplicate':
      return {
        config: { cooldownDays: clamp(c.cooldownDays, 1, 365, 90), includePriorSends: true },
        errors,
      };
    case 'draft':
      return {
        config: { maxWords: clamp(c.maxWords, 40, 300, 120), groundedOnly: true },
        errors,
      };
    case 'approval':
      return {
        config: {
          mode: (WORKFLOW_APPROVALS as readonly unknown[]).includes(c.mode) ? c.mode : 'review',
        },
        errors,
      };
    case 'send':
      return {
        config: {
          channel: 'email',
          dailyLimit: clamp(c.dailyLimit, 1, MAX_WORKFLOW_DAILY_LIMIT, 50),
          maxPerAddressPerWeek: clamp(c.maxPerAddressPerWeek, 1, 7, 1),
        },
        errors,
      };
    case 'wait':
      return { config: { days: clamp(c.days, 1, 30, 4) }, errors };
    case 'classify_reply':
      return { config: {}, errors };
    case 'branch':
      return { config: { on: 'reply_label' }, errors };
    case 'log_crm':
      return { config: {}, errors };
    case 'notify':
      return {
        config: {
          on: (WORKFLOW_NOTIFY_ON as readonly unknown[]).includes(c.on) ? c.on : 'positive_reply',
        },
        errors,
      };
  }
}

function normaliseTargeting(c: Record<string, unknown>): WorkflowTargeting {
  const result = normaliseWorkflowSettings({
    sources: [{ kind: 'discover', query: 'x' }],
    targeting: c,
  });
  return result.ok ? result.spec.targeting : EMPTY_TARGETING;
}

// --------------------------------------------- settings <-> definition

/**
 * The standard graph for a set of choices: find, enrich, verify, score,
 * de-duplicate, draft, approve, send, then wait for and route the replies.
 */
export function compileWorkflow(settings: WorkflowSettings): WorkflowDefinition {
  const discover: WorkflowNode[] = settings.sources.map((source, index) => ({
    id: `discover-${index + 1}`,
    type: 'discover_opportunities',
    label: source.kind === 'job_posts' ? 'Search job boards' : 'Discover companies',
    after: [],
    config: sourceConfig(source),
  }));
  const node = (
    id: string,
    type: WorkflowNodeType,
    after: readonly string[],
    config: Record<string, unknown> = {},
    when?: readonly WorkflowReplyLabel[],
  ): WorkflowNode => ({
    id,
    type,
    label: NODE_TYPE_LABELS[type],
    after,
    ...(when ? { when } : {}),
    config: normaliseNodeConfig(type, config).config,
  });

  return {
    version: 2,
    goal: settings.goal,
    schedule: settings.schedule,
    nodes: [
      ...discover,
      node(
        'enrich',
        'enrich',
        discover.map((d) => d.id),
        { findEmail: true },
      ),
      node('verify', 'verify_contact', ['enrich'], { allowSharedInbox: false }),
      node('score', 'score_filter', ['verify'], { ...settings.targeting }),
      node('dedupe', 'deduplicate', ['score'], { cooldownDays: 90 }),
      node('draft', 'draft', ['dedupe'], { maxWords: 120 }),
      node('approve', 'approval', ['draft'], { mode: settings.outreach.approval }),
      node('send', 'send', ['approve'], {
        dailyLimit: settings.outreach.dailyLimit,
        maxPerAddressPerWeek: settings.outreach.maxPerAddressPerWeek,
      }),
      node('wait', 'wait', ['send'], { days: 4 }),
      node('classify', 'classify_reply', ['wait']),
      node('route', 'branch', ['classify']),
      node('notify', 'notify', ['route'], { on: 'positive_reply' }, [
        'interested',
        'question',
        'referral',
      ]),
      node('crm', 'log_crm', ['route'], {}, ['interested']),
    ],
  };
}

/** The choices a definition makes, for the English editor and the plan. */
export function settingsOf(definition: WorkflowDefinition): WorkflowSettings {
  const of = (type: WorkflowNodeType) => definition.nodes.find((n) => n.type === type)?.config;
  const send = of('send');
  const result = normaliseWorkflowSettings({
    goal: definition.goal,
    sources: definition.nodes
      .filter((n) => n.type === 'discover_opportunities')
      .map((n) => ({ kind: n.config.source, query: n.config.query, limit: n.config.limit })),
    targeting: of('score_filter') ?? {},
    outreach: {
      dailyLimit: send?.dailyLimit ?? 0,
      approval: of('approval')?.mode ?? 'review',
      maxPerAddressPerWeek: send?.maxPerAddressPerWeek ?? 1,
    },
    schedule: definition.schedule,
  });
  if (!result.ok) throw new Error(result.error);
  // A definition with no send step sends nothing, whatever the default says.
  return send
    ? result.spec
    : { ...result.spec, outreach: { ...result.spec.outreach, dailyLimit: 0 } };
}

/**
 * Applies changed choices to an existing graph, keeping the person's own edits.
 *
 * Discovery steps are matched by query, so an unchanged source keeps its id
 * (and its run history); new ones join the first step after discovery.
 */
export function applySettings(
  definition: WorkflowDefinition,
  settings: WorkflowSettings,
): WorkflowDefinition {
  const existing = definition.nodes.filter((n) => n.type === 'discover_opportunities');
  const kept: WorkflowNode[] = [];
  let next = existing.length + 1;
  for (const source of settings.sources) {
    const match = existing.find(
      (n) => n.config.source === sourceConfig(source).source && n.config.query === source.query,
    );
    if (match) {
      kept.push({ ...match, config: sourceConfig(source) });
      continue;
    }
    while (definition.nodes.some((n) => n.id === `discover-${next}`)) next += 1;
    kept.push({
      id: `discover-${next}`,
      type: 'discover_opportunities',
      label: source.kind === 'job_posts' ? 'Search job boards' : 'Discover companies',
      after: [],
      config: sourceConfig(source),
    });
    next += 1;
  }
  const keptIds = new Set(kept.map((n) => n.id));
  const removed = new Set(existing.filter((n) => !keptIds.has(n.id)).map((n) => n.id));
  const added = kept.filter((n) => !existing.some((e) => e.id === n.id)).map((n) => n.id);

  let joinedNewSources = false;
  const rest = definition.nodes
    .filter((n) => n.type !== 'discover_opportunities')
    .map((n): WorkflowNode => {
      let after = n.after.filter((id) => !removed.has(id));
      if (!joinedNewSources && n.after.some((id) => existing.some((e) => e.id === id))) {
        after = [...after, ...added];
        joinedNewSources = true;
      }
      switch (n.type) {
        case 'score_filter':
          return { ...n, after, config: normaliseNodeConfig(n.type, settings.targeting).config };
        case 'approval':
          return { ...n, after, config: { mode: settings.outreach.approval } };
        case 'send':
          return {
            ...n,
            after,
            config: normaliseNodeConfig('send', {
              dailyLimit: settings.outreach.dailyLimit,
              maxPerAddressPerWeek: settings.outreach.maxPerAddressPerWeek,
            }).config,
          };
        default:
          return { ...n, after };
      }
    });

  return {
    version: 2,
    goal: settings.goal,
    schedule: settings.schedule,
    nodes: [...kept, ...rest],
  };
}

function sourceConfig(source: WorkflowSource): Record<string, unknown> {
  return normaliseNodeConfig('discover_opportunities', {
    source: source.kind,
    query: source.query,
    limit: source.limit,
  }).config;
}

// ------------------------------------------------------------------ plan

export interface WorkflowPlanContext {
  readonly campaignName?: string | undefined;
  /** `workspace_settings.autopilot_daily_cap`: the ceiling over every campaign. */
  readonly workspaceDailyCap?: number | undefined;
  /** False when no job-board searcher is configured (no ValueSERP key). */
  readonly jobSearchEnabled?: boolean | undefined;
  /** False when the workspace has no CRM connected. */
  readonly crmConnected?: boolean | undefined;
}

export interface WorkflowPlanStep {
  readonly id: string;
  readonly type: WorkflowNodeType | 'trigger';
  readonly title: string;
  readonly detail: string;
  /** The existing surface this step calls — the plan says what it reuses. */
  readonly uses: string;
  readonly after: readonly string[];
  readonly when?: readonly string[];
  readonly sideEffect: boolean;
  readonly warnings: readonly string[];
}

/** The inspectable plan a person reviews before publishing. Topological order. */
export function buildWorkflowPlan(
  definition: WorkflowDefinition,
  context: WorkflowPlanContext = {},
): readonly WorkflowPlanStep[] {
  const order = topologicalOrder(definition.nodes) ?? definition.nodes.map((n) => n.id);
  const byId = new Map(definition.nodes.map((n) => [n.id, n]));
  const steps: WorkflowPlanStep[] = [
    {
      id: 'trigger',
      type: 'trigger',
      title: describeSchedule(definition.schedule),
      detail:
        definition.schedule.kind === 'manual'
          ? 'Runs only when started by hand (Run now, `og workflow-run`, or the MCP tool).'
          : definition.schedule.kind === 'event'
            ? 'Each new reply in this workflow’s campaign starts a run.'
            : 'Each run tops the pipeline up; autopilot paces sending through the day.',
      uses: 'worker tick',
      after: [],
      sideEffect: false,
      warnings: [],
    },
  ];
  for (const id of order) {
    const node = byId.get(id)!;
    steps.push({
      id: node.id,
      type: node.type,
      title: node.label,
      ...describeNode(node, context),
      after: node.after,
      ...(node.when ? { when: node.when } : {}),
      sideEffect: SIDE_EFFECT_NODE_TYPES.includes(node.type),
    });
  }
  return steps;
}

function describeNode(
  node: WorkflowNode,
  context: WorkflowPlanContext,
): { detail: string; uses: string; warnings: string[] } {
  const c = node.config;
  switch (node.type) {
    case 'discover_opportunities':
      return c.source === 'job_posts'
        ? {
            detail: `Job boards: “${String(c.query)}”, up to ${String(c.limit)} postings a run; the hiring contact behind each is resolved.`,
            uses: 'POST /api/v1/job-posts/search',
            warnings:
              context.jobSearchEnabled === false
                ? ['job search is not configured on this server, so this step skips']
                : [],
          }
        : {
            detail: `Companies matching “${String(c.query)}”: picked, crawled, and the people on them named.`,
            uses: 'discover_domains → crawl_site jobs',
            warnings: [],
          };
    case 'enrich':
      return {
        detail: c.findEmail
          ? 'Company facts and a published or provider-verified address for each person.'
          : 'Company facts only; no address search.',
        uses: 'enrichment sweep + find_email',
        warnings: [],
      };
    case 'verify_contact':
      return {
        detail: c.allowSharedInbox
          ? 'Only addresses that pass verification; no guessed patterns.'
          : 'Only addresses that pass verification; no guessed patterns. A first email whose only route is a shared company inbox (team@, info@) is skipped until a personal address is found.',
        uses: 'email verification + lead screening',
        warnings: [],
      };
    case 'score_filter': {
      const t = c as unknown as WorkflowTargeting;
      const parts = [
        t.titles.length ? t.titles.join(', ') : 'any role',
        t.industries.length ? `in ${t.industries.join(', ')}` : '',
        t.countries.length ? `based in ${t.countries.join(', ')}` : '',
        sizeLabel(t),
        t.technologies.length ? `uses ${t.technologies.join(', ')}` : '',
        t.exclusions.length ? `never ${t.exclusions.join(', ')}` : '',
      ].filter(Boolean);
      return {
        detail: parts.join(' · '),
        uses: 'AutoGTM targeting → ICP fit score',
        warnings: t.titles.length === 0 ? ['no titles: every person found scores as a fit'] : [],
      };
    }
    case 'deduplicate':
      return {
        detail: `Skips anyone suppressed, opted out, or already emailed at the same address in the last ${String(c.cooldownDays)} days — from any campaign, imported history included.`,
        uses: 'suppression list + sent history',
        warnings: [],
      };
    case 'draft':
      return {
        detail: `At most ${String(c.maxWords)} words; every claim cites stored evidence, failing drafts are held.`,
        uses: 'composer + quality checks',
        warnings: [],
      };
    case 'approval':
      return c.mode === 'autopilot'
        ? {
            detail: 'Trusted send: approved by rule, still policy-checked per message.',
            uses: 'autopilot',
            warnings: ['autopilot sends without a person reading each message'],
          }
        : {
            detail: 'Review every send: nothing goes out until you approve it in Approve.',
            uses: 'approval queue',
            warnings: [],
          };
    case 'send': {
      const limit = Number(c.dailyLimit);
      const ceiling = context.workspaceDailyCap;
      const effective = ceiling === undefined ? limit : Math.min(limit, ceiling);
      return {
        detail: `Up to ${effective} a day (asked for ${limit}) — a ceiling, never a target; ${String(c.maxPerAddressPerWeek)} per address per week. The policy engine re-checks each message when it is sent.`,
        uses: 'policy engine + sender pool',
        warnings:
          ceiling !== undefined && ceiling < limit
            ? [
                `the workspace sends at most ${ceiling} a day across all campaigns; raise it in Settings to reach ${limit}`,
              ]
            : [],
      };
    }
    case 'wait':
      return {
        detail: `${String(c.days)} days before any follow-up; a reply, opt-out or bounce stops the sequence.`,
        uses: 'cadence timing',
        warnings: [],
      };
    case 'classify_reply':
      return {
        detail: `Each reply is labelled: ${WORKFLOW_REPLY_LABELS.join(', ')}.`,
        uses: 'triage_reply',
        warnings: [],
      };
    case 'branch':
      return {
        detail: 'Routes each reply by its label to the steps below.',
        uses: 'reply labels',
        warnings: [],
      };
    case 'log_crm':
      return {
        detail: 'Records the person, the thread and the stage in the connected CRM.',
        uses: 'CRM sync',
        warnings: context.crmConnected === false ? ['no CRM is connected, so this step skips'] : [],
      };
    case 'notify':
      return {
        detail:
          c.on === 'run_failed'
            ? 'Emails you when a run fails.'
            : c.on === 'daily_summary'
              ? 'Includes this workflow in the daily digest.'
              : 'Emails you as soon as a reply needs you.',
        uses: 'workspace alerts',
        warnings: [],
      };
  }
}

// -------------------------------------------------------------- schedule

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function describeSchedule(schedule: WorkflowSchedule): string {
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} ${schedule.timezone}`;
  switch (schedule.kind) {
    case 'manual':
      return 'Runs when you start it';
    case 'event':
      return 'Runs when a reply comes in';
    case 'daily':
      return `Every day at ${time}`;
    case 'weekdays':
      return `Every weekday at ${time}`;
    case 'weekly':
      return `Every ${DAY_NAMES[schedule.weekday ?? 1]} at ${time}`;
  }
}

/**
 * The next run strictly after `from`, at local wall-clock time in the
 * schedule's zone; `null` for manual and event triggers.
 *
 * DST is the zone's business: 08:00 in Los Angeles is 15:00 UTC in summer and
 * 16:00 in winter, and both are right. A missed slot (the worker was down) is
 * run once on the next tick and the schedule then returns to its slot.
 */
export function nextWorkflowRunAt(schedule: WorkflowSchedule, from: Date): Date | null {
  if (schedule.kind === 'manual' || schedule.kind === 'event') return null;
  const today = localDate(from, schedule.timezone);
  for (let i = 0; i < 9; i += 1) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    if (!fits(schedule, day.getUTCDay())) continue;
    const at = zonedTimeToUtc(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      schedule.hour,
      schedule.minute,
      schedule.timezone,
    );
    if (at > from) return at;
  }
  return null;
}

function fits(schedule: WorkflowSchedule, day: number): boolean {
  if (schedule.kind === 'weekdays') return day >= 1 && day <= 5;
  if (schedule.kind === 'weekly') return day === (schedule.weekday ?? 1);
  return true;
}

function zoneParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

function localDate(date: Date, timeZone: string) {
  const { year, month, day } = zoneParts(date, timeZone);
  return { year, month, day };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = zoneParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/** Local wall-clock time in `timeZone` → the UTC instant. Two passes for DST edges. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetMs(new Date(wall), timeZone);
  const second = wall - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

// ------------------------------------------------------------- templates

export interface WorkflowTemplate {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** The English a person would have typed; shown and editable. */
  readonly prompt: string;
  readonly definition: WorkflowDefinition;
}

/**
 * Engineering Contract Acquisition (PRD-ECO §3, §14).
 *
 * Live contract roles at direct employers first: the job boards are searched
 * for contract engineering postings and the markets where they are most
 * common are discovered, the people reached are the ones with hiring
 * authority (or an accountable internal recruiter), and staffing agencies are
 * excluded by default. 200 a day is the ceiling the PRD names — never a
 * target — and every send waits for approval until someone turns that off.
 */
export const ENGINEERING_CONTRACT_TEMPLATE: WorkflowTemplate = {
  id: 'engineering-contract-acquisition',
  name: 'Engineering Contract Acquisition',
  summary:
    'Find live contract engineering roles at direct employers in the Bay Area and remote US, ' +
    'reach the people with hiring authority, and offer senior TypeScript, full stack and AI ' +
    'engineering. Up to 200 verified, de-duplicated emails a day, each one approved by you.',
  prompt:
    'Search job boards for companies hiring a contract software engineer and a contract full ' +
    'stack engineer. Also find Bay Area software companies hiring engineers and remote-first ' +
    'US startups hiring engineers. Email the CTO, VP of Engineering, Head of Engineering, ' +
    'Director of Engineering, engineering manager or internal technical recruiter at companies ' +
    'with 10 to 1000 employees in the United States that use TypeScript, Node, React or AI. ' +
    'Not staffing agencies, not recruiting agencies. Send up to 200 qualified emails per day ' +
    'with my approval, every weekday at 8am Pacific.',
  definition: compileWorkflow({
    version: 1,
    goal: 'Win engineering contracts from direct employers hiring engineers right now.',
    sources: [
      { kind: 'job_posts', query: 'contract software engineer', limit: 20 },
      { kind: 'job_posts', query: 'contract full stack engineer', limit: 20 },
      { kind: 'discover', query: 'Bay Area software companies hiring engineers' },
      { kind: 'discover', query: 'remote-first US startups hiring engineers' },
    ],
    targeting: {
      titles: [
        'CTO',
        'VP of Engineering',
        'Head of Engineering',
        'Director of Engineering',
        'Engineering Manager',
        'Technical Recruiter',
      ],
      seniorities: [],
      industries: [],
      countries: ['United States'],
      keywords: ['contract', 'hiring'],
      technologies: ['TypeScript', 'Node.js', 'React', 'AI'],
      exclusions: ['staffing agencies', 'recruiting agencies'],
      employeeCountMin: 10,
      employeeCountMax: 1000,
    },
    outreach: { channel: 'email', dailyLimit: 200, approval: 'review', maxPerAddressPerWeek: 1 },
    schedule: { kind: 'weekdays', hour: 8, minute: 0, timezone: DEFAULT_WORKFLOW_TIMEZONE },
  }),
};

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [ENGINEERING_CONTRACT_TEMPLATE];

export function workflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((template) => template.id === id);
}

// --------------------------------------------------------------- helpers

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'string' ? Number(value.replace(/,/g, '')) : Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sizeLabel(t: WorkflowTargeting): string {
  if (t.employeeCountMin !== null && t.employeeCountMax !== null) {
    return `${t.employeeCountMin}–${t.employeeCountMax} employees`;
  }
  if (t.employeeCountMax !== null) return `up to ${t.employeeCountMax} employees`;
  if (t.employeeCountMin !== null) return `${t.employeeCountMin}+ employees`;
  return '';
}
