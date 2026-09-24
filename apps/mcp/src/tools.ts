/**
 * The tools an agent may drive.
 *
 * The point of this surface is not convenience. It is that **an agent driving
 * these tools cannot be talked into breaking a platform's terms**, and that
 * this is true by construction rather than by prompt.
 *
 * Three properties make it true, and all three live outside this file:
 *
 *   1. Every mutation goes through `/api/v1`, which re-runs the deterministic
 *      policy engine at execution time. No prompt reaches it.
 *   2. The engine fails closed: an unknown (network, action) pair is DENY, so
 *      a novel-sounding request is refused rather than improvised.
 *   3. This process holds no database handle. There is no faster path for a
 *      persuasive caller to be pointed at, because there is no other path.
 *
 * So the honest framing for a tool description is not "please don't automate
 * LinkedIn". It is "no tool here can decide what is automated": an agent can
 * approve a card, and the engine decides at that moment whether it runs.
 * LinkedIn actions run only through the member's own session, which exists
 * only after the workspace owner explicitly accepted LinkedIn's terms risk
 * (`og connect linkedin --accept-linkedin-risk`) — something no tool here can
 * do — and they are then paced and capped. Without that session every
 * LinkedIn action is a hand-off, and `share_link` is what to use instead.
 */

import type { ApiClient } from './client';

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** True when the tool only reads. Surfaced to the host as a hint. */
  readonly readOnly: boolean;
  run(client: ApiClient, args: Record<string, unknown>): Promise<unknown>;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function require(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'find_prospects',
    title: 'Find prospects',
    description:
      'List prospects in this workspace, most promising first. Returns the opportunity ' +
      'score and its components, so you can explain a ranking rather than assert it.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string', description: 'Restrict to one campaign.' },
        limit: { type: 'number', description: 'Maximum to return (default 25).' },
      },
    },
    run: (client, args) =>
      client.get('/people', {
        ...(str(args, 'campaignId') ? { campaignId: str(args, 'campaignId') } : {}),
        limit: String(typeof args.limit === 'number' ? Math.min(args.limit, 200) : 25),
      }),
  },
  {
    name: 'get_signals',
    title: 'Get signals',
    description:
      'The public evidence collected about one prospect: what they said, where, and when. ' +
      'This is the only material any message about them may cite.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { personId: { type: 'string' } },
      required: ['personId'],
    },
    run: (client, args) => client.get(`/people/${require(args, 'personId')}/signals`),
  },
  {
    name: 'check_policy',
    title: 'Check what is permitted',
    description:
      'Ask what the product may do on a network before planning anything. The answer comes ' +
      'from a deterministic policy engine, not from a model, and it is re-checked at ' +
      'execution time regardless of what it says now. Use it to plan; do not treat a stale ' +
      'answer as permission.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        recommendationId: {
          type: 'string',
          description: 'The card whose action should be evaluated.',
        },
      },
      required: ['recommendationId'],
    },
    run: (client, args) =>
      client.get(`/recommendations/${require(args, 'recommendationId')}/share`),
  },
  {
    name: 'list_recommendations',
    title: 'List the approval queue',
    description:
      'Cards waiting for a decision, each naming the prospect, the proposed action, the ' +
      'network, and the policy decision it was generated under.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'pending, approved, executed, skipped.' },
        limit: { type: 'number' },
      },
    },
    run: (client, args) =>
      client.get('/recommendations', {
        ...(str(args, 'status') ? { status: str(args, 'status') } : {}),
        limit: String(typeof args.limit === 'number' ? Math.min(args.limit, 100) : 25),
      }),
  },
  {
    name: 'draft_message',
    title: 'Draft a message',
    description:
      "Write the message for one card. Every specific claim must appear in that prospect's " +
      'stored evidence; a draft that fails those checks is withheld rather than returned ' +
      'with a warning, so an empty result means "nothing could be said honestly", not an error.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { recommendationId: { type: 'string' } },
      required: ['recommendationId'],
    },
    run: (client, args) =>
      client.post(`/recommendations/${require(args, 'recommendationId')}/draft`, {}),
  },
  {
    name: 'approve',
    title: 'Approve a card',
    description:
      'Approve one card for sending. The policy engine runs again here against current ' +
      'state — a suppression, a spent rate limit or a flipped flag will refuse an approval ' +
      'that would have been fine an hour ago, and the refusal names the gate.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        recommendationId: { type: 'string' },
        note: { type: 'string', description: 'Why, for the audit trail.' },
      },
      required: ['recommendationId'],
    },
    run: (client, args) =>
      client.post(`/recommendations/${require(args, 'recommendationId')}/approve`, {
        ...(str(args, 'note') ? { note: str(args, 'note') } : {}),
      }),
  },
  {
    name: 'share_link',
    title: 'Get a prefilled composer link',
    description:
      'For networks the product may not post to — Reddit, X direct messages, and LinkedIn ' +
      'when the workspace has not connected its own LinkedIn session — this returns a link ' +
      'that opens their own composer with the message already written. A person clicks it ' +
      'and posts under their own account. For those cases this is the correct and only way ' +
      'to act; there is no automated path and asking for one will be refused by the policy engine.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        recommendationId: { type: 'string' },
        network: { type: 'string', description: 'linkedin, x, reddit, mastodon, telegram, …' },
      },
      required: ['recommendationId', 'network'],
    },
    run: (client, args) =>
      client.post(`/recommendations/${require(args, 'recommendationId')}/share`, {
        network: require(args, 'network'),
      }),
  },
  {
    name: 'list_cadences',
    title: 'List plans',
    description:
      'The plans (cadences) in this workspace: ordered touches over time, with how many ' +
      'steps each has and how many prospects are on it.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    run: (client) => client.get('/cadences'),
  },
  {
    name: 'get_cadence',
    title: 'Read one plan',
    description:
      'One plan’s steps in order: network, action, delay, the condition each step runs ' +
      'under (always, if_connected, if_not_connected, if_no_reply, if_clicked, if_not_clicked) ' +
      'and how long a LinkedIn invitation step waits for acceptance.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { cadenceId: { type: 'string' } },
      required: ['cadenceId'],
    },
    run: (client, args) =>
      client.get(`/cadences/${encodeURIComponent(require(args, 'cadenceId'))}`),
  },
  {
    name: 'create_cadence',
    title: 'Write a plan',
    description:
      'Create a plan of touches, as a draft unless status is "active". Each step names a ' +
      'network, an action and a delay in hours after the previous step, and may carry a ' +
      'condition evaluated when it falls due; a step whose condition is false is skipped on ' +
      'the record. Two neighbouring steps with opposite conditions are a branch, e.g. ' +
      'linkedin connect (waitForAcceptanceHours 168), then linkedin send_dm if_connected, ' +
      'then email send_email if_not_connected. Writing a plan decides nothing about what is ' +
      'automated: every step still goes through the policy engine when it falls due.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        campaignId: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'active'] },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              network: { type: 'string' },
              action: { type: 'string' },
              delayHours: { type: 'number' },
              intent: { type: 'string' },
              stopOnReply: { type: 'boolean' },
              condition: {
                type: 'string',
                enum: [
                  'always',
                  'if_connected',
                  'if_not_connected',
                  'if_no_reply',
                  'if_clicked',
                  'if_not_clicked',
                ],
              },
              waitForAcceptanceHours: {
                type: 'number',
                description: 'On a linkedin connect step only.',
              },
            },
            required: ['network', 'action'],
          },
        },
      },
      required: ['name', 'steps'],
    },
    // Validation is the server's: a malformed plan comes back as sentences.
    run: (client, args) =>
      client.post('/cadences', {
        name: require(args, 'name'),
        steps: Array.isArray(args.steps) ? args.steps : [],
        ...(str(args, 'campaignId') ? { campaignId: str(args, 'campaignId') } : {}),
        ...(str(args, 'status') ? { status: str(args, 'status') } : {}),
      }),
  },
  {
    name: 'research_grid',
    title: 'Ask questions across many prospects',
    description:
      'Create a grid: N questions answered for M prospects, from stored evidence only. ' +
      'Cells with no supporting evidence come back empty rather than guessed. Costs one ' +
      'model call per cell, so the grid reports its size before you run it.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        questions: { type: 'array', items: { type: 'string' } },
        personIds: { type: 'array', items: { type: 'string' } },
        campaignId: { type: 'string' },
      },
      required: ['name', 'questions', 'personIds'],
    },
    run: (client, args) =>
      client.post('/grids', {
        name: require(args, 'name'),
        questions: Array.isArray(args.questions) ? args.questions : [],
        personIds: Array.isArray(args.personIds) ? args.personIds : [],
        ...(str(args, 'campaignId') ? { campaignId: str(args, 'campaignId') } : {}),
      }),
  },
  {
    name: 'run_grid',
    title: 'Answer outstanding grid cells',
    description: 'Advance a grid and report how far it got. Safe to call repeatedly; it resumes.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        gridId: { type: 'string' },
        limit: { type: 'number', description: 'Cells to answer in this call.' },
      },
      required: ['gridId'],
    },
    run: (client, args) =>
      client.post(`/grids/${require(args, 'gridId')}/run`, {
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      }),
  },
  {
    name: 'read_grid',
    title: 'Read a grid',
    description: 'The grid as a table, with each answer and the evidence it rests on.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { gridId: { type: 'string' } },
      required: ['gridId'],
    },
    run: (client, args) => client.get(`/grids/${require(args, 'gridId')}`),
  },
  {
    name: 'list_playbooks',
    title: 'List playbooks',
    description:
      'Prepackaged plays: who to look for, what should trigger a touch, and the sequence ' +
      'of touches. A good starting point when a campaign has no brief yet.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    run: (client) => client.get('/playbooks'),
  },
  {
    name: 'add_prospect',
    title: 'Add a prospect',
    description:
      'Start the pipeline from a URL — a profile, a company page, a post. Enrichment, ' +
      'identity resolution, signals and scoring run from there.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        campaignId: { type: 'string' },
      },
      required: ['url'],
    },
    run: (client, args) =>
      client.post('/prospects/by-url', {
        url: require(args, 'url'),
        ...(str(args, 'campaignId') ? { campaignId: str(args, 'campaignId') } : {}),
      }),
  },
  {
    name: 'add_people_from_social',
    title: 'Hand over people from a social network',
    description:
      'Add people known only by a social handle (Bluesky, Mastodon, X, GitHub, ...): the accounts ' +
      'you follow, or their followers. Each lands in a campaign for assessment; their bio becomes a ' +
      'signal and an OpenProfile.md is assembled from their profile and home page. Nothing is sent.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        people: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            properties: {
              network: {
                type: 'string',
                description:
                  'bluesky, mastodon, x, github, reddit, youtube, instagram, linkedin, nostr',
              },
              handle: {
                type: 'string',
                description: 'Without the @. A Fediverse handle keeps its host: ada@hachyderm.io.',
              },
              profileUrl: { type: 'string' },
              platformUserId: {
                type: 'string',
                description: 'A DID or numeric id, when the network has one.',
              },
              displayName: { type: 'string' },
              bio: { type: 'string' },
              avatarUrl: { type: 'string' },
              via: {
                type: 'string',
                description: 'How you came by them: follow, following, followers, graph.',
              },
            },
            required: ['network', 'handle'],
          },
        },
        campaignId: { type: 'string', description: "Defaults to the workspace's active campaign." },
        source: {
          type: 'string',
          description: 'The client sending them, recorded on the audit trail.',
        },
      },
      required: ['people'],
    },
    run: (client, args) =>
      client.post('/people/from-social', {
        people: Array.isArray(args.people) ? args.people : [],
        source: str(args, 'source') ?? 'mcp',
        ...(str(args, 'campaignId') ? { campaignId: str(args, 'campaignId') } : {}),
      }),
  },
  {
    name: 'get_openprofile',
    title: "Get a person's OpenProfile.md",
    description:
      'The OpenProfile.md (logicsrc.com/openprofile) assembled for one person: name, handle, home ' +
      'page, the accounts that are theirs, topics. Absent until the openprofile job has run for them.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { personId: { type: 'string' } },
      required: ['personId'],
    },
    run: async (client, args) => {
      const result = (await client.get(
        `/people/${encodeURIComponent(require(args, 'personId'))}/openprofile.md`,
      )) as { raw?: string };
      return { markdown: result.raw ?? '' };
    },
  },
  {
    name: 'update_openprofile',
    title: "Correct a person's OpenProfile.md",
    description:
      'Correct the OpenProfile.md OutreachGraph assembled for a person. Send the whole edited file ' +
      'as `markdown`, or a partial overlay: `identity` keys (null removes one), `headline`, and ' +
      '`sections` by name (`accounts`, `topics`, `broadcast`, `guest`, ...; the single word `none` ' +
      'removes a generated section). What you write wins over what the generator wrote; the rest ' +
      'is still generated. `public` switches the profile public or private; `handle` names it.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        personId: { type: 'string' },
        markdown: {
          type: 'string',
          description: 'The whole OpenProfile.md, when editing the file.',
        },
        identity: {
          type: 'object',
          additionalProperties: { type: ['string', 'null'] },
          description: 'Identity block keys: Kind, Handle, Web, Avatar, Location, Pronouns, ...',
        },
        headline: { type: ['string', 'null'] },
        sections: {
          type: 'object',
          additionalProperties: { type: ['string', 'null'] },
          description: 'Section bodies in Markdown, by normalised section name.',
        },
        public: { type: 'boolean' },
        handle: { type: ['string', 'null'] },
      },
      required: ['personId'],
    },
    run: (client, args) => {
      const personId = require(args, 'personId');
      const body: Record<string, unknown> = {};
      for (const key of [
        'markdown',
        'identity',
        'headline',
        'sections',
        'public',
        'handle',
      ] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      // An empty overlay is the server's to refuse, so that every mutation
      // still leaves this process as an HTTP call.
      return client.put(`/people/${encodeURIComponent(personId)}/openprofile`, body);
    },
  },
  {
    name: 'publish_openprofile',
    title: "Switch a person's OpenProfile.md public or private",
    description:
      'Make the OpenProfile.md OutreachGraph holds about a person public, so directories such as ' +
      'nichedb.dev can read it at /api/v1/people/{id}/openprofile.md and through /api/v1/openprofiles, ' +
      'or private again. A public profile never carries an email or phone. A suppressed person is never public.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        personId: { type: 'string' },
        public: { type: 'boolean' },
      },
      required: ['personId', 'public'],
    },
    run: (client, args) =>
      client.post(`/people/${encodeURIComponent(require(args, 'personId'))}/openprofile/publish`, {
        public: args.public === true,
      }),
  },
  {
    name: 'suppress',
    title: 'Never contact this person again',
    description:
      'Record an opt-out. This survives deletion of the person, so a later provider lookup ' +
      'cannot silently re-ingest them. Use it whenever somebody asks not to be contacted.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        personId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['personId'],
    },
    run: (client, args) =>
      client.post('/suppressions', {
        personId: require(args, 'personId'),
        reason: str(args, 'reason') ?? 'requested by an agent',
      }),
  },
  {
    name: 'list_webhooks',
    title: 'List webhook endpoints',
    description:
      'The endpoints this workspace sends events to (generic signed JSON, or Slack), which events ' +
      'each receives, and how its last delivery went. URLs are shown only as a hint and signing ' +
      'secrets are never returned. Also lists every event type that can be subscribed to.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    run: (client) => client.get('/webhooks'),
  },
  {
    name: 'add_webhook',
    title: 'Add a webhook endpoint',
    description:
      'Send workspace events (reply.received, link.clicked, prospect.created, ' +
      'recommendation.approved, action.sent, cadence.completed, person.suppressed) to an https ' +
      'URL: a Zapier, Make or n8n catch hook, your own server, or a Slack incoming webhook with ' +
      'kind "slack". Private and internal addresses are refused. The response carries the signing ' +
      'secret exactly once; deliveries are signed X-OutreachGraph-Signature: t=<unix>,v1=<hex> ' +
      'over "<t>.<raw body>" with HMAC-SHA256.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'An https URL.' },
        kind: { type: 'string', enum: ['generic', 'slack'], description: 'Default generic.' },
        events: {
          type: 'array',
          items: { type: 'string' },
          description: 'Event types to receive. Omit for all.',
        },
        description: { type: 'string' },
      },
      required: ['url'],
    },
    run: (client, args) =>
      client.post('/webhooks', {
        url: require(args, 'url'),
        kind: str(args, 'kind') === 'slack' ? 'slack' : 'generic',
        ...(Array.isArray(args.events) ? { events: args.events.map(String) } : {}),
        ...(str(args, 'description') ? { description: str(args, 'description') } : {}),
      }),
  },
];

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/**
 * Runs a tool and always returns a promise.
 *
 * Argument validation happens before the first await, so a missing argument
 * throws synchronously out of an arrow declared to return a promise. Every
 * caller today wraps the call in try/catch and is fine; this exists so the
 * next one does not have to know that.
 */
export async function runTool(
  tool: ToolDefinition,
  client: ApiClient,
  args: Record<string, unknown>,
): Promise<unknown> {
  return tool.run(client, args);
}
