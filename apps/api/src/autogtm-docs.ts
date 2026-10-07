/**
 * The AutoGTM API, described once.
 *
 * `openapi.json` and `llms.txt` are both rendered from `OPERATIONS` below, so
 * an endpoint added to one cannot be missing from the other. The OpenAPI
 * document is what a typed client reads; `llms.txt` is what an agent reads
 * first — the quick guide, in the order a session actually uses the API.
 */

interface Param {
  readonly name: string;
  readonly in: 'path' | 'query';
  readonly description: string;
  readonly required?: boolean;
  readonly schema?: Record<string, unknown>;
}

interface Operation {
  readonly method: 'get' | 'post' | 'patch' | 'delete';
  readonly path: string;
  readonly id: string;
  readonly summary: string;
  readonly description?: string;
  readonly tag: string;
  readonly params?: readonly Param[];
  readonly body?: Record<string, unknown>;
  readonly response?: Record<string, unknown>;
  readonly status?: number;
}

const usd = { type: 'number', minimum: 0 };
const stringArray = { type: 'array', items: { type: 'string' } };

const targeting = {
  type: 'object',
  properties: {
    titles: stringArray,
    seniorities: stringArray,
    industries: stringArray,
    countries: stringArray,
    keywords: stringArray,
    technologies: stringArray,
    exclusions: stringArray,
    employee_count_min: { type: ['integer', 'null'] },
    employee_count_max: { type: ['integer', 'null'] },
  },
};

const analytics = {
  type: 'object',
  properties: {
    leads_pool: { type: 'integer', description: 'People in the campaign.' },
    contacted: { type: 'integer', description: 'Distinct people written to.' },
    emails_sent: { type: 'integer' },
    replies: { type: 'integer' },
    reply_rate: { type: 'number', description: 'replies / emails_sent, as a fraction.' },
    need_reply: { type: 'integer', description: 'Threads where the lead spoke last.' },
    hot_leads: { type: 'integer', description: 'Leads who replied or became an opportunity.' },
    awaiting_approval: { type: 'integer' },
    spend_usd: { type: 'number', description: 'contacted × price_per_contact_usd.' },
    cost_per_lead_usd: { type: ['number', 'null'], description: 'spend_usd / hot_leads.' },
    price_per_contact_usd: { type: 'number' },
    last_activity_at: { type: ['string', 'null'], format: 'date-time' },
  },
};

const campaign = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    project_id: { type: 'string' },
    name: { type: 'string' },
    status: {
      type: 'string',
      enum: ['discovery', 'review', 'outreach', 'listening', 'archived'],
      description:
        'discovery: finding leads; review: sends wait for a human; outreach: sending unattended; ' +
        'listening: paused, replies still land; archived: finished.',
    },
    raw_status: { type: 'string' },
    autopilot: { type: 'boolean' },
    project_autopilot: { type: 'boolean' },
    daily_limit_usd: { type: ['number', 'null'] },
    max_contacts_per_day: { type: ['integer', 'null'] },
    source: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
    ...analytics.properties,
  },
};

const project = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    domain: { type: ['string', 'null'] },
    daily_budget_usd: { type: ['number', 'null'] },
    autopilot: { type: 'boolean' },
    campaigns: { type: 'integer' },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const conversation = {
  type: 'object',
  properties: {
    person_id: { type: 'string' },
    name: { type: 'string' },
    job_title: { type: ['string', 'null'] },
    company: { type: ['string', 'null'] },
    company_domain: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['need_reply', 'replied', 'sent', 'unsubscribed'] },
    lead_status: { type: 'string' },
    messages: {
      type: 'object',
      properties: { inbound: { type: 'integer' }, outbound: { type: 'integer' } },
    },
    last_message_at: { type: 'string', format: 'date-time' },
    last_message_from: { type: 'string', enum: ['lead', 'you'] },
    last_message_preview: { type: ['string', 'null'] },
    note: { type: ['string', 'null'] },
  },
};

const message = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    from: { type: 'string', enum: ['lead', 'you'] },
    network: { type: 'string' },
    subject: { type: ['string', 'null'] },
    body: { type: ['string', 'null'] },
    address: { type: ['string', 'null'] },
    at: { type: 'string', format: 'date-time' },
  },
};

const idParam = (name: string, what: string): Param => ({
  name,
  in: 'path',
  required: true,
  description: what,
  schema: { type: 'string' },
});

const sinceParam: Param = {
  name: 'since',
  in: 'query',
  description: 'ISO instant. Only activity at or after this counts.',
  schema: { type: 'string', format: 'date-time' },
};

export const OPERATIONS: readonly Operation[] = [
  // ------------------------------------------------------------ projects
  {
    method: 'get',
    path: '/autogtm/projects',
    id: 'listProjects',
    tag: 'Projects',
    summary: 'List projects',
    description: 'A project is one product you sell. Every campaign belongs to exactly one.',
    response: { type: 'object', properties: { projects: { type: 'array', items: project } } },
  },
  {
    method: 'get',
    path: '/autogtm/projects/{project_id}',
    id: 'getProject',
    tag: 'Projects',
    summary: 'Read one project',
    params: [idParam('project_id', 'The project.')],
    response: { type: 'object', properties: { project } },
  },
  {
    method: 'get',
    path: '/autogtm/projects/{project_id}/budget',
    id: 'getProjectBudget',
    tag: 'Budgets',
    summary: 'Read a project’s daily ceiling and how it is split across campaigns',
    params: [idParam('project_id', 'The project.')],
    response: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        daily_budget_usd: { type: ['number', 'null'] },
        autopilot: { type: 'boolean' },
        allocated_usd: { type: 'number' },
        allocation: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              campaign_id: { type: 'string' },
              name: { type: 'string' },
              status: { type: 'string' },
              daily_limit_usd: { type: ['number', 'null'] },
            },
          },
        },
      },
    },
  },
  {
    method: 'patch',
    path: '/autogtm/projects/{project_id}/budget',
    id: 'setProjectBudget',
    tag: 'Budgets',
    summary: 'Set a project’s daily ceiling in dollars',
    description:
      'Works whether or not autopilot is on. With autopilot on the ceiling is split across the ' +
      'project’s active campaigns by reply rate; with it off, hand-set campaign limits are scaled ' +
      'down only when together they would exceed it. `null` removes the ceiling.',
    params: [idParam('project_id', 'The project.')],
    body: {
      type: 'object',
      required: ['daily_budget_usd'],
      properties: { daily_budget_usd: { ...usd, nullable: true } },
    },
    response: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        daily_budget_usd: { type: ['number', 'null'] },
        campaigns_reallocated: { type: 'integer' },
      },
    },
  },
  {
    method: 'patch',
    path: '/autogtm/projects/{project_id}/autopilot',
    id: 'setProjectAutopilot',
    tag: 'Projects',
    summary: 'Turn autopilot on or off for a project',
    description:
      'On: every campaign in the project sends unattended within its allocated budget, and ' +
      'per-campaign start/stop and budget calls answer 409 until it is off again. Off: sends ' +
      'wait in the approval queue for a human.',
    params: [idParam('project_id', 'The project.')],
    body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
    response: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        autopilot: { type: 'boolean' },
        campaigns: { type: 'integer' },
        campaigns_reallocated: { type: 'integer' },
      },
    },
  },
  {
    method: 'get',
    path: '/autogtm/projects/{project_id}/analytics',
    id: 'getProjectAnalytics',
    tag: 'Analytics',
    summary: 'Totals for a project, with a row per campaign',
    params: [idParam('project_id', 'The project.'), sinceParam],
    response: {
      type: 'object',
      properties: {
        project,
        totals: analytics,
        campaigns: { type: 'array', items: campaign },
      },
    },
  },

  // ----------------------------------------------------------- campaigns
  {
    method: 'get',
    path: '/autogtm/campaigns',
    id: 'listCampaigns',
    tag: 'Campaigns',
    summary: 'List campaigns with their headline numbers',
    params: [
      {
        name: 'project_id',
        in: 'query',
        description: 'Only this project’s campaigns.',
        schema: { type: 'string' },
      },
      {
        name: 'include_archived',
        in: 'query',
        description: '`true` to include archived campaigns.',
        schema: { type: 'boolean' },
      },
    ],
    response: { type: 'object', properties: { campaigns: { type: 'array', items: campaign } } },
  },
  {
    method: 'get',
    path: '/autogtm/campaigns/{campaign_id}',
    id: 'getCampaign',
    tag: 'Campaigns',
    summary: 'Read a campaign’s definition: targeting, instructions, budget, numbers',
    params: [idParam('campaign_id', 'The campaign.')],
    response: {
      type: 'object',
      properties: {
        campaign: {
          type: 'object',
          properties: {
            ...campaign.properties,
            instructions: { type: ['string', 'null'] },
            targeting,
            targeting_editable: { type: 'boolean' },
          },
        },
      },
    },
  },
  {
    method: 'patch',
    path: '/autogtm/campaigns/{campaign_id}',
    id: 'updateCampaign',
    tag: 'Campaigns',
    summary: 'Change a campaign’s name, instructions, targeting or daily limit',
    description:
      'Targeting changes affect who is researched and scored from now on; instructions affect ' +
      'future drafts only. `daily_limit_usd` is refused with 409 while the project is on autopilot.',
    params: [idParam('campaign_id', 'The campaign.')],
    body: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        instructions: { type: 'string', description: 'What to say and how. Grounds every draft.' },
        targeting,
        daily_limit_usd: { ...usd, nullable: true },
      },
    },
  },
  {
    method: 'post',
    path: '/autogtm/campaigns/{campaign_id}/start',
    id: 'startCampaign',
    tag: 'Campaigns',
    summary: 'Resume a paused campaign',
    description: 'Refused with 409 `autopilot_on` while the project is on autopilot.',
    params: [idParam('campaign_id', 'The campaign.')],
    response: {
      type: 'object',
      properties: { campaign_id: { type: 'string' }, status: { type: 'string' } },
    },
  },
  {
    method: 'post',
    path: '/autogtm/campaigns/{campaign_id}/stop',
    id: 'stopCampaign',
    tag: 'Campaigns',
    summary: 'Pause a campaign; replies still land',
    description: 'Refused with 409 `autopilot_on` while the project is on autopilot.',
    params: [idParam('campaign_id', 'The campaign.')],
    response: {
      type: 'object',
      properties: { campaign_id: { type: 'string' }, status: { type: 'string' } },
    },
  },
  {
    method: 'get',
    path: '/autogtm/campaigns/{campaign_id}/budget',
    id: 'getCampaignBudget',
    tag: 'Budgets',
    summary: 'Read a campaign’s daily limit and the contact cap it becomes',
    params: [idParam('campaign_id', 'The campaign.')],
    response: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        daily_limit_usd: { type: ['number', 'null'] },
        max_contacts_per_day: { type: ['integer', 'null'] },
        price_per_contact_usd: { type: 'number' },
        managed_by_autopilot: { type: 'boolean' },
      },
    },
  },
  {
    method: 'patch',
    path: '/autogtm/campaigns/{campaign_id}/budget',
    id: 'setCampaignBudget',
    tag: 'Budgets',
    summary: 'Set a campaign’s daily limit in dollars',
    description:
      'Stored as `max_contacts_per_day = floor(daily_limit_usd / price_per_contact_usd)`, which ' +
      'the policy engine enforces on every send. Refused with 409 while the project is on autopilot. ' +
      'Still capped by the project’s ceiling when one is set.',
    params: [idParam('campaign_id', 'The campaign.')],
    body: {
      type: 'object',
      required: ['daily_limit_usd'],
      properties: { daily_limit_usd: { ...usd, nullable: true } },
    },
  },
  {
    method: 'get',
    path: '/autogtm/campaigns/{campaign_id}/analytics',
    id: 'getCampaignAnalytics',
    tag: 'Analytics',
    summary: 'A campaign’s numbers, optionally since an instant',
    params: [idParam('campaign_id', 'The campaign.'), sinceParam],
    response: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        status: { type: 'string' },
        ...analytics.properties,
      },
    },
  },
  {
    method: 'post',
    path: '/autogtm/campaigns/import',
    id: 'importCampaign',
    tag: 'Campaigns',
    summary: 'Create a campaign from your own list of leads',
    description:
      'Up to 5,000 leads per request. Each becomes a person with a consented address, joins the ' +
      'campaign, and has their company site queued for research under it — a lead is written to ' +
      'only once something is known about them, because every message is grounded in evidence. ' +
      'The response is immediate; the `task_id` can be polled but is already complete.',
    body: {
      type: 'object',
      required: ['name', 'leads'],
      properties: {
        name: { type: 'string' },
        project_id: { type: 'string', description: 'Defaults to your first project.' },
        instructions: { type: 'string' },
        autopilot: { type: 'boolean', description: 'Send unattended once leads are ready.' },
        consent_basis: { type: 'string', description: 'How these people agreed to hear from you.' },
        consent_source: { type: 'string' },
        leads: {
          type: 'array',
          minItems: 1,
          maxItems: 5000,
          items: {
            type: 'object',
            required: ['email'],
            properties: {
              email: { type: 'string', format: 'email' },
              first_name: { type: 'string' },
              last_name: { type: 'string' },
              company_domain: { type: 'string' },
              company: { type: 'string' },
              job_title: { type: 'string' },
              location: { type: 'string' },
              linkedin_url: { type: 'string' },
            },
          },
        },
      },
    },
    status: 201,
    response: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        campaign_id: { type: 'string' },
        project_id: { type: 'string' },
        status: { type: 'string' },
        imported: { type: 'integer' },
        merged: {
          type: 'integer',
          description: 'Already on file; updated rather than duplicated.',
        },
        updated: {
          type: 'integer',
          description:
            'Of the merged, how many people this import changed. Newer data wins: a value in the import replaces a different stored one, unless the row is dated older.',
        },
        rejected: { type: 'integer' },
        skipped: { type: 'integer' },
        flagged: { type: 'integer' },
        crawls_queued: { type: 'integer' },
        report: { type: 'array', description: 'The import report, first 500 rows.' },
        report_url: { type: 'string' },
      },
    },
  },
  {
    method: 'post',
    path: '/autogtm/campaigns/{campaign_id}/leads',
    id: 'appendLeads',
    tag: 'Campaigns',
    summary: 'Add leads to an existing campaign',
    description:
      'Up to 5,000 leads per request, as `leads` (the same fields as an import, plus `name` and ' +
      '`updated_at`) or as `csv` (the file itself; headers like Email, First Name, Company Domain ' +
      'and Job Title are recognised). Skips people already in this campaign, already in another ' +
      'campaign of the project (`skip_project_duplicates`, default true) and anyone on a suppress ' +
      'list. Screening flags generated names, relay and temp-mail addresses, agent and test ' +
      'accounts and role inboxes, and holds them back from sending until you allow them ' +
      '(`allow_flagged: true` sends to them anyway). No row is dropped silently: the response ' +
      'carries a per-row report with the column or check behind every reject, skip and flag.',
    params: [idParam('campaign_id', 'The campaign to add to.')],
    body: {
      type: 'object',
      properties: {
        leads: {
          type: 'array',
          maxItems: 5000,
          items: {
            type: 'object',
            properties: {
              email: { type: 'string' },
              name: { type: 'string' },
              first_name: { type: 'string' },
              last_name: { type: 'string' },
              company_domain: { type: 'string' },
              company: { type: 'string' },
              job_title: { type: 'string' },
              location: { type: 'string' },
              linkedin_url: { type: 'string' },
              updated_at: { type: 'string' },
            },
          },
        },
        csv: { type: 'string', description: 'A CSV file with a header row. Send this or leads.' },
        filename: { type: 'string' },
        consent_basis: { type: 'string' },
        consent_source: { type: 'string' },
        allow_flagged: { type: 'boolean', description: 'Send to screened leads too.' },
        skip_project_duplicates: { type: 'boolean' },
      },
    },
    status: 201,
    response: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        campaign_id: { type: 'string' },
        received: { type: 'integer' },
        added: { type: 'integer', description: 'New members of the campaign.' },
        imported: { type: 'integer', description: 'People new to the workspace.' },
        merged: { type: 'integer' },
        updated: { type: 'integer' },
        rejected: { type: 'integer', description: 'Unusable rows.' },
        skipped: {
          type: 'integer',
          description: 'Already in the campaign/project, or suppressed.',
        },
        flagged: { type: 'integer', description: 'Imported, held back by screening.' },
        report: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              row: { type: 'integer' },
              email: { type: ['string', 'null'] },
              outcome: { type: 'string', enum: ['rejected', 'skipped', 'flagged'] },
              reason: { type: 'string' },
              why: { type: 'string' },
              detail: { type: ['string', 'null'] },
            },
          },
        },
        report_url: { type: 'string', description: 'The whole report as CSV.' },
      },
    },
  },
  {
    method: 'get',
    path: '/autogtm/campaigns/import/{task_id}/report',
    id: 'getImportReport',
    tag: 'Campaigns',
    summary: 'Every row an import rejected, skipped or flagged, and why',
    description: 'JSON by default; `?format=csv` downloads it as a file.',
    params: [
      idParam('task_id', 'The task_id an import returned.'),
      {
        name: 'format',
        in: 'query',
        description: 'csv for a download.',
        schema: { type: 'string' },
      },
    ],
  },
  {
    method: 'get',
    path: '/autogtm/campaigns/{campaign_id}/screened',
    id: 'listScreened',
    tag: 'Campaigns',
    summary: 'Leads screening is holding back from sending, with the reasons',
    params: [
      idParam('campaign_id', 'The campaign.'),
      {
        name: 'include_allowed',
        in: 'query',
        description: 'true to list the ones you already allowed too.',
        schema: { type: 'string' },
      },
    ],
  },
  {
    method: 'post',
    path: '/autogtm/leads/{person_id}/screening',
    id: 'overrideScreening',
    tag: 'Campaigns',
    summary: 'Send to a screened lead anyway, or hold them back again',
    params: [idParam('person_id', 'The lead.')],
    body: {
      type: 'object',
      required: ['allow'],
      properties: { allow: { type: 'boolean' } },
    },
  },
  {
    method: 'post',
    path: '/autogtm/campaigns/{campaign_id}/enrich',
    id: 'enrichLeads',
    tag: 'Campaigns',
    summary: 'Fill in leads’ missing name, job title and LinkedIn',
    description:
      'Starts a run and answers 202 at once. Names come from unambiguous addresses ' +
      '(first.last@), free. Job title and LinkedIn profile come from a Google search of LinkedIn, ' +
      'taken only when the result carries every part of the name and the company; the company’s ' +
      'LinkedIn page is the fallback. People Data Labs is used first when configured. Only blanks ' +
      'are filled, every search is cached so a rerun costs nothing, and searches are capped per ' +
      'run (`max_searches`) and per day. Read the outcome from GET .../enrichment.',
    params: [idParam('campaign_id', 'The campaign.')],
    body: {
      type: 'object',
      properties: {
        max_searches: { type: 'integer', minimum: 0, maximum: 1000 },
        max_leads: { type: 'integer', minimum: 1, maximum: 5000 },
      },
    },
    status: 202,
  },
  {
    method: 'get',
    path: '/autogtm/campaigns/{campaign_id}/enrichment',
    id: 'getEnrichment',
    tag: 'Campaigns',
    summary: 'What a campaign’s leads are missing, and the last enrichment run',
    params: [idParam('campaign_id', 'The campaign.')],
    response: {
      type: 'object',
      properties: {
        leads: { type: 'integer' },
        missing_name: { type: 'integer' },
        missing_title: { type: 'integer' },
        missing_linkedin: { type: 'integer' },
        looked_up: { type: 'integer' },
        providers: { type: 'object' },
        today: { type: 'object' },
        running: { type: 'boolean' },
        last_run: { type: 'object' },
      },
    },
  },
  {
    method: 'get',
    path: '/autogtm/campaigns/{campaign_id}/accounts',
    id: 'getAccounts',
    tag: 'Campaigns',
    summary: 'Account expansion: who at each company was reached, who is next',
    description:
      'Contacts are classified from their job title as budget holder, pain feeler (end user), ' +
      'blocker (legal, security, IT, finance) or champion (manager). One contact per company is ' +
      'written to at a time: a colleague emailed in the last 21 days, or on an active cadence, ' +
      'holds the company until they answer or the window closes. Queued colleagues go in persona ' +
      'order, each drafted with an angle for their role. `missing` lists personas nobody covers yet.',
    params: [idParam('campaign_id', 'The campaign.')],
    response: {
      type: 'object',
      properties: {
        gap_days: { type: 'integer' },
        accounts: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  {
    method: 'get',
    path: '/autogtm/campaigns/{campaign_id}/list-health',
    id: 'getListHealth',
    tag: 'Campaigns',
    summary: 'Bounce rate, the 2% pause, and address verdicts',
    description:
      'Every address is verified before its first message and again after 90 days (MX, then an ' +
      'SMTP RCPT probe where the host allows port 25). A campaign whose bounce rate passes 2% over ' +
      '50+ sends pauses itself, re-verifies every queued address, drops the ones that fail and ' +
      'resumes on a fresh window. Accept-all addresses only send while the campaign bounces at or ' +
      'under 1%. A bounced address is never sent to again.',
    params: [idParam('campaign_id', 'The campaign.')],
    response: {
      type: 'object',
      properties: {
        sends: { type: 'integer' },
        bounces: { type: 'integer' },
        bounce_rate: { type: 'number' },
        max_bounce_rate: { type: 'number' },
        window_start: { type: ['string', 'null'] },
        paused: { type: 'boolean' },
        paused_at: { type: ['string', 'null'] },
        addresses: { type: 'object' },
      },
    },
  },
  {
    method: 'get',
    path: '/autogtm/campaigns/import/{task_id}',
    id: 'getImport',
    tag: 'Campaigns',
    summary: 'Read an import’s outcome',
    params: [idParam('task_id', 'The task_id an import returned.')],
    response: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        campaign_id: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['pending', 'completed', 'failed'] },
        total_rows: { type: 'integer' },
        imported: { type: 'integer' },
        merged: { type: 'integer' },
        updated: { type: 'integer' },
        rejected: { type: 'integer' },
        skipped: { type: 'integer' },
        flagged: { type: 'integer' },
        report_url: { type: 'string' },
      },
    },
  },

  // --------------------------------------------------------------- inbox
  {
    method: 'get',
    path: '/autogtm/campaigns/{campaign_id}/inbox',
    id: 'listInbox',
    tag: 'Inbox',
    summary: 'Conversations in a campaign, newest first',
    params: [
      idParam('campaign_id', 'The campaign.'),
      {
        name: 'tab',
        in: 'query',
        description: 'need_reply (lead spoke last), replied, sent, unsubscribed, or all.',
        schema: { type: 'string', enum: ['all', 'need_reply', 'replied', 'sent', 'unsubscribed'] },
      },
      {
        name: 'limit',
        in: 'query',
        description: '1–200, default 50.',
        schema: { type: 'integer' },
      },
      {
        name: 'before',
        in: 'query',
        description: 'Page cursor: the `next_before` of the previous page.',
        schema: { type: 'string', format: 'date-time' },
      },
    ],
    response: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        tab: { type: 'string' },
        conversations: { type: 'array', items: conversation },
        next_before: { type: 'string', format: 'date-time' },
      },
    },
  },
  {
    method: 'get',
    path: '/autogtm/campaigns/{campaign_id}/inbox/{person_id}',
    id: 'getThread',
    tag: 'Inbox',
    summary: 'The full thread with one lead',
    params: [idParam('campaign_id', 'The campaign.'), idParam('person_id', 'The lead.')],
    response: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        lead: conversation,
        messages: { type: 'array', items: message },
      },
    },
  },
  {
    method: 'post',
    path: '/autogtm/campaigns/{campaign_id}/inbox/{person_id}/reply',
    id: 'replyToLead',
    tag: 'Inbox',
    summary: 'Reply to a lead',
    description:
      'Text only; the subject and threading are handled. The reply passes the policy engine as a ' +
      'human-approved follow-up: suppression, budget and the daily cap still apply, and a lead who ' +
      'opted out cannot be written to (409 `policy_denied`). 502 means policy allowed it and the ' +
      'mailbox refused it.',
    params: [idParam('campaign_id', 'The campaign.'), idParam('person_id', 'The lead.')],
    body: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    response: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        campaign_id: { type: 'string' },
        person_id: { type: 'string' },
        action_id: { type: 'string' },
        subject: { type: 'string' },
        to: { type: 'string' },
      },
    },
  },
  {
    method: 'get',
    path: '/autogtm/campaigns/{campaign_id}/inbox/{person_id}/note',
    id: 'getLeadNote',
    tag: 'Inbox',
    summary: 'Read your note on a lead',
    params: [idParam('campaign_id', 'The campaign.'), idParam('person_id', 'The lead.')],
    response: { type: 'object', properties: { note: { type: ['string', 'null'] } } },
  },
  {
    method: 'post',
    path: '/autogtm/campaigns/{campaign_id}/inbox/{person_id}/note',
    id: 'setLeadNote',
    tag: 'Inbox',
    summary: 'Write or clear your note on a lead',
    params: [idParam('campaign_id', 'The campaign.'), idParam('person_id', 'The lead.')],
    body: {
      type: 'object',
      required: ['note'],
      properties: { note: { type: ['string', 'null'] } },
    },
    response: { type: 'object', properties: { note: { type: ['string', 'null'] } } },
  },
  {
    method: 'get',
    path: '/autogtm/hot-leads',
    id: 'listHotLeads',
    tag: 'Inbox',
    summary: 'Every lead who has replied, across all campaigns, newest reply first',
    description: 'Poll with `since` set to the previous call’s `polled_at` to see only new ones.',
    params: [
      sinceParam,
      { name: 'limit', in: 'query', description: '1–200.', schema: { type: 'integer' } },
    ],
    response: {
      type: 'object',
      properties: {
        hot_leads: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              person_id: { type: 'string' },
              campaign_id: { type: 'string' },
              campaign_name: { type: 'string' },
              name: { type: 'string' },
              job_title: { type: ['string', 'null'] },
              company: { type: ['string', 'null'] },
              company_domain: { type: ['string', 'null'] },
              lead_status: { type: 'string' },
              replied_at: { type: ['string', 'null'], format: 'date-time' },
              last_reply_preview: { type: ['string', 'null'] },
              note: { type: ['string', 'null'] },
            },
          },
        },
        polled_at: { type: 'string', format: 'date-time' },
      },
    },
  },

  // ------------------------------------------------------ suppress lists
  {
    method: 'get',
    path: '/autogtm/suppress-list/people',
    id: 'listPeopleSuppressLists',
    tag: 'Suppress lists',
    summary: 'Named lists of addresses never to write to',
  },
  {
    method: 'post',
    path: '/autogtm/suppress-list/people',
    id: 'suppressPeople',
    tag: 'Suppress lists',
    summary: 'Add email addresses to a named list',
    description:
      'Matching is exact on the lowercased address. Anyone already on file who matches has their ' +
      'queued messages cancelled immediately; anyone found later under that address is never ' +
      'contacted. Suppression survives deletion of the person.',
    body: {
      type: 'object',
      required: ['list_name', 'emails'],
      properties: {
        list_name: { type: 'string' },
        emails: { type: 'array', items: { type: 'string', format: 'email' } },
        reason: {
          type: 'string',
          enum: ['do_not_contact', 'customer_request', 'complaint', 'admin'],
        },
      },
    },
    status: 201,
  },
  {
    method: 'get',
    path: '/autogtm/suppress-list/people/{list_name}',
    id: 'getPeopleSuppressList',
    tag: 'Suppress lists',
    summary: 'Read one list’s addresses',
    params: [idParam('list_name', 'The list.')],
  },
  {
    method: 'delete',
    path: '/autogtm/suppress-list/people/{list_name}',
    id: 'deletePeopleSuppressList',
    tag: 'Suppress lists',
    summary: 'Delete a list and stop suppressing its addresses',
    params: [idParam('list_name', 'The list.')],
  },
  {
    method: 'get',
    path: '/autogtm/suppress-list/companies',
    id: 'listCompanySuppressLists',
    tag: 'Suppress lists',
    summary: 'Named lists of company domains never to write to',
  },
  {
    method: 'post',
    path: '/autogtm/suppress-list/companies',
    id: 'suppressCompanies',
    tag: 'Suppress lists',
    summary: 'Add company domains to a named list',
    description: 'Matching is exact on the normalised host (`www.` and paths stripped).',
    body: {
      type: 'object',
      required: ['list_name', 'domains'],
      properties: {
        list_name: { type: 'string' },
        domains: { type: 'array', items: { type: 'string' } },
        reason: {
          type: 'string',
          enum: ['do_not_contact', 'customer_request', 'complaint', 'admin'],
        },
      },
    },
    status: 201,
  },
  {
    method: 'get',
    path: '/autogtm/suppress-list/companies/{list_name}',
    id: 'getCompanySuppressList',
    tag: 'Suppress lists',
    summary: 'Read one list’s domains',
    params: [idParam('list_name', 'The list.')],
  },
  {
    method: 'delete',
    path: '/autogtm/suppress-list/companies/{list_name}',
    id: 'deleteCompanySuppressList',
    tag: 'Suppress lists',
    summary: 'Delete a list and stop suppressing its domains',
    params: [idParam('list_name', 'The list.')],
  },

  // ------------------------------------------------------------- billing
  {
    method: 'get',
    path: '/autogtm/billing/balance',
    id: 'getBalance',
    tag: 'Billing',
    summary: 'Plan allowance, credits and whether sending is exhausted',
  },

  // ------------------------------------------------------------ api keys
  {
    method: 'get',
    path: '/api-keys',
    id: 'listApiKeys',
    tag: 'API keys',
    summary: 'List this workspace’s keys (prefixes only)',
  },
  {
    method: 'post',
    path: '/api-keys',
    id: 'createApiKey',
    tag: 'API keys',
    summary: 'Mint a key; the secret is returned once',
    description: 'Session only — a key cannot mint keys.',
    body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    status: 201,
  },
  {
    method: 'delete',
    path: '/api-keys/{key_id}',
    id: 'revokeApiKey',
    tag: 'API keys',
    summary: 'Revoke a key',
    params: [idParam('key_id', 'The key.')],
  },
];

const ERROR = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
      },
    },
  },
};

export function openApiDocument(baseUrl: string, version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const op of OPERATIONS) {
    const entry: Record<string, unknown> = {
      operationId: op.id,
      summary: op.summary,
      tags: [op.tag],
      ...(op.description ? { description: op.description } : {}),
      ...(op.params ? { parameters: op.params } : {}),
      ...(op.body
        ? { requestBody: { required: true, content: { 'application/json': { schema: op.body } } } }
        : {}),
      responses: {
        [String(op.status ?? 200)]: {
          description: 'OK',
          ...(op.response ? { content: { 'application/json': { schema: op.response } } } : {}),
        },
        '400': { description: 'Bad request', content: { 'application/json': { schema: ERROR } } },
        '401': { description: 'Missing or invalid API key' },
        '404': { description: 'Not found', content: { 'application/json': { schema: ERROR } } },
        '409': {
          description: 'Refused: `autopilot_on` or `policy_denied`',
          content: { 'application/json': { schema: ERROR } },
        },
      },
      security: [{ apiKey: [] }],
    };
    paths[op.path] = { ...(paths[op.path] ?? {}), [op.method]: entry };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'OutreachGraph AutoGTM API',
      version,
      description:
        'Run B2B email outreach end to end — projects, campaigns, budgets in dollars, an inbox, ' +
        'hot leads and suppress lists — through one key. Every send passes a deterministic policy ' +
        'engine; nothing here can bypass suppression, budgets or human approval where it applies.',
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description:
            'Mint one at /settings or POST /api/v1/api-keys with a session. ' +
            '`Authorization: Bearer <key>` is accepted too.',
        },
      },
    },
    security: [{ apiKey: [] }],
    paths,
  };
}

export function llmsText(baseUrl: string): string {
  const lines: string[] = [];
  const api = `${baseUrl}/api/v1`;

  lines.push('# OutreachGraph AutoGTM API');
  lines.push('');
  lines.push(
    '> Run B2B email outreach through one API key: find and research leads, send within a ' +
      'daily dollar budget, read and answer replies. Every send passes a deterministic policy ' +
      'engine that enforces suppression, budgets and human approval — an agent cannot talk its ' +
      'way past any of them.',
  );
  lines.push('');
  lines.push('## Setup');
  lines.push('');
  lines.push(`- Base URL: \`${api}\``);
  lines.push(
    '- Header on every request: `X-API-Key: og_live_…` (or `Authorization: Bearer og_live_…`).',
  );
  lines.push(`- Full schema: \`${api}/public/openapi.json\``);
  lines.push(
    '- Keys are minted at `/settings` in the app, or `POST /api-keys` with a signed-in session.',
  );
  lines.push(
    '- Errors are `{ "error": { "code", "message", "details?" } }`. 401 bad key, 404 not yours, 409 refused (`autopilot_on`, `policy_denied`).',
  );
  lines.push('');
  lines.push('## Concepts');
  lines.push('');
  lines.push(
    '- **Project** — one product you sell. Has a daily ceiling in dollars and an autopilot switch.',
  );
  lines.push(
    '- **Campaign** — one audience for one project. Has its own daily limit, a lead pool, targeting, instructions and an inbox.',
  );
  lines.push(
    '- **Statuses** — `discovery` (finding leads), `review` (sends wait for a human), `outreach` (sending unattended), `listening` (paused, replies still land), `archived`.',
  );
  lines.push(
    '- **Budget** — dollars per day become `max_contacts_per_day = floor(usd / price_per_contact_usd)`, which the policy engine enforces. Spend is `contacted × price_per_contact_usd`.',
  );
  lines.push(
    '- **Autopilot** — on a project, it flips every campaign to unattended sending and splits the ceiling across them by reply rate (an exploration slice keeps new campaigns alive). While on, per-campaign start/stop and budget calls answer 409; turn it off first.',
  );
  lines.push(
    '- **Grounding** — a lead is written to only once research has found something to say. Imported leads enter `discovery` and their company sites are read first.',
  );
  lines.push('');
  lines.push('## A session, in order');
  lines.push('');
  lines.push(
    '1. `GET /autogtm/projects`, then `GET /autogtm/campaigns` — what exists and how each is doing (`reply_rate`, `hot_leads`, `spend_usd`).',
  );
  lines.push(
    '2. `GET /autogtm/hot-leads` — who has replied. Poll with `since=<previous polled_at>`.',
  );
  lines.push(
    '3. `GET /autogtm/campaigns/{id}/inbox?tab=need_reply` — threads where the lead spoke last; `GET …/inbox/{person_id}` for the thread; `POST …/inbox/{person_id}/reply` with `{ "text" }` to answer.',
  );
  lines.push(
    '4. `PATCH /autogtm/projects/{id}/budget` `{ "daily_budget_usd" }` and `PATCH /autogtm/projects/{id}/autopilot` `{ "enabled" }` to steer spend.',
  );
  lines.push(
    '5. `POST /autogtm/campaigns/{id}/stop` / `/start`, `PATCH /autogtm/campaigns/{id}` for targeting and instructions, `PATCH …/budget` for a per-campaign limit (autopilot off).',
  );
  lines.push(
    '6. `POST /autogtm/suppress-list/people` `{ "list_name", "emails" }` or `/companies` `{ "list_name", "domains" }` — never write to these. Halts anything queued for them.',
  );
  lines.push(
    '7. `POST /autogtm/campaigns/import` `{ "name", "leads": [{ "email", "first_name", "last_name", "company_domain", "job_title" }] }` — a campaign from your own list, up to 5,000 per call. `POST /autogtm/campaigns/{id}/leads` `{ "leads" }` or `{ "csv" }` adds to an existing one, deduped, with a per-row report.',
  );
  lines.push(
    '8. `GET /autogtm/billing/balance` — allowance, credits, and whether sending is exhausted.',
  );
  lines.push('');
  lines.push('## Endpoints');
  lines.push('');

  let tag = '';
  for (const op of OPERATIONS) {
    if (op.tag !== tag) {
      tag = op.tag;
      lines.push(`### ${tag}`);
      lines.push('');
    }
    lines.push(`- \`${op.method.toUpperCase()} ${op.path}\` — ${op.summary}.`);
    if (op.description) lines.push(`  ${op.description}`);
  }

  lines.push('');
  lines.push('## Idea Generator');
  lines.push('');
  lines.push(
    '> What to build, before who to sell it to. Scans Reddit asks, Ask HN and founder case studies, scores each idea on demand, proof of payment and Show HN competition, and hands the best to chovy.com to build. Same key.',
  );
  lines.push('');
  lines.push(
    '- `GET /ideas` — ideas, most worth building first, each with `worth`, `verdict` (`build`, `validate`, `watch`, `crowded`), `paid`, `revenue`, `rivals`.',
  );
  lines.push('- `GET /ideas/{id}` — one idea and every post that asked for it, with links.');
  lines.push(
    '- `POST /ideas/scan` `{ "subs"?, "feeds"? }` — scan now instead of waiting for the six-hourly run.',
  );
  lines.push(
    '- `GET|PUT /ideas/settings` — subreddits and RSS Amplifier feeds (`{ slug, role: asks | signals | built }`).',
  );
  lines.push(
    '- `POST /ideas/{id}/build` — returns a chovy.com link that opens its build intake with the idea filled in.',
  );
  lines.push('');
  lines.push('## Outreach Planner');
  lines.push('');
  lines.push(
    "> Twelve months of outreach plays (Hunter's outreach planner), run by the worker. Each month every product gets that month's plays launched from its own engagement: a case study to people who opened or clicked and never replied, a roundtable invite to slow movers, a competitor-aware sequence to the unengaged, research requests and year-end check-ins to the engaged. Same key.",
  );
  lines.push('');
  lines.push(
    '- `GET /planner` — this month (quarter, buying mode, benchmark, plays), next month, and per product what launched into which campaign for how many people.',
  );
  lines.push("- `GET /planner/year` — all twelve months with each play's segment and touches.");
  lines.push(
    '- `GET /list-sources?kind=funding|leadership|event` — newly funded companies, new leaders and conference pages found weekly in the news for each product, each crawled into its signals campaign with the news as evidence.',
  );
  lines.push(
    "- `POST /planner/run` — launch this month's plays now. Idempotent per product, month and play.",
  );
  lines.push(
    '- `PUT /planner/offerings/{id}` `{ "enabled": bool }` — on by default for every product.',
  );
  lines.push(
    '- `GET /cadences/{id}/variants`, `GET /ab-results` — A/B tests decide themselves at 50+ sends per arm by reply rate; the winner becomes the step intent.',
  );
  lines.push('');
  lines.push('## Rules the engine will not bend');
  lines.push('');
  lines.push(
    '- A suppressed person, an opted-out address or a blocked domain is never written to.',
  );
  lines.push(
    '- A lead who has replied is out of cold outreach; only a reply to them is allowed, and it needs approval (your API call is that approval).',
  );
  lines.push(
    '- Daily caps, the project ceiling and the monthly allowance are checked at send time, not at approval time.',
  );
  lines.push(
    '- Every address is verified before its first message and every 90 days; a bounced address is never sent to again, and a campaign over 2% bounce pauses, re-verifies its queue and resumes by itself.',
  );
  lines.push(
    '- One contact per company at a time, budget holder first, then pain feeler, blocker and champion, 21 days apart.',
  );
  lines.push(
    "- Cold mail goes out Monday to Friday 08:00-17:00 in the recipient's inferred timezone.",
  );
  lines.push('- Nothing is posted to LinkedIn, and GitHub is read, never written.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}
