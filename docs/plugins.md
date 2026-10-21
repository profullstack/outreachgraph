# Plugins (design)

A way to add a lead source, a listening feed, an enricher or a CRM, plus the
jobs, MCP tools and CLI verbs that go with it, without editing core. The first
plugin is r/LocalLLaMA: people building on local models, read from the Arctic
Shift archive (posts and comments).

Status: proposal. Nothing here is built yet.

## What exists today

The seams are already there. What is missing is a registry: every
implementation is listed by hand.

| Kind             | Interface                                                       | Where it is wired by hand                                                                       |
| ---------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Company importer | `LeadSourceDefinition` (`pipeline/src/lead-sources/sources.ts`) | `defaultLeadSources()`; `sweepLeadSources` already takes `deps.sources`                         |
| Listening feed   | `FeedSource` (`providers/src/feeds/source.ts`)                  | `LISTEN_SOURCE_SLUGS` tuple + `buildListeningSources()` `if` chain (`apps/server/src/index.ts`) |
| Buyer-lead feed  | same `FeedSource`                                               | `LEAD_SOURCES` tuple + `buildLeadSources()` (`community-leads.ts`)                              |
| Audience reader  | `AudienceReader` (`providers/src/audience.ts`)                  | `AUDIENCE_NETWORKS` + `audienceReaderFor()`                                                     |
| Enricher         | `PersonEnrichmentProvider` (`providers/src/provider.ts`)        | `fanOutProviders = [new BlueskyProvider()]`                                                     |
| CRM              | `CrmClient`                                                     | `crmClientFor()`                                                                                |
| Job              | `JOB_KINDS` tuple                                               | `switch (job.kind)` in `runJob`                                                                 |
| MCP tool         | `ToolDefinition` (`apps/mcp/src/tools.ts`)                      | static `TOOLS`                                                                                  |
| CLI verb         | `Command` (`apps/cli/src/commands.ts`)                          | static `COMMANDS`                                                                               |

Senders (email, X, LinkedIn, Bluesky) have no common interface. They stay core
for now (see Non-goals).

## Shape

One new package, `packages/plugin-sdk`, and plugins as ordinary workspace or
npm packages (`@outreachgraph/plugin-<name>`):

```ts
export interface OutreachPlugin {
  readonly id: string; // 'reddit-archive'; namespaces everything below
  readonly version: string;
  readonly label: string;
  readonly config?: JsonSchema; // per-workspace settings, validated on install
  readonly secrets?: readonly string[]; // names; values stored encrypted per workspace

  readonly leadSources?: readonly LeadSourceDefinition[];
  readonly feeds?: readonly FeedFactory[]; // (ctx) => FeedSource
  readonly enrichers?: readonly EnricherFactory[]; // (ctx) => PersonEnrichmentProvider
  readonly audienceReaders?: readonly AudienceReaderFactory[];
  readonly crm?: readonly CrmFactory[];

  readonly tasks?: readonly PluginTask[]; // background work, see Jobs
  readonly schedules?: readonly { task: string; everyMinutes: number }[];

  readonly mcpTools?: readonly ToolDefinition[]; // names prefixed `<id>_`
  readonly cliCommands?: readonly Command[]; // `og <id> <verb>`
  readonly routes?: (app: Hono, ctx: PluginRouteContext) => void; // under /api/v1/plugins/<id>
  readonly capabilityRules?: readonly CapabilityRule[]; // additive only, see Policy
}

export const definePlugin = (plugin: OutreachPlugin) => plugin;
```

The existing interfaces are reused as they are. A plugin is a bundle of things
core already knows how to run.

### Loading

- `OUTREACHGRAPH_PLUGINS=reddit-archive,@acme/outreachgraph-plugin-foo` names
  them. The server, the API and the MCP/CLI builds import each one at boot and
  build one `PluginRegistry`.
- The registry rejects a duplicate id, a slug that collides with a core
  source, or an unprefixed tool or job name, and the server will not start.
  It fails loudly at boot, not halfway through a tick.
- Trusted and in-process. A plugin runs with the server's privileges, like any
  other dependency, so installing one means reviewing it like a dependency.
  Untrusted third parties get remote plugins (phase 3).

### The closed lists become registry lookups

- `LISTEN_SOURCE_SLUGS`, `LEAD_SOURCES` and `AUDIENCE_NETWORKS` stay as the core
  set. API validation becomes `core ∪ registry.feedSlugs()`, so
  `listen_sources: ["reddit-archive"]` is accepted only when the plugin is
  loaded.
- `buildListeningSources()`, `buildLeadSources()`, `defaultLeadSources()` and
  `fanOutProviders` each append `registry.*(ctx)`.
- `Network` stays closed. A plugin feed reports one of the existing networks
  (`reddit`, `hackernews`, `rss`, `nostr`, `bluesky`, `web`), so policy,
  identities and the UI keep working. A truly new network is a core change,
  on purpose.

### Writes go through a context, not the database

A plugin never gets the `db` handle. It gets a `PluginContext`:

```ts
interface PluginContext {
  workspaceId: string | null; // null for global lead sources
  config: unknown; // validated against plugin.config
  secret(name: string): Promise<string | undefined>;
  fetch: typeof fetch; // paced, timeout, UA set, logged per plugin
  state: { get<T>(k: string): Promise<T | undefined>; set(k: string, v: unknown): Promise<void> };
  emit: {
    posts(posts: FeedPost[]): Promise<number>; // -> listen.ts writeSignal path
    leads(monitorId: string, posts: FeedPost[]): Promise<number>; // -> community_leads + scoring
    companies(c: LeadCandidate[]): Promise<number>; // -> storeLeadCandidates
    person(c: PersonCandidate, origin: CandidateOrigin): Promise<void>; // -> runPipelineForCandidate
  };
  log: Logger;
}
```

Every `emit.*` goes through the dedupe the core path already has (signals by
`source_url`, community leads by `(monitor_id, source, external_id)`, companies
by domain), plus the existing caps (`LEAD_IMPORT_DAILY_TOTAL`, per-source
`dailyCap`). A buggy plugin can produce bad rows. It cannot skip dedupe, caps,
scoring or policy.

### Jobs

There is one new job kind, `plugin_task`, with payload
`{ plugin, task, args }`. `runJob` gets one more case, which looks the task up
in the registry and calls `task.run(args, ctx)`. `jobs.kind` is plain `TEXT`
(`0007_jobs.sql`), so this needs no migration, and plugins never edit
`JOB_KINDS`.

- Dedupe key: `plugin:<id>:<task>:<caller key>`. The existing partial unique
  index makes concurrent enqueues safe.
- Retry, backoff, the 15-minute lease and `isOutage` deferral all come free from
  `queue.ts`. A task throws `FeedRateLimitError` to be treated as an outage
  rather than burning attempts.
- `schedules` are enqueued by `tick()` when `plugin_state.next_run_at` is due,
  the same pattern as `lead_sources.next_run_at`.

### Storage

There are two tables, written as the usual pair (`migrations/` and
`migrations-pg/`, same filename):

```sql
-- 0075_plugins.sql
CREATE TABLE plugin_installs (
  workspace_id TEXT NOT NULL,
  plugin_id    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  config_json  TEXT NOT NULL DEFAULT '{}',
  secrets_enc  TEXT,            -- encryptSecret(JSON) via packages/secrets
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id)
);
CREATE TABLE plugin_state (
  plugin_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '', -- '' = global
  key          TEXT NOT NULL,
  value_json   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (plugin_id, workspace_id, key)
);
```

Cursors, `next_run_at` and ETags live in `plugin_state`. Plugin rows in
`signals`, `companies` and `community_leads` are tagged with the plugin id
(`lead_source = 'plugin:<id>'`, `signals.subtype` container) so they can be
filtered and bulk-deleted when a plugin is removed.

`feature_flags` gives a kill switch for free: `plugin.<id>` disabled globally
or for one workspace turns it off without a deploy.

### Policy

- Ingest stays outside the policy engine, as it is today, but every plugin
  feed must report a `Network` that already has an `observe` rule.
- `capabilityRules` can only add rules for `(network, action)` pairs core
  leaves undefined, and only `disabled` or `research_only`. A plugin cannot
  loosen a core rule. `evaluatePolicy` is unchanged: unknown means DENY.
- Credits are charged per contacted prospect, as now. Reading costs nothing,
  so a plugin cannot charge anyone.

### Surfaces

- API: `GET /api/v1/plugins` (loaded plus installed),
  `PUT /plugins/:id/install` (config and secrets),
  `POST /plugins/:id/tasks/:task` (run now), and the plugin's own routes under
  `/plugins/:id/*`.
- MCP: `list_plugins`, `install_plugin`, `run_plugin_task`, plus each
  plugin's `<id>_*` tools appended to `TOOLS`.
- CLI: `og plugins`, `og plugins install <id> --config k=v`,
  `og <id> <verb>`.
- Web: a Plugins tab in settings, rendering the form from `config` (JSON
  Schema).

## First plugin: `reddit-archive` with an r/LocalLLaMA preset

This is generic over subreddits, so it is not a one-off. r/LocalLLaMA is the
preset and the test bed. Measured 2026-10-21 against
`arctic-shift.photon-reddit.com`: 100 posts covered the last ~28 hours and 100
comments the last ~21 hours. The newest rows were under an hour old. Each row
has author, author flair (`llama.cpp`, …), link flair and the outbound URL.

What it adds over the core `RedditSource`:

1. **Comments.** The core reader pages `/api/posts/search` only. Most "what
   should I use for X" intent is in comments, so this pages
   `/api/comments/search?subreddit=&after=` with the same 2.5 s gap and cursor.
   It drops `AutoModerator`, `[deleted]` and `[removed]`.
2. **Builder detection → companies and people.** For a post whose link or body
   points at `github.com/<org>`, `huggingface.co/<org>` or a product domain,
   it emits the domain through `emit.companies`, and the author through
   `emit.person` with the Reddit handle plus the linked GitHub or HF identity.
   r/LocalLLaMA is mostly people shipping models, runtimes and tools. They are
   prospects, not just signals.
3. **Intent → buyer leads.** It feeds posts and comments to existing monitors
   through `emit.leads`, so scoring (`seeking`/`problem`/`discussion`/`promo`),
   the digest and drafted replies work unchanged.
4. **Flair as tags.** Author flair (`llama.cpp`, `Ollama`, `vLLM`) is a stack
   signal on the person, useful for targeting runtime-specific offers.

```ts
export default definePlugin({
  id: 'reddit-archive',
  version: '0.1.0',
  label: 'Reddit (Arctic Shift archive)',
  config: {
    type: 'object',
    properties: {
      subreddits: { type: 'array', items: { type: 'string' }, default: ['LocalLLaMA'] },
      comments: { type: 'boolean', default: true },
      builders: { type: 'boolean', default: true },
    },
  },
  feeds: [(ctx) => new ArchiveFeed(ctx)], // slug 'reddit-archive', network 'reddit'
  tasks: [{ name: 'sweep', run: sweepSubreddits }], // posts + comments since cursor
  schedules: [{ task: 'sweep', everyMinutes: 30 }],
  mcpTools: [/* reddit-archive_recent: latest builders seen, by subreddit */],
});
```

Reddit policy is unchanged: `send_dm` stays `disabled`. Outreach to someone
found here goes out on whatever channel identity resolution finds (the email
on their GitHub or HF profile, Bluesky, their site), never as a Reddit DM. A
Reddit reply is still only a draft a human posts.

Gotchas to carry over: the archive answers 422 to requests closer than about
2 s apart, a 429 must raise `FeedRateLimitError`, its full-text search times
out on busy subreddits (page by `after`/`before` instead), and a
subreddit-wide `sort=desc` call has timed out at least once
(`{"error":"Timeout. Maybe slow down a bit"}`). Treat that error as a
retryable outage.

## Phases

1. **SDK and registry, no behavior change.** Add `packages/plugin-sdk`, the
   registry and loader, the `plugin_task` kind, the migrations and
   `PluginContext`. Move the core Hacker News feed to register through the
   registry, as proof that the seam carries a real source. Done when tests
   still pass and listening output is identical.
2. **`plugins/reddit-archive`** with the r/LocalLLaMA preset, its own tests
   (fixture JSON from the archive), and the plugin surfaces on the API, MCP,
   CLI and Web. Done when a campaign with `listen_sources: ["reddit-archive"]`
   produces signals, buyer leads and builder companies from r/LocalLLaMA on
   prod.
3. **Remote plugins.** A manifest URL plus signed HTTP calls
   (`POST <base>/tasks/<task>` returning `FeedPost[]` / `LeadCandidate[]`) for
   third parties we do not want in-process. The same `emit.*` path runs on our
   side. This is also where a public plugin directory would go.

## Non-goals (for now)

- **Plugin senders.** Delivery is where the compliance risk is (identity
  confidence, pacing, policy). Senders stay core until they share one
  interface.
- **Sandboxing in-process plugins** (isolates, WASM). Phase 3's remote
  plugins are the isolation story.
- **New `Network` values from plugins.**
