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
    name: 'get_ab_results',
    title: 'A/B test results for a plan',
    description:
      'Sent and replied per arm (A = the step intent, B-D = variants) and every decided test. ' +
      'Tests decide themselves: at 50+ sends per arm a leader ahead at 95% confidence wins, and ' +
      'at 200+ per arm the best wins (a tie keeps A). The winner becomes the step intent.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { cadenceId: { type: 'string' } },
      required: ['cadenceId'],
    },
    run: (client, args) =>
      client.get(`/cadences/${encodeURIComponent(require(args, 'cadenceId'))}/variants`),
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
    name: 'start_product_campaigns',
    title: 'Start a campaign for each of your sites',
    description:
      'For a workspace that sells several products: give it your own sites (not prospects). ' +
      'Each is read, saved as a product with its own voice and buyer profile, and given a ' +
      'campaign that starts searching for buyers. Sites already a product are skipped. ' +
      'Returns a batchId; watch it with batch_status.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Your sites, e.g. ["ugig.net", "nichedb.dev"]. Up to 100.',
        },
        autopilot: {
          type: 'boolean',
          description: 'Send without per-message approval. Default false.',
        },
      },
      required: ['domains'],
    },
    run: (client, args) => {
      const domains = Array.isArray(args.domains)
        ? args.domains.filter((d): d is string => typeof d === 'string' && d.trim() !== '')
        : [];
      if (domains.length === 0) throw new Error('domains is required');
      return client.post('/campaigns/bulk', { domains, autopilot: args.autopilot === true });
    },
  },
  {
    name: 'batch_status',
    title: 'Progress of a bulk submission',
    description: 'Each item in a batch with its state (pending, running, done, failed) and error.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { batchId: { type: 'string' } },
      required: ['batchId'],
    },
    run: (client, args) => client.get(`/batches/${encodeURIComponent(require(args, 'batchId'))}`),
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
    name: 'list_ideas',
    title: 'List product ideas people keep asking for',
    description:
      'Ideas found on Reddit: posts of people asking for a site, app or tool, grouped by what they want ' +
      'and ranked by how many different people asked. Status "build" means enough people asked; ' +
      '"building" means it was handed to chovy.com.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['watching', 'build', 'building', 'dismissed'] },
      },
    },
    run: (client, args) =>
      client.get(
        str(args, 'status')
          ? `/ideas?status=${encodeURIComponent(str(args, 'status') as string)}`
          : '/ideas',
      ),
  },
  {
    name: 'get_idea',
    title: 'Read one idea and the posts that asked for it',
    description:
      'One idea: what people want it to do, its worth score and verdict (build / validate / watch / ' +
      'crowded), revenue its sources quote, matching launches (rivals), and every post that asked, with links.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (client, args) => client.get(`/ideas/${encodeURIComponent(str(args, 'id') as string)}`),
  },
  {
    name: 'scan_ideas',
    title: 'Scan Reddit and idea feeds for things worth building',
    description:
      "Reads the workspace's subreddits and RSS Amplifier feeds (Ask HN, founder case studies, " +
      'essays, Show HN launches) now, or only the ones given. Keeps asks and signals (pains, products ' +
      'making money), files them under ideas, and counts matching launches as rivals. Takes up to a ' +
      'minute: the public Reddit archive is read slowly on purpose.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        subs: { type: 'array', items: { type: 'string' } },
        feeds: {
          type: 'array',
          items: { type: 'string' },
          description: 'RSS Amplifier feed slugs, e.g. hnrss-org-7 (Ask HN)',
        },
      },
    },
    run: (client, args) =>
      client.post('/ideas/scan', {
        ...(Array.isArray(args.subs) ? { subs: args.subs } : {}),
        ...(Array.isArray(args.feeds) ? { feeds: args.feeds } : {}),
      }),
  },
  {
    name: 'set_idea_feeds',
    title: 'Choose the feeds the idea generator reads',
    description:
      'Replaces the RSS Amplifier feeds scanned for ideas. Each is a slug (or rssamplifier.com URL) ' +
      'with a role: "asks" (people asking for tools, like Ask HN), "signals" (case studies and essays ' +
      'about what sells; the default for a new slug), or "built" (launches, counted as competition).',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        feeds: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string' },
              role: { type: 'string', enum: ['asks', 'signals', 'built'] },
              name: { type: 'string' },
            },
            required: ['slug'],
          },
        },
      },
      required: ['feeds'],
    },
    run: (client, args) => client.put('/ideas/settings', { feeds: args.feeds }),
  },
  {
    name: 'build_idea',
    title: 'Build an idea with chovy.com',
    description:
      'Hands the idea (what to build, what it must do, who asked) to chovy.com and returns the link that ' +
      'opens its build intake with the idea filled in. Marks the idea "building".',
    readOnly: false,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (client, args) =>
      client.post(`/ideas/${encodeURIComponent(str(args, 'id') as string)}/build`, {}),
  },
  {
    name: 'list_audience_watches',
    title: 'List the accounts whose audience is being read',
    description:
      "The workspace's own accounts that are watched for engagement, and what each one reads. A " +
      'watch that stopped carries the reason it stopped.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { campaignId: { type: 'string' } },
    },
    run: (client, args) =>
      client.get(
        str(args, 'campaignId')
          ? `/audience?campaignId=${encodeURIComponent(str(args, 'campaignId') as string)}`
          : '/audience',
      ),
  },
  {
    name: 'watch_audience',
    title: 'Watch an account of your own for engagement',
    description:
      'Turn the people who follow, like, repost, reply to or mention one of your own accounts into ' +
      'prospects in a campaign. Bluesky is read from the public API; X needs a connected account on ' +
      'a plan that permits the reads; LinkedIn is hand-off only. Nothing is sent: each engager lands ' +
      'as a person with the engagement as evidence, and an automation rule is what may enrol them.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        network: { type: 'string', description: 'bluesky, x or linkedin' },
        account: {
          type: 'string',
          description: 'Your handle on that network, or your profile URL. Not the prospect.',
        },
        campaignId: { type: 'string', description: "Defaults to the workspace's active campaign." },
        kinds: {
          type: 'array',
          items: { type: 'string' },
          description: 'follow, like, repost, reply, mention. All of them when omitted.',
        },
        pollMinutes: { type: 'number', description: 'How often to read. 5 at the fastest.' },
        enabled: { type: 'boolean' },
      },
      required: ['network', 'account'],
    },
    run: (client, args) =>
      client.post('/audience', {
        network: require(args, 'network'),
        account: require(args, 'account'),
        ...(str(args, 'campaignId') ? { campaignId: str(args, 'campaignId') } : {}),
        ...(Array.isArray(args.kinds) ? { kinds: args.kinds } : {}),
        ...(typeof args.pollMinutes === 'number' ? { pollMinutes: args.pollMinutes } : {}),
        ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
      }),
  },
  {
    name: 'list_job_posts',
    title: 'List saved job postings and the people found behind them',
    description:
      'Job postings the workspace is working from, newest first, each with its company, whether a ' +
      'recruiting agency placed it, and the people a search found: name, role, LinkedIn profile, ' +
      'any address the company published, and the search result as evidence.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'new, contact_found, no_contact, failed, contacted, applied or archived',
        },
      },
    },
    run: (client, args) =>
      client.get(
        str(args, 'status')
          ? `/job-posts?status=${encodeURIComponent(str(args, 'status') as string)}`
          : '/job-posts',
      ),
  },
  {
    name: 'search_job_posts',
    title: 'Search the job boards by keyword',
    description:
      'Search Workable, Greenhouse, Lever and Ashby for postings matching a keyword such as ' +
      '"senior software engineer (remote)" (the quoted part is the title, parentheses are loose ' +
      'qualifiers), and add them to the list. Each is then read and searched for its people.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        boards: { type: 'array', items: { type: 'string' }, description: 'All four when omitted.' },
        limit: { type: 'number', description: 'Postings to add, 20 by default, 50 at most.' },
        campaignId: {
          type: 'string',
          description: 'Promote the best contact of each posting into this campaign.',
        },
      },
      required: ['keyword'],
    },
    run: (client, args) =>
      client.post('/job-posts/search', {
        keyword: require(args, 'keyword'),
        ...(Array.isArray(args.boards) ? { boards: args.boards } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(str(args, 'campaignId') ? { campaignId: str(args, 'campaignId') } : {}),
      }),
  },
  {
    name: 'add_job_posts',
    title: 'Add job postings by URL',
    description:
      'Save one or more job posting URLs (Workable, Greenhouse, Lever, Ashby, or any careers page). ' +
      'A URL already in the list is reported as a duplicate.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' } },
        campaignId: { type: 'string' },
      },
      required: ['urls'],
    },
    run: (client, args) =>
      client.post('/job-posts', {
        urls: Array.isArray(args.urls) ? args.urls : [],
        ...(str(args, 'campaignId') ? { campaignId: str(args, 'campaignId') } : {}),
      }),
  },
  {
    name: 'find_job_post_contacts',
    title: 'Find the people behind one job posting, now',
    description:
      'Read the posting from its board and search LinkedIn for the founders, engineering leaders ' +
      'and recruiters of the company. Only results that name the company as itself are kept.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { jobPostId: { type: 'string' } },
      required: ['jobPostId'],
    },
    run: (client, args) =>
      client.post(`/job-posts/${encodeURIComponent(require(args, 'jobPostId'))}/resolve`, {}),
  },
  {
    name: 'promote_job_post_contact',
    title: 'Put a job-post contact into a campaign',
    description:
      'Add one person found behind a posting to a campaign, with their employer and any address ' +
      'their company published. Nothing is sent: they become a prospect awaiting approval.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        jobPostId: { type: 'string' },
        contactId: { type: 'string' },
        campaignId: { type: 'string', description: "Defaults to the posting's own campaign." },
      },
      required: ['jobPostId', 'contactId'],
    },
    run: (client, args) =>
      client.post(
        `/job-posts/${encodeURIComponent(require(args, 'jobPostId'))}/contacts/${encodeURIComponent(require(args, 'contactId'))}/promote`,
        str(args, 'campaignId') ? { campaignId: str(args, 'campaignId') } : {},
      ),
  },
  {
    name: 'update_job_post',
    title: 'Edit or remove a job posting',
    description:
      "Set a posting's status (contacted, applied, archived, …), its notes, or its campaign; or " +
      'remove it with remove: true.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        jobPostId: { type: 'string' },
        status: { type: 'string' },
        notes: { type: 'string' },
        campaignId: { type: 'string' },
        remove: { type: 'boolean' },
      },
      required: ['jobPostId'],
    },
    run: async (client, args) => {
      const path = `/job-posts/${encodeURIComponent(require(args, 'jobPostId'))}`;
      if (args.remove === true) {
        if (!client.delete) throw new Error('this client cannot delete');
        return client.delete(path);
      }
      if (!client.patch) throw new Error('this client cannot edit');
      return client.patch(path, {
        ...(str(args, 'status') ? { status: str(args, 'status') } : {}),
        ...(typeof args.notes === 'string' ? { notes: args.notes } : {}),
        ...(str(args, 'campaignId') ? { campaignId: str(args, 'campaignId') } : {}),
      });
    },
  },
  {
    name: 'get_openprofile',
    title: "Get a person's OpenProfile.md",
    description:
      'The OpenProfile.md (logicsrc.com/openprofile) assembled for one person: name, handle, Emoji and ' +
      'Pronouns when they stated them (never inferred), home ' +
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
    name: 'list_senders',
    title: 'List sending accounts',
    description:
      'List every mailbox, LinkedIn session and X account this workspace sends from, with ' +
      "each one's status, daily cap, today's cap after warm-up, how many it has sent today " +
      'and its warm-up day. Use it to explain why a send was deferred to tomorrow: when every ' +
      'account on a network is at its cap, approved messages wait rather than fail.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        network: {
          type: 'string',
          enum: ['email', 'linkedin', 'x'],
          description: 'Only the accounts on this network.',
        },
      },
    },
    run: async (client, args) => {
      const result = (await client.get('/senders')) as { senders?: { network?: string }[] };
      const network = str(args, 'network');
      if (!network) return result;
      return { senders: (result.senders ?? []).filter((sender) => sender.network === network) };
    },
  },
  {
    name: 'list_mailboxes',
    title: 'List mailboxes',
    description:
      'List the email addresses this workspace sends cold email from, each with a 0-100 ' +
      'health score and the issues lowering it, bounce risk (low/medium/high over 30 days), ' +
      "today's sends against its cap, warm-up progress, and whether its replies are being " +
      'read over IMAP (and the last error if not). Use it before blaming copy for a lack of ' +
      'replies: a mailbox whose inbox cannot be read never shows one.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
    run: (client) => client.get('/mailboxes'),
  },
  {
    name: 'check_mailbox_dns',
    title: 'Check a mailbox domain',
    description:
      'Check SPF, DKIM, DMARC and MX for the domain one mailbox sends from, with what to add ' +
      'when a record is missing. Cold email from a domain without SPF and DMARC lands in spam.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { mailboxId: { type: 'string', description: 'The id from list_mailboxes.' } },
      required: ['mailboxId'],
    },
    run: (client, args) =>
      client.get(`/mailboxes/${encodeURIComponent(require(args, 'mailboxId'))}/dns`),
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
    name: 'add_leads_to_campaign',
    title: 'Add leads to an existing campaign',
    description:
      'Append up to 5,000 leads to a campaign that is already running, as `leads` (email, ' +
      'first_name, last_name, company_domain, job_title, linkedin_url...) or as the text of a ' +
      'CSV file. People already in the campaign or its project, and anyone on a suppress list, ' +
      'are skipped. Screening flags generated names, relay and temp-mail addresses, bot and test ' +
      'accounts and role inboxes, and holds them back from sending unless allowFlagged. The ' +
      'result is a per-row report: every rejected, skipped and flagged row with the reason. ' +
      'Report those to the user rather than summarising them away.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string' },
        leads: { type: 'array', items: { type: 'object' } },
        csv: { type: 'string', description: 'A CSV with a header row. Send this or leads.' },
        consentSource: { type: 'string', description: 'Where these people came from.' },
        allowFlagged: { type: 'boolean', description: 'Send to screened leads too.' },
      },
      required: ['campaignId'],
    },
    run: (client, args) =>
      client.post(`/autogtm/campaigns/${encodeURIComponent(require(args, 'campaignId'))}/leads`, {
        ...(Array.isArray(args.leads) ? { leads: args.leads } : {}),
        // Untrimmed: the file's own line endings are part of the CSV.
        ...(typeof args.csv === 'string' && args.csv.trim() ? { csv: args.csv } : {}),
        ...(str(args, 'consentSource') ? { consent_source: str(args, 'consentSource') } : {}),
        allow_flagged: args.allowFlagged === true,
      }),
  },
  {
    name: 'get_import_report',
    title: 'Read an import report',
    description:
      'Every row an import rejected, skipped or flagged, with the column or check behind it, ' +
      'for the task_id an import or add_leads_to_campaign returned.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
    run: (client, args) =>
      client.get(`/autogtm/campaigns/import/${encodeURIComponent(require(args, 'taskId'))}/report`),
  },
  {
    name: 'list_screened_leads',
    title: 'List leads held back by screening',
    description:
      'A campaign’s leads that lead screening is holding back from sending, each with its ' +
      'reasons (generated name, relay address, temp-mail domain, bot or test account, role ' +
      'inbox). Nothing is sent to them until a human allows them.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string' },
        includeAllowed: { type: 'boolean' },
      },
      required: ['campaignId'],
    },
    run: (client, args) =>
      client.get(
        `/autogtm/campaigns/${encodeURIComponent(require(args, 'campaignId'))}/screened`,
        args.includeAllowed === true ? { include_allowed: 'true' } : {},
      ),
  },
  {
    name: 'allow_screened_lead',
    title: 'Send to a screened lead anyway',
    description:
      'Clears (allow: true) or restores (allow: false) the screening hold on one lead. Only do ' +
      'this when the user has looked at the reason and decided the person is real.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { personId: { type: 'string' }, allow: { type: 'boolean' } },
      required: ['personId', 'allow'],
    },
    run: (client, args) =>
      client.post(`/autogtm/leads/${encodeURIComponent(require(args, 'personId'))}/screening`, {
        allow: args.allow === true,
      }),
  },
  {
    name: 'enrich_campaign_leads',
    title: 'Fill in leads’ missing name, title and LinkedIn',
    description:
      'Starts a background run over a campaign’s leads: names from unambiguous addresses ' +
      '(first.last@, free), then People Data Labs when configured, then a Google search of ' +
      'LinkedIn taken only when the result carries the full name and the company. Fills blanks ' +
      'only, caches every search, and is capped per run and per day. Returns the status; call ' +
      'get_lead_enrichment later for the outcome.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string' },
        maxSearches: { type: 'number', description: 'New searches this run may spend.' },
      },
      required: ['campaignId'],
    },
    run: async (client, args) => {
      const base = `/autogtm/campaigns/${encodeURIComponent(require(args, 'campaignId'))}`;
      await client.post(
        `${base}/enrich`,
        typeof args.maxSearches === 'number' ? { max_searches: args.maxSearches } : {},
      );
      return client.get(`${base}/enrichment`);
    },
  },
  {
    name: 'get_lead_enrichment',
    title: 'What a campaign’s leads are missing',
    description:
      'How many of a campaign’s leads lack a name, job title or LinkedIn, which enrichment ' +
      'providers are configured, searches spent today against the cap, and the last run.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { campaignId: { type: 'string' } },
      required: ['campaignId'],
    },
    run: (client, args) =>
      client.get(
        `/autogtm/campaigns/${encodeURIComponent(require(args, 'campaignId'))}/enrichment`,
      ),
  },
  {
    name: 'get_campaign_accounts',
    title: 'Account expansion per company',
    description:
      'Each company in a campaign with its contacts classified as budget holder, pain feeler, ' +
      'blocker or champion; who was contacted, who replied, who is next in line (one contact per ' +
      'company at a time, 21 days apart), and which personas nobody covers yet.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { campaignId: { type: 'string' } },
      required: ['campaignId'],
    },
    run: (client, args) =>
      client.get(`/autogtm/campaigns/${encodeURIComponent(require(args, 'campaignId'))}/accounts`),
  },
  {
    name: 'get_list_health',
    title: 'A campaign’s bounce rate and address verdicts',
    description:
      'Bounces against the 2% stop line, whether the campaign is paused re-verifying its queue ' +
      '(it resumes by itself), and how many sent-to addresses are valid, accept-all, MX-only, ' +
      'invalid or unchecked.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { campaignId: { type: 'string' } },
      required: ['campaignId'],
    },
    run: (client, args) =>
      client.get(
        `/autogtm/campaigns/${encodeURIComponent(require(args, 'campaignId'))}/list-health`,
      ),
  },
  {
    name: 'list_inbox',
    title: 'List conversations',
    description:
      'Every conversation in the workspace, newest first, across campaigns and networks. Each ' +
      'says whether it is waiting on us (need_reply), what the latest reply was labelled ' +
      '(interested, question, referral, not_interested, out_of_office, unsubscribe_request, ' +
      'bounce, other) and whether a drafted answer is waiting. Out-of-office notices and bounces ' +
      'never count as a reply.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['need_reply', 'replied', 'sent', 'all'],
          description: 'Default all.',
        },
        label: {
          type: 'string',
          description: 'Only conversations whose latest reply has this label.',
        },
        limit: { type: 'number' },
      },
    },
    run: (client, args) =>
      client.get('/inbox', {
        filter: str(args, 'filter') ?? 'all',
        ...(str(args, 'label') ? { label: str(args, 'label') } : {}),
        limit: String(typeof args.limit === 'number' ? Math.min(args.limit, 200) : 50),
      }),
  },
  {
    name: 'get_thread',
    title: 'Read one conversation',
    description:
      'One conversation, oldest message first: what we sent (the original outbound is marked), ' +
      'what they wrote with its label and how sure the classifier was, and the drafted answer ' +
      'waiting for approval, if any. Quote their words from here, not from memory.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: { personId: { type: 'string' } },
      required: ['personId'],
    },
    run: (client, args) => client.get(`/inbox/${require(args, 'personId')}`),
  },
  {
    name: 'reply_to_thread',
    title: 'Reply to a conversation',
    description:
      'Send a reply by email to someone who wrote to us. It answers their latest message in the ' +
      'same thread, and goes through the same policy re-check and approval record as a card ' +
      'approved by a human — so a suppressed person, an exhausted budget or a daily limit ' +
      'refuses it here too. Write only what the thread and the offering support.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        personId: { type: 'string' },
        text: { type: 'string', description: 'The message body.' },
        subject: { type: 'string', description: 'Defaults to theirs with "Re:".' },
      },
      required: ['personId', 'text'],
    },
    run: (client, args) =>
      client.post(`/inbox/${require(args, 'personId')}/reply`, {
        text: require(args, 'text'),
        ...(str(args, 'subject') ? { subject: str(args, 'subject') } : {}),
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
