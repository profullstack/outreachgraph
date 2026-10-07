/**
 * What `og` can do, and how each result is rendered.
 *
 * Separated from the entrypoint so every command is a pure-ish function of
 * (client, args) and can be tested without a terminal or a process exit.
 *
 * The rendering rules come from the surface, not from taste. A CLI's output is
 * read by a person in a hurry and piped into `grep` by the same person ten
 * minutes later, so: one record per line where a line is a record, the id
 * first because that is what the next command needs, and no decoration that
 * changes with terminal width.
 */

import type { ApiClient } from '@outreachgraph/mcp/src/client';

export interface CommandContext {
  readonly client: ApiClient;
  readonly args: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

export interface Command {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  run(context: CommandContext): Promise<string>;
}

function flagString(flags: CommandContext['flags'], key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function rows(value: unknown, key: string): readonly Record<string, unknown>[] {
  const list = (value as Record<string, unknown>)[key];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

function text(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  if (value === null || value === undefined) return fallback;
  return String(value);
}

/** Pads to a column width without truncating anything that carries meaning. */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/** The network a profile URL belongs to, for the handful `og add-social` accepts by URL. */
function networkFromUrl(url: string): string | undefined {
  const host = new URL(url).hostname.replace(/^www\./, '');
  if (/(^|\.)bsky\.app$/.test(host)) return 'bluesky';
  if (/(^|\.)(x|twitter)\.com$/.test(host)) return 'x';
  if (/(^|\.)github\.com$/.test(host)) return 'github';
  if (/(^|\.)linkedin\.com$/.test(host)) return 'linkedin';
  if (/(^|\.)reddit\.com$/.test(host)) return 'reddit';
  if (/(^|\.)youtube\.com$/.test(host)) return 'youtube';
  if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
  // `/@user` on any other host is read as a Fediverse account.
  return /^\/@[^/]+/.test(new URL(url).pathname) ? 'mastodon' : undefined;
}

/** `https://bsky.app/profile/ada.example` → `ada.example`; `https://hachyderm.io/@ada` → `ada@hachyderm.io`. */
function handleFromUrl(url: string): string | undefined {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const first = segments[0];
  if (!first) return undefined;
  if (first.startsWith('@')) {
    const user = first.slice(1);
    return user.includes('@') ? user : `${user}@${parsed.hostname}`;
  }
  const nested = /^(profile|in|user|u|c|channel)$/i.test(first) ? segments[1] : first;
  return nested?.replace(/^@/, '');
}

/** Opens a URL in the person's browser; the URL is printed either way. */
function openInBrowser(url: string): void {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    Bun.spawn([opener, url], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    // Headless box: the printed URL is the fallback.
  }
}

/** Reads one line from stdin without echoing it, so a cookie never lands in scrollback. */
async function readSecret(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const tty = process.stdin.isTTY;
  if (tty) process.stdin.setRawMode(true);
  let value = '';
  try {
    for await (const chunk of process.stdin) {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') return value.trim();
        if (ch === '\u0003') throw new Error('cancelled');
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    }
    return value.trim();
  } finally {
    if (tty) process.stdin.setRawMode(false);
    process.stderr.write('\n');
  }
}

const CONNECTABLE = ['x', 'x-session', 'linkedin', 'hubspot', 'pipedrive'] as const;

/** The CRMs `og connect` accepts a token for. */
const CRMS = ['hubspot', 'pipedrive'] as const;

const CRM_TOKEN_HELP: Readonly<Record<(typeof CRMS)[number], string>> = {
  hubspot:
    'HubSpot: Settings > Integrations > Private Apps > Create, with the crm.objects.contacts read and write scopes. Copy the access token.',
  pipedrive: 'Pipedrive: Personal preferences > API. Copy your personal API token.',
};

/**
 * `og webhooks list | add <url> | rm <id> | test <id>`.
 *
 * `add` prints the signing secret, because it is the only time anyone will
 * see it; everything else prints one endpoint per line, id first.
 */
/** One posting as one line: id, status, company, title, best contact. */
function jobPostLine(post: Record<string, unknown>): string {
  const contacts = rows(post, 'contacts');
  const best = contacts[0];
  const who = best
    ? `${text(best, 'name')} (${text(best, 'role')}${text(best, 'email') ? `, ${text(best, 'email')}` : ''})`
    : text(post, 'lastError') || '-';
  return [
    pad(text(post, 'id'), 32),
    pad(text(post, 'status'), 13),
    pad(`${text(post, 'company', '?')}${post.agency === true ? ' [agency]' : ''}`, 24),
    pad(text(post, 'title', text(post, 'url')), 40),
    who,
  ].join(' ');
}

/** A posting and everyone found behind it, with the evidence for each. */
function jobPostDetail(post: Record<string, unknown>): string {
  const lines = [
    `${text(post, 'title', '?')} at ${text(post, 'company', '?')}${post.agency === true ? ' (recruiting agency, for an unnamed client)' : ''}`,
    text(post, 'url'),
    [text(post, 'location'), post.remote === true ? 'remote' : '', text(post, 'salary')]
      .filter(Boolean)
      .join(' · '),
    `status: ${text(post, 'status')}${text(post, 'companyDomain') ? `   site: ${text(post, 'companyDomain')}` : ''}`,
  ];
  const published = Array.isArray(post.publishedEmails) ? (post.publishedEmails as string[]) : [];
  if (published.length > 0) lines.push(`published on their site: ${published.join(', ')}`);
  if (text(post, 'lastError')) lines.push(`note: ${text(post, 'lastError')}`);
  if (text(post, 'notes')) lines.push(`notes: ${text(post, 'notes')}`);

  const contacts = rows(post, 'contacts');
  lines.push(
    '',
    contacts.length ? 'People:' : 'Nobody found yet. Try: og jobs resolve ' + text(post, 'id'),
  );
  for (const contact of contacts) {
    lines.push(
      `  ${pad(text(contact, 'id'), 32)} ${pad(text(contact, 'name'), 22)} ${pad(text(contact, 'role'), 20)} ${text(contact, 'score')}` +
        `${contact.onCompanySite === true ? '  [named on their site]' : ''}${text(contact, 'personId') ? '  [in campaign]' : ''}`,
      `      ${text(contact, 'profileUrl')}${text(contact, 'email') ? `  ${text(contact, 'email')}` : ''}`,
      `      "${[text(contact, 'headline'), text(contact, 'snippet')].filter(Boolean).join(' · ').slice(0, 160)}"`,
    );
  }
  return lines.filter((line, i) => line !== '' || i > 0).join('\n');
}

/**
 * `og jobs` — job postings, and the people behind each one.
 *
 * `search` takes what you would type into a job board ("senior software
 * engineer (remote)") and adds what it finds; `add` takes URLs. Either way the
 * worker reads each posting and searches for its people; `resolve` does that
 * now and prints them.
 */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** An import report as CSV, the same columns the API's ?format=csv download has. */
export function reportCsv(report: readonly Record<string, unknown>[]): string {
  const columns = ['row', 'email', 'outcome', 'reason', 'why', 'detail'];
  return `${[columns.join(','), ...report.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n')}\n`;
}

/** One line per reported row: what happened to it and why. */
export function reportLines(report: readonly Record<string, unknown>[]): string[] {
  return report.map(
    (row) =>
      `  row ${pad(text(row, 'row', '?'), 6)} ${pad(text(row, 'outcome'), 9)} ` +
      `${pad(text(row, 'email', '-'), 32)} ${text(row, 'detail', text(row, 'why'))}`,
  );
}

/**
 * `og leads`: append a CSV to a running campaign, read an import's report,
 * and review the leads screening is holding back.
 */
async function runLeads({ client, args, flags }: CommandContext): Promise<string> {
  const [verb, target, file] = args;
  const fs = await import('node:fs');

  if (verb === 'add') {
    if (!target || !file) {
      throw new Error('usage: og leads add <campaignId> <file.csv> --consent-source "<where>"');
    }
    const result = (await client.post(`/autogtm/campaigns/${encodeURIComponent(target)}/leads`, {
      csv: fs.readFileSync(file, 'utf8'),
      filename: file.split('/').pop(),
      ...(flagString(flags, 'consent-source')
        ? { consent_source: flagString(flags, 'consent-source') }
        : {}),
      allow_flagged: flags['allow-flagged'] === true,
      skip_project_duplicates: flags['keep-project-duplicates'] !== true,
    })) as Record<string, unknown>;

    const report = rows(result, 'report');
    const out = flagString(flags, 'report');
    if (out) fs.writeFileSync(out, reportCsv(report));

    return [
      `${text(result, 'added', '0')} of ${text(result, 'received', '0')} added to ${target} ` +
        `(task ${text(result, 'task_id')}): ${text(result, 'skipped', '0')} skipped, ` +
        `${text(result, 'rejected', '0')} not usable, ${text(result, 'flagged', '0')} flagged by screening` +
        (Number(result.flagged_held ?? 0) > 0 ? ' and held back from sending' : ''),
      ...reportLines(report),
      ...(result.report_truncated ? ['  … the rest: og leads report <task> --csv'] : []),
      ...(out ? [`Report written to ${out}`] : []),
    ].join('\n');
  }

  if (verb === 'report') {
    if (!target) throw new Error('usage: og leads report <taskId> [--csv]');
    const result = (await client.get(
      `/autogtm/campaigns/import/${encodeURIComponent(target)}/report`,
    )) as Record<string, unknown>;
    const report = rows(result, 'rows');
    if (flags.csv === true) return reportCsv(report).trimEnd();
    return [
      `${text(result, 'total_rows', '0')} rows: ${text(result, 'imported', '0')} new, ` +
        `${text(result, 'merged', '0')} known, ${text(result, 'rejected', '0')} not usable, ` +
        `${text(result, 'skipped', '0')} skipped, ${text(result, 'flagged', '0')} flagged`,
      ...reportLines(report),
    ].join('\n');
  }

  if (verb === 'screened') {
    if (!target) throw new Error('usage: og leads screened <campaignId> [--all]');
    const result = (await client.get(
      `/autogtm/campaigns/${encodeURIComponent(target)}/screened`,
      flags.all === true ? { include_allowed: 'true' } : {},
    )) as Record<string, unknown>;
    const leads = rows(result, 'leads');
    if (leads.length === 0) return 'Screening is holding nobody back in this campaign.';
    return [
      `${text(result, 'held', '0')} held back from sending:`,
      ...leads.map((lead) => {
        const reasons = (lead.reasons as { flag: string; detail: string }[] | undefined) ?? [];
        return (
          `${pad(text(lead, 'person_id'), 30)} ${lead.held ? 'held   ' : 'allowed'} ` +
          `${pad(text(lead, 'email', '-'), 32)} ${reasons.map((r) => r.detail).join('; ')}`
        );
      }),
      'Send to one anyway: og leads allow <personId>',
    ].join('\n');
  }

  if (verb === 'enrich' || verb === 'enrichment') {
    if (!target) throw new Error(`usage: og leads ${verb} <campaignId>`);
    const base = `/autogtm/campaigns/${encodeURIComponent(target)}`;
    if (verb === 'enrich') {
      const max = flagString(flags, 'max');
      await client.post(`${base}/enrich`, max ? { max_searches: Number(max) } : {});
    }
    const status = (await client.get(`${base}/enrichment`)) as Record<string, unknown>;
    const today = (status.today ?? {}) as Record<string, unknown>;
    const last = status.last_run as Record<string, unknown> | undefined;
    return [
      verb === 'enrich'
        ? 'Started. It runs in the background; check: og leads enrichment ' + target
        : '',
      `${text(status, 'leads', '0')} leads: missing ${text(status, 'missing_title', '0')} titles, ` +
        `${text(status, 'missing_linkedin', '0')} LinkedIn, ${text(status, 'missing_name', '0')} names`,
      `searches today: ${text(today, 'searches', '0')} of ${text(today, 'searches_cap', '0')}` +
        `${status.running ? ' (a run is in progress)' : ''}`,
      ...(last
        ? [
            last.error
              ? `last run failed: ${text(last, 'error')}`
              : `last run: +${text(last, 'names', '0')} names, +${text(last, 'titles', '0')} titles, ` +
                `+${text(last, 'profiles', '0')} profiles, +${text(last, 'companies', '0')} company pages, ` +
                `${text(last, 'searches', '0')} searches (${text(last, 'cached', '0')} cached)` +
                `${last.stopped ? `; stopped: ${text(last, 'stopped')}` : ''}`,
          ]
        : []),
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (verb === 'accounts') {
    if (!target) throw new Error('usage: og leads accounts <campaignId>');
    const result = (await client.get(
      `/autogtm/campaigns/${encodeURIComponent(target)}/accounts`,
    )) as Record<string, unknown>;
    const accounts = (result.accounts ?? []) as Record<string, unknown>[];
    if (accounts.length === 0) return 'No companies in this campaign yet.';
    return accounts
      .map((account) => {
        const contacts = (account.contacts ?? []) as Record<string, unknown>[];
        const missing = (account.missing ?? []) as string[];
        return [
          `${text(account, 'company')}${missing.length ? `  (missing: ${missing.join(', ')})` : ''}`,
          ...contacts.map(
            (contact) =>
              `  ${text(contact, 'state').padEnd(10)} ${text(contact, 'persona').padEnd(13)} ` +
              `${text(contact, 'name')}${contact.title ? `, ${text(contact, 'title')}` : ''}`,
          ),
        ].join('\n');
      })
      .join('\n');
  }

  if (verb === 'health') {
    if (!target) throw new Error('usage: og leads health <campaignId>');
    const health = (await client.get(
      `/autogtm/campaigns/${encodeURIComponent(target)}/list-health`,
    )) as Record<string, unknown>;
    const addresses = (health.addresses ?? {}) as Record<string, unknown>;
    const rate = Number(health.bounce_rate ?? 0);
    return [
      `${text(health, 'sends', '0')} sent, ${text(health, 'bounces', '0')} bounced ` +
        `(${(rate * 100).toFixed(1)}%, stop line 2%)`,
      health.paused
        ? `PAUSED since ${text(health, 'paused_at')}: re-verifying every queued address, resumes by itself`
        : 'sending',
      `addresses: ${text(addresses, 'valid', '0')} valid, ${text(addresses, 'catch_all', '0')} accept-all, ` +
        `${text(addresses, 'unverified', '0')} MX-only, ${text(addresses, 'invalid', '0')} invalid, ` +
        `${text(addresses, 'unchecked', '0')} not yet checked`,
    ].join('\n');
  }

  if (verb === 'allow' || verb === 'hold') {
    if (!target) throw new Error(`usage: og leads ${verb} <personId>`);
    await client.post(`/autogtm/leads/${encodeURIComponent(target)}/screening`, {
      allow: verb === 'allow',
    });
    return verb === 'allow'
      ? `${target} allowed: screening no longer holds them back.`
      : `${target} held back from sending again.`;
  }

  throw new Error(
    'usage: og leads add|report|screened|enrich|enrichment|health|accounts|allow|hold …  (og help)',
  );
}

async function runJobs({ client, args, flags }: CommandContext): Promise<string> {
  const [verb = 'list', ...rest] = args;
  const target = rest[0];
  const campaign = flagString(flags, 'campaign');

  if (verb === 'list' || verb === 'ls') {
    const status = flagString(flags, 'status');
    const result = (await client.get(
      `/job-posts${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    )) as Record<string, unknown>;
    const posts = rows(result, 'jobPosts');
    if (posts.length === 0) {
      return 'No job posts. Add one: og jobs add <url>, or og jobs search "senior software engineer (remote)"';
    }
    return posts.map(jobPostLine).join('\n');
  }

  if (verb === 'add') {
    if (rest.length === 0) throw new Error('og jobs add <url> [url…] [--campaign <id>]');
    const result = (await client.post('/job-posts', {
      urls: rest,
      ...(campaign ? { campaignId: campaign } : {}),
    })) as Record<string, unknown>;
    const saved = rows(result, 'saved');
    const duplicates = Array.isArray(result.duplicates) ? result.duplicates.length : 0;
    const rejected = rows(result, 'rejected');
    return [
      `Added ${saved.length}${duplicates ? `, ${duplicates} already listed` : ''}.`,
      ...saved.map((post) => `  ${text(post, 'id')}  ${text(post, 'url')}`),
      ...rejected.map((r) => `  rejected ${text(r, 'url')}: ${text(r, 'reason')}`),
      saved.length
        ? 'Each is being read and searched; see og jobs list, or og jobs resolve <id> now.'
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (verb === 'search') {
    const keyword = rest.join(' ').trim();
    if (!keyword) {
      throw new Error(
        'og jobs search "<keyword>" [--boards workable,greenhouse,lever,ashby] [--limit 20]',
      );
    }
    const boards = flagString(flags, 'boards')
      ?.split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    const limit = flagString(flags, 'limit');
    const result = (await client.post('/job-posts/search', {
      keyword,
      ...(boards ? { boards } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
      ...(campaign ? { campaignId: campaign } : {}),
    })) as Record<string, unknown>;
    const saved = rows(result, 'saved');
    const duplicates = Array.isArray(result.duplicates) ? result.duplicates.length : 0;
    return [
      `Found ${text(result, 'found', '0')} posting(s) for "${keyword}": ${saved.length} new` +
        `${duplicates ? `, ${duplicates} already listed` : ''}.`,
      ...saved.map(
        (post) =>
          `  ${pad(text(post, 'id'), 32)} ${pad(text(post, 'title', '?'), 40)} ${text(post, 'url')}`,
      ),
      saved.length
        ? 'Reading each and searching for its people now; og jobs list shows progress.'
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (verb === 'show') {
    if (!target) throw new Error('og jobs show <id>');
    const result = (await client.get(`/job-posts/${encodeURIComponent(target)}`)) as Record<
      string,
      unknown
    >;
    return jobPostDetail((result.jobPost ?? {}) as Record<string, unknown>);
  }

  if (verb === 'resolve' || verb === 'find') {
    if (!target) throw new Error('og jobs resolve <id>');
    const result = (await client.post(
      `/job-posts/${encodeURIComponent(target)}/resolve`,
      {},
    )) as Record<string, unknown>;
    return jobPostDetail((result.jobPost ?? {}) as Record<string, unknown>);
  }

  if (verb === 'promote') {
    const contactId = rest[1];
    if (!target || !contactId)
      throw new Error('og jobs promote <jobPostId> <contactId> [--campaign <id>]');
    const result = (await client.post(
      `/job-posts/${encodeURIComponent(target)}/contacts/${encodeURIComponent(contactId)}/promote`,
      campaign ? { campaignId: campaign } : {},
    )) as Record<string, unknown>;
    return (
      `Added ${text(result, 'personId')} to campaign ${text(result, 'campaignId')}` +
      (result.email === true
        ? ', with the address their company published.'
        : result.findEmailQueued === true
          ? '; searching for their email.'
          : '.') +
      ' Nothing is sent until you approve it.'
    );
  }

  if (verb === 'status' || verb === 'note' || verb === 'attach') {
    if (!target) throw new Error(`og jobs ${verb} <id> <value>`);
    const value = rest.slice(1).join(' ').trim();
    if (!value) throw new Error(`og jobs ${verb} <id> <value>`);
    const body =
      verb === 'status'
        ? { status: value }
        : verb === 'note'
          ? { notes: value }
          : { campaignId: value };
    if (!client.patch) throw new Error('this client cannot edit');
    const result = (await client.patch(`/job-posts/${encodeURIComponent(target)}`, body)) as Record<
      string,
      unknown
    >;
    return jobPostLine((result.jobPost ?? {}) as Record<string, unknown>);
  }

  if (verb === 'rm' || verb === 'remove' || verb === 'delete') {
    if (!target) throw new Error('og jobs rm <id>');
    if (!client.delete) throw new Error('this client cannot delete');
    await client.delete(`/job-posts/${encodeURIComponent(target)}`);
    return `Removed ${target}.`;
  }

  throw new Error(
    'og jobs list | search "<keyword>" | add <url…> | show <id> | resolve <id> | promote <id> <contactId> | status <id> <status> | note <id> <text> | rm <id>',
  );
}

/**
 * `og audience` — the workspace's own followers, likers and repliers.
 *
 * The verbs read as sentences because the thing being configured is one:
 * watch this account of ours into that campaign, for these kinds of
 * engagement. `run` exists because the first question anybody asks after
 * setting one up is whether it works, and waiting half an hour for the
 * interval to come round is not an answer.
 */
async function runIdeas({ client, args, flags }: CommandContext): Promise<string> {
  const [verb = 'list', target, ...rest] = args;

  if (verb === 'list' || verb === 'ls') {
    const status = flagString(flags, 'status');
    const result = (await client.get(
      `/ideas${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    )) as Record<string, unknown>;
    const ideas = rows(result, 'ideas');
    if (ideas.length === 0) return 'No ideas yet. Run a scan: og ideas scan';
    return ideas
      .map((idea) =>
        [
          pad(text(idea, 'id'), 30),
          pad(text(idea, 'status'), 9),
          pad(text(idea, 'verdict'), 9),
          pad(`${text(idea, 'askers')} asked`, 9),
          pad(`${text(idea, 'paid')} paid`, 7),
          pad(`worth ${text(idea, 'worth')}`, 11),
          text(idea, 'label'),
        ].join(' '),
      )
      .join('\n');
  }

  if (verb === 'show') {
    if (!target) throw new Error('og ideas show <id>');
    const { idea } = (await client.get(`/ideas/${encodeURIComponent(target)}`)) as {
      idea: Record<string, unknown>;
    };
    const asks = Array.isArray(idea.asksList)
      ? (idea.asksList as Array<Record<string, unknown>>)
      : [];
    const wants = Array.isArray(idea.wants) ? (idea.wants as string[]) : [];
    const list = (key: string) => (Array.isArray(idea[key]) ? (idea[key] as unknown[]) : []);
    const rivals = list('rivals') as Array<Record<string, unknown>>;
    return [
      `${text(idea, 'label')}  (${text(idea, 'verdict')}: worth ${text(idea, 'worth')}, ${text(idea, 'askers')} people, ${text(idea, 'paid')} sources showing money, demand ${text(idea, 'demand')}; ${text(idea, 'status')})`,
      wants.length ? `wants: ${wants.join('; ')}` : '',
      list('revenue').length ? `revenue: ${list('revenue').join('; ')}` : '',
      list('feeds').length ? `also in: ${list('feeds').join(', ')}` : '',
      rivals.length
        ? `rivals (${rivals.length}):\n${rivals.map((r) => `  ${text(r, 'title')}  ${text(r, 'url')}`).join('\n')}`
        : '',
      text(idea, 'handoffUrl') ? `building: ${text(idea, 'handoffUrl')}` : '',
      ...asks.map(
        (a) =>
          `  ${text(a, 'source') === 'feed' ? text(a, 'sub') : `r/${text(a, 'sub')}`}${text(a, 'paid') === 'true' ? ' $' : ''}  ${text(a, 'title')}\n    ${text(a, 'url')}`,
      ),
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (verb === 'scan') {
    const subs = flagString(flags, 'subs');
    const feeds = flagString(flags, 'feeds');
    const { result } = (await client.post('/ideas/scan', {
      ...(subs ? { subs: subs.split(',') } : {}),
      ...(feeds ? { feeds: feeds.split(',') } : {}),
    })) as { result: Record<string, unknown> };
    const flagged = Array.isArray(result.flagged) ? result.flagged.length : 0;
    return `read ${text(result, 'read')} posts, ${text(result, 'found')} new asks, ${text(result, 'rejected')} rejected, ${flagged} idea(s) flagged to build${result.judged ? '' : ' (not judged: no model)'}`;
  }

  if (verb === 'build') {
    if (!target) throw new Error('og ideas build <id>');
    const res = (await client.post(`/ideas/${encodeURIComponent(target)}/build`, {})) as Record<
      string,
      unknown
    >;
    return `Handed to chovy.com. Open to start the build: ${text(res, 'handoffUrl')}`;
  }

  if (verb === 'dismiss' || verb === 'watch') {
    if (!target) throw new Error(`og ideas ${verb} <id>`);
    await client.patch!(`/ideas/${encodeURIComponent(target)}`, {
      status: verb === 'dismiss' ? 'dismissed' : 'watching',
    });
    return `${target} ${verb === 'dismiss' ? 'dismissed' : 'back on the list'}`;
  }

  if (verb === 'subs') {
    if (!target) {
      const { settings } = (await client.get('/ideas/settings')) as {
        settings: { subs: string[] };
      };
      return settings.subs.map((s) => `r/${s}`).join('\n');
    }
    const subs = [target, ...rest].flatMap((s) => s.split(','));
    const { settings } = (await client.put('/ideas/settings', { subs })) as {
      settings: { subs: string[] };
    };
    return `Scanning ${settings.subs.length} subreddits: ${settings.subs.join(', ')}`;
  }

  if (verb === 'feeds') {
    type Feed = { slug: string; role: string; name: string };
    const show = (feeds: Feed[]) =>
      feeds.map((f) => `${pad(f.role, 8)} ${pad(f.slug, 34)} ${f.name}`).join('\n');
    if (!target) {
      const { settings } = (await client.get('/ideas/settings')) as { settings: { feeds: Feed[] } };
      return show(settings.feeds);
    }
    // og ideas feeds slug-a asks:slug-b built:slug-c (a bare slug reads as signals)
    const feeds = [target, ...rest]
      .flatMap((s) => s.split(','))
      .map((s) => {
        const [role, slug] =
          s.includes(':') && !s.includes('://') ? s.split(':', 2) : [undefined, s];
        return role ? { slug: slug!, role } : slug!;
      });
    const { settings } = (await client.put('/ideas/settings', { feeds })) as {
      settings: { feeds: Feed[] };
    };
    return show(settings.feeds);
  }

  throw new Error(
    'og ideas list [--status build] | show <id> | scan [--subs a,b] [--feeds x,y] | build <id> | dismiss <id> | subs [a b c] | feeds [slug asks:slug built:slug]',
  );
}

async function runAudience({ client, args, flags }: CommandContext): Promise<string> {
  const [verb = 'list', target] = args;

  if (verb === 'list' || verb === 'ls') {
    const result = (await client.get('/audience')) as Record<string, unknown>;
    const watches = rows(result, 'watches');
    if (watches.length === 0) {
      return 'No audience watches. Add one: og audience watch bluesky:you.bsky.social';
    }

    return watches
      .map((watch) => {
        const kinds = Array.isArray(watch.kinds) ? (watch.kinds as string[]).join(',') : '';
        const error = text(watch, 'lastError');
        return [
          pad(text(watch, 'id'), 32),
          pad(text(watch, 'enabled') === 'true' ? 'on' : 'off', 4),
          pad(`${text(watch, 'network')}:${text(watch, 'account')}`, 34),
          pad(text(watch, 'mode'), 8),
          pad(kinds, 30),
          `every ${text(watch, 'pollMinutes')}m`,
          error ? `  stopped: ${error}` : '',
        ].join(' ');
      })
      .join('\n');
  }

  if (verb === 'watch' || verb === 'add') {
    if (!target) {
      throw new Error(
        'og audience watch <network:handle | profile url> [--campaign <id>] [--kinds follow,like]',
      );
    }

    const url = /^https?:\/\//i.test(target) ? target : undefined;
    const colon = url ? -1 : target.indexOf(':');
    const network = url ? networkFromUrl(url) : colon > 0 ? target.slice(0, colon) : undefined;
    const account = url ?? (colon > 0 ? target.slice(colon + 1) : target);
    if (!network) throw new Error(`cannot place ${target}: use network:handle or a profile url`);

    const kinds = flagString(flags, 'kinds')
      ?.split(',')
      .map((kind) => kind.trim())
      .filter(Boolean);

    const result = (await client.post('/audience', {
      network,
      account,
      ...(flagString(flags, 'campaign') ? { campaignId: flagString(flags, 'campaign') } : {}),
      ...(kinds ? { kinds } : {}),
      ...(flagString(flags, 'mode') ? { mode: flagString(flags, 'mode') } : {}),
      ...(flagString(flags, 'every') ? { pollMinutes: Number(flagString(flags, 'every')) } : {}),
      ...(flags.off === true ? { enabled: false } : {}),
    })) as { watch?: Record<string, unknown> };

    const watch = result.watch ?? {};
    const kindList = Array.isArray(watch.kinds) ? (watch.kinds as string[]).join(', ') : '';
    return [
      `Watching ${text(watch, 'network')}:${text(watch, 'account')} (${text(watch, 'id')})`,
      `Reading ${kindList} into campaign ${text(watch, 'campaignId')},` +
        ` every ${text(watch, 'pollMinutes')} minutes.`,
      text(watch, 'mode') === 'handoff'
        ? 'Hand-off only: post what you saw to /audience/engagements.'
        : `Try it now: og audience run ${text(watch, 'id')}`,
    ].join('\n');
  }

  if (verb === 'unwatch' || verb === 'rm' || verb === 'remove') {
    if (!target) throw new Error('og audience unwatch <watchId>');
    if (!client.delete) throw new Error('this client cannot delete');
    await client.delete(`/audience/${encodeURIComponent(target)}`);
    return `Stopped watching ${target}.`;
  }

  if (verb === 'run') {
    if (!target) throw new Error('og audience run <watchId>');
    const response = (await client.post(`/audience/${encodeURIComponent(target)}/run`, {})) as {
      result?: Record<string, unknown>;
    };
    const result = response.result ?? {};

    // A refusal is the answer, not an error: the network said no and the
    // reason is what the user has to act on.
    if (text(result, 'outcome') !== 'ok') {
      return `${text(result, 'outcome')}: ${text(result, 'detail', 'no reason given')}`;
    }

    return (
      `Read ${text(result, 'read', '0')} engagement(s): ` +
      `${text(result, 'recorded', '0')} new, ${text(result, 'peopleCreated', '0')} new people.`
    );
  }

  throw new Error('og audience list | watch <account> | unwatch <id> | run <id>');
}

async function runWebhooks({ client, args, flags }: CommandContext): Promise<string> {
  const [verb = 'list', target] = args;

  if (verb === 'list' || verb === 'ls') {
    const result = (await client.get('/webhooks')) as Record<string, unknown>;
    const endpoints = rows(result, 'endpoints');
    if (endpoints.length === 0) return 'No webhooks. Add one: og webhooks add <https-url>';
    return endpoints
      .map((endpoint) => {
        const events = Array.isArray(endpoint.events) ? (endpoint.events as string[]) : [];
        const last = endpoint.lastDelivery as { status?: string; statusCode?: number } | undefined;
        return [
          pad(text(endpoint, 'id'), 32),
          pad(text(endpoint, 'kind'), 8),
          pad(endpoint.active === false ? 'disabled' : 'active', 9),
          pad(events.length === 0 ? 'all events' : events.join(','), 30),
          text(endpoint, 'urlHint'),
          last?.status
            ? `  last: ${last.status}${last.statusCode ? ` ${last.statusCode}` : ''}`
            : '',
        ].join(' ');
      })
      .join('\n');
  }

  if (verb === 'add') {
    if (!target)
      throw new Error('og webhooks add <https-url> [--slack] [--events a,b] [--description text]');
    const events = flagString(flags, 'events')
      ?.split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    const description = flagString(flags, 'description');
    const result = (await client.post('/webhooks', {
      url: target,
      kind: flags.slack === true ? 'slack' : 'generic',
      ...(events ? { events } : {}),
      ...(description ? { description } : {}),
    })) as { endpoint?: Record<string, unknown>; secret?: string };
    return [
      `Added ${text(result.endpoint ?? {}, 'id')} -> ${text(result.endpoint ?? {}, 'urlHint')}`,
      `Signing secret (shown once, store it now): ${result.secret ?? '?'}`,
      'Verify X-OutreachGraph-Signature as HMAC-SHA256(secret, "<t>.<raw body>").',
    ].join('\n');
  }

  if (verb === 'rm' || verb === 'remove' || verb === 'delete') {
    if (!target) throw new Error('og webhooks rm <webhookId>');
    if (!client.delete) throw new Error('this client cannot delete');
    await client.delete(`/webhooks/${encodeURIComponent(target)}`);
    return `Removed ${target}.`;
  }

  if (verb === 'test') {
    if (!target) throw new Error('og webhooks test <webhookId>');
    const result = (await client.post(
      `/webhooks/${encodeURIComponent(target)}/test`,
      {},
    )) as Record<string, unknown>;
    return `Queued a ping (${text(result, 'deliveryId')}). It goes out on the worker's next tick; see og webhooks deliveries ${target}.`;
  }

  if (verb === 'deliveries' || verb === 'log') {
    const path = target
      ? `/webhooks/${encodeURIComponent(target)}/deliveries`
      : '/webhooks/deliveries';
    const result = (await client.get(path)) as Record<string, unknown>;
    const deliveries = rows(result, 'deliveries');
    if (deliveries.length === 0) return 'No deliveries yet.';
    return deliveries
      .map((d) =>
        [
          pad(text(d, 'createdAt'), 25),
          pad(text(d, 'eventType'), 24),
          pad(text(d, 'status'), 10),
          pad(text(d, 'statusCode', '-'), 4),
          `attempt ${text(d, 'attempt')}`,
          text(d, 'error') ? `  ${text(d, 'error')}` : '',
        ].join(' '),
      )
      .join('\n');
  }

  throw new Error('og webhooks list | add <url> | rm <id> | test <id> | deliveries [id]');
}

/**
 * Opens the person's editor on a file and returns what they saved. Injected
 * through `edit` on the context so tests never spawn anything.
 */
async function editInEditor(markdown: string): Promise<string> {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'og-profile-'));
  const path = join(dir, 'openprofile.md');
  writeFileSync(path, markdown);
  try {
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
    const child = Bun.spawnSync([...editor.split(/\s+/), path], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    if (child.exitCode !== 0)
      throw new Error(`${editor} exited with ${child.exitCode}; nothing saved`);
    return readFileSync(path, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `og profile <id>` prints the file; `og profile edit <id>` corrects it, from
 * `--file` or from $EDITOR; `og profile publish <id> --public|--private`
 * switches it. What is sent is always the whole file or one flag, so what the
 * server stores is exactly what the person saw.
 */
async function runProfile({ client, args, flags }: CommandContext): Promise<string> {
  const [first, second] = args;
  const verb = first === 'edit' || first === 'publish' || first === 'show' ? first : 'show';
  const personId = verb === 'show' && first !== 'show' ? first : second;
  if (!personId)
    throw new Error(
      `a person id is required: og profile ${verb === 'show' ? '' : `${verb} `}<personId>`,
    );
  const path = `/people/${encodeURIComponent(personId)}/openprofile`;

  if (verb === 'publish') {
    const isPublic = flags.public === true ? true : flags.private === true ? false : undefined;
    if (isPublic === undefined)
      throw new Error('say which: og profile publish <personId> --public | --private');
    const result = (await client.post(`${path}/publish`, { public: isPublic })) as Record<
      string,
      unknown
    >;
    return result.public
      ? `Public: ${text(result, 'url')}`
      : `Private. ${personId} is served only to this workspace again.`;
  }

  const current = (await client.get(`${path}.md`)) as Record<string, unknown>;
  // The route answers text/markdown; the client hands non-JSON back under `raw`.
  const markdown = text(current, 'raw').trimEnd();
  if (verb === 'show') return markdown;

  const file = flagString(flags, 'file');
  const edited = file
    ? await Bun.file(file).text()
    : await ((flags as { edit?: (markdown: string) => Promise<string> }).edit ?? editInEditor)(
        `${markdown}\n`,
      );
  if (!edited.trim()) throw new Error('an empty file corrects nothing; nothing saved');
  if (edited.trim() === markdown.trim()) return 'No change.';

  const result = (await client.put(path, { markdown: edited })) as Record<string, unknown>;
  return `Saved ${personId} at ${text(result, 'updatedAt')}${result.public ? ' (public)' : ''}\n\n${text(result, 'markdown').trimEnd()}`;
}

/**
 * One conversation as a terminal reads it: oldest first, who spoke, the label
 * a reply was given, and the drafted answer last — because the next command
 * after reading a thread is usually `og inbox reply`.
 */
export function renderThread(thread: Record<string, unknown>): string {
  const person = (thread.person ?? {}) as Record<string, unknown>;
  const lines = [
    `${text(person, 'name')}${person.company ? ` · ${text(person, 'company')}` : ''} — ${text(thread, 'status')}${thread.suppressed ? ' (suppressed)' : ''}`,
    '',
  ];

  for (const message of rows(thread, 'messages')) {
    const from = text(message, 'from');
    const who = from === 'them' ? 'THEM' : from === 'automated' ? 'AUTO' : 'US  ';
    const label = message.label as { label?: string; confidence?: number; source?: string } | null;
    const tag = label?.label
      ? ` [${label.label}${typeof label.confidence === 'number' ? ` ${Math.round(label.confidence * 100)}%` : ''}${label.source ? ` ${label.source}` : ''}]`
      : '';
    lines.push(
      `${text(message, 'at')} ${who} ${text(message, 'network')}${message.original ? ' (original)' : ''}${tag}`,
    );
    if (message.subject) lines.push(`  Subject: ${text(message, 'subject')}`);
    for (const line of text(message, 'body').split('\n')) lines.push(`  ${line}`);
    lines.push('');
  }

  const pending = thread.pending_reply as Record<string, unknown> | null | undefined;
  if (pending) {
    lines.push(`Drafted reply waiting (${text(pending, 'recommendation_id')}):`);
    lines.push(
      pending.body
        ? text(pending, 'body')
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n')
        : '  (no draft yet; write one with og inbox reply)',
    );
  }

  return lines.join('\n').trimEnd();
}

/**
 * One step from the command line: `network:action[:delayHours[:condition[:waitHours]]]`.
 *
 * Positional rather than `key=value` because a plan is typed as a column of
 * `--step` flags and read back the same way; empty fields keep their default,
 * so `linkedin:connect:24::168` is "invite a day later, wait a week". Nothing
 * is validated here beyond the shape — the server refuses a bad plan with the
 * domain's own sentences, which are better than anything this could say.
 */
export function parseStepSpec(spec: string, position: number): Record<string, unknown> {
  const [network, action, delay, condition, wait] = spec.split(':').map((part) => part.trim());
  if (!network || !action) {
    throw new Error(
      `cannot read step "${spec}": use network:action[:delayHours[:condition[:waitHours]]]`,
    );
  }
  const number = (value: string | undefined, name: string): number | undefined => {
    if (!value) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${name} in "${spec}" is not a number`);
    return parsed;
  };
  const delayHours = number(delay, 'the delay');
  const waitForAcceptanceHours = number(wait, 'the acceptance wait');
  return {
    position,
    network,
    action,
    delayHours: delayHours ?? 0,
    ...(condition ? { condition } : {}),
    ...(waitForAcceptanceHours !== undefined ? { waitForAcceptanceHours } : {}),
  };
}

/** `og planner`, `og planner year`, `og planner run`, `og planner on|off <productId>`. */
async function runPlannerCommand(client: ApiClient, args: readonly string[]): Promise<string> {
  const [verb, id] = args;

  if (!verb || verb === 'status') {
    const view = (await client.get('/planner')) as Record<string, unknown>;
    const next = (view.next ?? {}) as Record<string, unknown>;
    const lines = [
      `${text(view, 'period')} · Q${text(view, 'quarter')} M${text(view, 'month')} · ${text(view, 'label')}`,
      `buying mode: ${text(view, 'buyingMode')}`,
      `good looks like: ${text(view, 'benchmark')}`,
      `next month: ${text(next, 'label')}`,
      '',
    ];
    for (const offering of rows(view, 'offerings')) {
      const runs = rows(offering, 'runs').filter(
        (run) => text(run, 'period') === text(view, 'period'),
      );
      lines.push(
        `${text(offering, 'name')} (${text(offering, 'offeringId')})${offering.enabled === false ? ' [planner off]' : ''}`,
      );
      if (runs.length === 0) lines.push('  nothing launched yet this month');
      for (const run of runs) {
        lines.push(
          `  ${text(run, 'playKey')}${run.campaignId ? ` -> ${text(run, 'campaignId')}, ${text(run, 'people', '0')} people` : ''}`,
        );
      }
    }
    return lines.join('\n');
  }

  if (verb === 'year') {
    const year = (await client.get('/planner/year')) as Record<string, unknown>;
    return rows(year, 'months')
      .map(
        (month) =>
          `Q${text(month, 'quarter')} M${text(month, 'month')}  ${text(month, 'label')}` +
          rows(month, 'plays')
            .map((play) => `\n    ${text(play, 'sequence')}: ${text(play, 'title')}`)
            .join(''),
      )
      .join('\n');
  }

  if (verb === 'run') {
    const result = (await client.post('/planner/run', {})) as Record<string, unknown>;
    const launched = rows(result, 'launched');
    return launched.length === 0
      ? 'Nothing new to launch: this month’s plays already ran, or their segments are empty.'
      : launched
          .map(
            (play) =>
              `${text(play, 'playKey')}${play.campaignId ? ` -> ${text(play, 'campaignId')}, ${text(play, 'people', '0')} people` : ''}`,
          )
          .join('\n');
  }

  if (verb === 'on' || verb === 'off') {
    if (!id) throw new Error(`usage: og planner ${verb} <productId>`);
    await client.put(`/planner/offerings/${encodeURIComponent(id)}`, { enabled: verb === 'on' });
    return `Planner ${verb} for ${id}.`;
  }

  throw new Error('og planner [status] | year | run | on <productId> | off <productId>');
}

/** `og cadences`, `og cadences show <id>`, `og cadences create …`. */
async function runCadences({ client, args, flags }: CommandContext): Promise<string> {
  const [verb, id] = args;

  if (!verb || verb === 'list') {
    const cadences = rows(await client.get('/cadences'), 'cadences');
    if (cadences.length === 0) return 'No plans yet. Try `og playbooks` or `og cadences create`.';
    return cadences
      .map((cadence) =>
        [
          pad(text(cadence, 'id'), 30),
          pad(text(cadence, 'status'), 9),
          pad(`${text(cadence, 'steps')} steps`, 9),
          pad(`${text(cadence, 'active_enrollments', '0')} on it`, 10),
          text(cadence, 'name'),
        ].join(' '),
      )
      .join('\n');
  }

  if (verb === 'show') {
    if (!id) throw new Error('a cadence id is required: og cadences show <id>');
    const detail = (await client.get(`/cadences/${encodeURIComponent(id)}`)) as Record<
      string,
      unknown
    >;
    const cadence = (detail.cadence ?? {}) as Record<string, unknown>;
    const lines = [`${text(cadence, 'name')} (${text(cadence, 'status')})`];
    for (const step of rows(detail, 'steps')) {
      const condition = text(step, 'condition', 'always');
      const wait = text(step, 'wait_for_acceptance_hours');
      lines.push(
        [
          pad(`${Number(text(step, 'position', '0')) + 1}.`, 4),
          pad(`${text(step, 'network')}:${text(step, 'action')}`, 24),
          pad(`+${text(step, 'delay_hours', '0')}h`, 7),
          condition === 'always' ? '' : condition,
          wait ? `waits ${wait}h for acceptance` : '',
          text(step, 'intent'),
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
    return lines.join('\n');
  }

  if (verb === 'create') {
    const name = flagString(flags, 'name');
    if (!name) throw new Error('--name is required');

    const file = flagString(flags, 'file');
    // A file holds either the steps array or a whole `{ steps }` body.
    const fromFile: unknown = file ? JSON.parse(await Bun.file(file).text()) : undefined;
    const steps =
      fromFile === undefined
        ? asList(flags.step).map((spec, index) => parseStepSpec(spec, index))
        : Array.isArray(fromFile)
          ? fromFile
          : (fromFile as { steps?: unknown }).steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error(
        'at least one --step is required, e.g. --step linkedin:view_profile --step linkedin:connect:24::168',
      );
    }

    const result = (await client.post('/cadences', {
      name,
      steps,
      ...(flagString(flags, 'campaign') ? { campaignId: flagString(flags, 'campaign') } : {}),
      ...(flags.active === true ? { status: 'active' } : {}),
    })) as Record<string, unknown>;
    return `Created ${text(result, 'cadenceId')}${flags.active === true ? ' (active)' : ' as a draft'}`;
  }

  if (verb === 'ab') {
    if (!id) throw new Error('a cadence id is required: og cadences ab <id>');
    const result = (await client.get(`/cadences/${encodeURIComponent(id)}/variants`)) as Record<
      string,
      unknown
    >;
    const lines: string[] = [];
    for (const row of rows(result, 'variants')) {
      const rate =
        row.replyRate === null || row.replyRate === undefined
          ? '-'
          : `${(Number(row.replyRate) * 100).toFixed(1)}%`;
      lines.push(
        `step ${Number(text(row, 'step', '0')) + 1} ${text(row, 'variant')}: ` +
          `${text(row, 'sent', '0')} sent, ${text(row, 'replied', '0')} replied (${rate})`,
      );
    }
    for (const done of rows(result, 'decided')) {
      lines.push(
        `decided step ${Number(text(done, 'step', '0')) + 1}: ${text(done, 'winner')} won, ${text(done, 'reason')}`,
      );
    }
    return lines.length > 0
      ? lines.join('\n')
      : 'No A/B test on this plan yet. Add variants to a step to start one; it decides itself at 50+ sends per arm.';
  }

  throw new Error(
    'og cadences [list] | og cadences show <id> | og cadences ab <id> | og cadences create --name …',
  );
}

export const COMMANDS: readonly Command[] = [
  {
    name: 'today',
    usage: 'og today',
    summary: 'The approval queue, highest priority first.',
    async run({ client }) {
      const result = await client.get('/recommendations', { status: 'pending', limit: '25' });
      const cards = rows(result, 'recommendations');

      if (cards.length === 0) return 'Nothing waiting. The queue is empty.';

      return cards
        .map((card) =>
          [
            pad(text(card, 'id'), 30),
            pad(text(card, 'action'), 16),
            pad(text(card, 'network'), 10),
            pad(text(card, 'policy_status', text(card, 'policyStatus')), 20),
            text(card, 'display_name', text(card, 'displayName')),
          ].join(' '),
        )
        .join('\n');
    },
  },
  {
    name: 'prospects',
    usage: 'og prospects [--campaign <id>] [--limit <n>]',
    summary: 'Prospects, most promising first.',
    async run({ client, flags }) {
      const result = await client.get('/people', {
        ...(flagString(flags, 'campaign') ? { campaignId: flagString(flags, 'campaign') } : {}),
        limit: flagString(flags, 'limit') ?? '25',
      });

      const people = rows(result, 'people');
      if (people.length === 0) return 'No prospects yet. Try `og add <url>`.';

      return people
        .map((person) =>
          [
            pad(text(person, 'id'), 30),
            pad(text(person, 'opportunity', '-'), 5),
            text(person, 'display_name', text(person, 'displayName')),
          ].join(' '),
        )
        .join('\n');
    },
  },
  {
    name: 'add',
    usage: 'og add <url> [--campaign <id>]',
    summary: 'Start the pipeline from a profile, company page or post.',
    async run({ client, args, flags }) {
      const url = args[0];
      if (!url) throw new Error('a url is required: og add <url>');

      const result = (await client.post('/prospects/by-url', {
        url,
        ...(flagString(flags, 'campaign') ? { campaignId: flagString(flags, 'campaign') } : {}),
      })) as Record<string, unknown>;

      return `Added ${text(result, 'personId', text(result, 'id', url))}`;
    },
  },
  {
    name: 'products-add',
    usage: 'og products-add <site>... [--file <path>] [--autopilot]',
    summary: 'Start a campaign for each of your own sites: one product per site.',
    async run({ client, args, flags }) {
      const file = flagString(flags, 'file');
      const fromFile = file ? (await import('node:fs')).readFileSync(file, 'utf8') : '';
      const domains = [...args, ...fromFile.split(/[\s,;]+/)].filter((d) => d.trim());
      if (domains.length === 0) {
        throw new Error('at least one site is required: og products-add ugig.net nichedb.dev');
      }

      const result = (await client.post('/campaigns/bulk', {
        domains,
        autopilot: flags.autopilot === true,
      })) as Record<string, unknown>;

      const queued = (result.queued as string[] | undefined) ?? [];
      const existing = rows(result, 'existing');
      const invalid = (result.invalid as string[] | undefined) ?? [];

      return [
        `Queued ${queued.length} site${queued.length === 1 ? '' : 's'}` +
          (queued.length > 0 ? ` — watch with: og batch ${text(result, 'batchId')}` : ''),
        ...(existing.length > 0
          ? [`Already products: ${existing.map((p) => text(p, 'domain')).join(', ')}`]
          : []),
        ...(invalid.length > 0 ? [`Not websites: ${invalid.join(', ')}`] : []),
      ].join('\n');
    },
  },
  {
    name: 'batch',
    usage: 'og batch <batchId>',
    summary: 'Progress of a bulk submission, one line per item.',
    async run({ client, args }) {
      const id = args[0];
      if (!id) throw new Error('a batch id is required: og batch <batchId>');

      const result = (await client.get(`/batches/${encodeURIComponent(id)}`)) as Record<
        string,
        unknown
      >;
      const items = rows(result, 'items');
      const summary =
        `${text(result, 'done', '0')} done, ${text(result, 'failed', '0')} failed, ` +
        `${text(result, 'pending', '0')} waiting, ${text(result, 'running', '0')} running`;

      return [
        summary,
        ...items.map(
          (item) =>
            `${pad(text(item, 'status'), 8)} ${text(item, 'url', text(item, 'id'))}` +
            (item.lastError ? `  ${text(item, 'lastError')}` : ''),
        ),
      ].join('\n');
    },
  },
  {
    name: 'add-social',
    usage: 'og add-social <network:handle | profile url>... [--campaign <id>] [--via <how>]',
    summary: 'Hand over people from a social network, for assessment and an OpenProfile.',
    async run({ client, args, flags }) {
      if (args.length === 0) {
        throw new Error('at least one person is required: og add-social bluesky:ada.example');
      }
      const people = args.map((entry) => {
        const url = /^https?:\/\//i.test(entry) ? entry : undefined;
        const colon = entry.indexOf(':');
        const network = url ? networkFromUrl(url) : colon > 0 ? entry.slice(0, colon) : undefined;
        const handle = url ? handleFromUrl(url) : colon > 0 ? entry.slice(colon + 1) : entry;
        if (!network || !handle)
          throw new Error(`cannot place ${entry}: use network:handle or a profile url`);
        return {
          network,
          handle,
          ...(url ? { profileUrl: url } : {}),
          ...(flagString(flags, 'via') ? { via: flagString(flags, 'via') } : {}),
        };
      });

      const result = (await client.post('/people/from-social', {
        people,
        source: 'og',
        ...(flagString(flags, 'campaign') ? { campaignId: flagString(flags, 'campaign') } : {}),
      })) as Record<string, unknown>;

      const added = rows(result, 'people');
      const rejected = rows(result, 'rejected');
      const lines = added.map((person) =>
        [
          pad(text(person, 'id'), 30),
          pad(text(person, 'created') === 'true' ? 'new' : 'known', 6),
          `${text(person, 'network')}:${text(person, 'handle')}`,
        ].join(' '),
      );
      for (const entry of rejected)
        lines.push(`rejected ${text(entry, 'handle')}: ${text(entry, 'reason')}`);
      lines.push(
        `${text(result, 'created', '0')} new, ${text(result, 'existing', '0')} known, ` +
          `${text(result, 'queued', '0')} queued for an OpenProfile in campaign ${text(result, 'campaignId')}`,
      );
      return lines.join('\n');
    },
  },
  {
    name: 'openprofile',
    usage: 'og openprofile <personId>',
    summary: 'The OpenProfile.md assembled for one person (same as `og profile <personId>`).',
    async run(context) {
      return runProfile({ ...context, args: ['show', ...context.args] });
    },
  },
  {
    name: 'profile',
    usage:
      'og profile <personId> | og profile edit <personId> [--file <md>] | og profile publish <personId> --public|--private',
    summary: "A person's OpenProfile.md: read it, correct it, switch it public.",
    run: runProfile,
  },
  {
    name: 'signals',
    usage: 'og signals <personId>',
    summary: 'The public evidence collected about one prospect.',
    async run({ client, args }) {
      const personId = args[0];
      if (!personId) throw new Error('a person id is required: og signals <personId>');

      const result = await client.get(`/people/${personId}/signals`);
      const signals = rows(result, 'signals');

      if (signals.length === 0) return 'No signals recorded for this person.';

      return signals
        .map((signal) =>
          [
            pad(text(signal, 'signal_type', text(signal, 'type')), 18),
            pad(text(signal, 'network'), 10),
            text(signal, 'summary'),
          ].join(' '),
        )
        .join('\n');
    },
  },
  {
    name: 'approve',
    usage: 'og approve <recommendationId> [--note <text>]',
    summary: 'Approve one card. The policy engine re-checks it here.',
    async run({ client, args, flags }) {
      const id = args[0];
      if (!id) throw new Error('a recommendation id is required: og approve <id>');

      const result = (await client.post(`/recommendations/${id}/approve`, {
        ...(flagString(flags, 'note') ? { note: flagString(flags, 'note') } : {}),
      })) as Record<string, unknown>;

      return `Approved ${id}${result.actionId ? ` (action ${String(result.actionId)})` : ''}`;
    },
  },
  {
    name: 'post',
    usage: 'og post <recommendationId> --network <network>',
    summary: 'Get a prefilled composer link for a network we may not automate.',
    async run({ client, args, flags }) {
      const id = args[0];
      const network = flagString(flags, 'network');

      if (!id) throw new Error('a recommendation id is required: og post <id> --network <network>');
      if (!network) throw new Error('--network is required, e.g. --network linkedin');

      const result = (await client.post(`/recommendations/${id}/share`, {
        network,
      })) as Record<string, unknown>;

      // The URL alone on the last line, so `og post ... | tail -1 | xargs open`
      // does the obvious thing.
      const url = text(result, 'shareUrl', text(result, 'url'));
      return url ? `Open this and post it yourself:\n${url}` : JSON.stringify(result, null, 2);
    },
  },
  {
    name: 'playbooks',
    usage: 'og playbooks',
    summary: 'Prepackaged plays worth starting from.',
    async run({ client }) {
      const result = await client.get('/playbooks');
      return rows(result, 'playbooks')
        .map((play) =>
          [
            pad(text(play, 'slug'), 24),
            pad(`${text(play, 'steps')} steps`, 10),
            text(play, 'summary'),
          ].join(' '),
        )
        .join('\n');
    },
  },
  {
    name: 'lists',
    usage: 'og lists [funding|leadership|event] [--limit <n>]',
    summary:
      'Newly funded companies, new leaders and conference pages found in the news for your products.',
    run: async ({ client, args, flags }) => {
      const kind = args[0];
      const limit = flagString(flags, 'limit');
      const query = new URLSearchParams({
        ...(kind ? { kind } : {}),
        ...(limit ? { limit } : {}),
      }).toString();
      const items = rows(await client.get(`/list-sources${query ? `?${query}` : ''}`), 'items');
      if (items.length === 0) {
        return 'Nothing found yet. Each product is scanned weekly for funding, appointments and events.';
      }
      return items
        .map(
          (item) =>
            `${pad(text(item, 'kind'), 10)} ${text(item, 'company', '-')}` +
            `${item.person ? ` · ${text(item, 'person')}, ${text(item, 'role')}` : ''}` +
            `${item.domain ? ` (${text(item, 'domain')})` : ''}\n           ${text(item, 'title')}`,
        )
        .join('\n');
    },
  },
  {
    name: 'planner',
    usage: 'og planner [status] | og planner year | og planner run | og planner on|off <productId>',
    summary:
      'The 12-month outreach planner: this month’s play per product, launched automatically from engagement.',
    run: ({ client, args }) => runPlannerCommand(client, args),
  },
  {
    name: 'cadences',
    usage:
      'og cadences | og cadences show <id> | og cadences ab <id> | og cadences create --name <name> ' +
      '--step network:action[:delayHours[:condition[:waitHours]]]... [--campaign <id>] [--active] [--file plan.json]',
    summary:
      'Plans of touches over time; a step may run only if connected, not connected, clicked, or not replied.',
    run: runCadences,
  },
  {
    name: 'grid',
    usage:
      'og grid --name <name> --ask <question> [--ask <question>] --person <id> [--person <id>]',
    summary: 'Ask questions across many prospects.',
    async run({ client, flags }) {
      const name = flagString(flags, 'name');
      const questions = asList(flags.ask);
      const personIds = asList(flags.person);

      if (!name) throw new Error('--name is required');
      if (questions.length === 0) throw new Error('at least one --ask is required');
      if (personIds.length === 0) throw new Error('at least one --person is required');

      const result = (await client.post('/grids', {
        name,
        questions,
        personIds,
      })) as Record<string, unknown>;

      return `Grid ${text(result, 'gridId')} created with ${text(result, 'cells')} cells. Run it with: og grid-run ${text(result, 'gridId')}`;
    },
  },
  {
    name: 'grid-run',
    usage: 'og grid-run <gridId> [--limit <n>]',
    summary: 'Answer outstanding cells. Safe to repeat; it resumes.',
    async run({ client, args, flags }) {
      const id = args[0];
      if (!id) throw new Error('a grid id is required: og grid-run <gridId>');

      const limit = flagString(flags, 'limit');
      const result = (await client.post(`/grids/${id}/run`, {
        ...(limit ? { limit: Number(limit) } : {}),
      })) as Record<string, unknown>;

      return `${text(result, 'answered')} answered, ${text(result, 'noEvidence')} with no evidence, ${text(result, 'remaining')} remaining (${text(result, 'status')})`;
    },
  },
  {
    name: 'connect',
    usage:
      'og connect x-session --accept-x-risk | og connect linkedin --accept-linkedin-risk | og connect x | og connect hubspot|pipedrive [--token <token>]',
    summary:
      'Connect X or LinkedIn (session or OAuth 2.1), or a CRM (HubSpot, Pipedrive) that replies and approvals sync to.',
    async run({ client, args, flags }) {
      const network = args[0];
      if (network === 'hubspot' || network === 'pipedrive') {
        const token =
          flagString(flags, 'token') ??
          (process.stderr.write(`${CRM_TOKEN_HELP[network]}\n`),
          await readSecret(`${network} token (input hidden): `));
        if (!token) throw new Error('no token entered');
        await client.put(`/integrations/crm/${network}`, { token });
        return `Connected ${network === 'hubspot' ? 'HubSpot' : 'Pipedrive'}. Replies and approved outreach now sync as contacts with a note.`;
      }
      if (network === 'x') {
        const started = (await client.post('/integrations/x/oauth/start', {})) as Record<
          string,
          unknown
        >;
        const url = text(started, 'authorizeUrl');
        process.stderr.write(`Opening X to approve access:\n  ${url}\n\nWaiting`);
        openInBrowser(url);

        const deadline = Date.parse(text(started, 'expiresAt')) || Date.now() + 15 * 60_000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          process.stderr.write('.');
          const status = (await client.get('/integrations/x')) as {
            account?: { connected?: boolean; username?: string; pending?: boolean };
          };
          if (status.account?.connected && !status.account.pending) {
            process.stderr.write('\n');
            return `Connected X as @${status.account.username ?? '?'}. X cards will now send, paced.`;
          }
        }
        throw new Error('timed out waiting for X; run og connect x again');
      }

      if (network === 'x-session') {
        if (flags['accept-x-risk'] !== true) {
          return [
            'Automating X through your session is against its terms, and X locks accounts that post like a bot.',
            'OutreachGraph paces it (about 20 a day, 3 to 8 minutes apart) to keep that risk low, not zero.',
            '',
            'To go ahead: og connect x-session --accept-x-risk',
            'You will be asked for two cookies: in a browser signed in to x.com, open',
            'DevTools > Application > Cookies > https://x.com and copy auth_token and ct0.',
          ].join('\n');
        }
        const authToken = await readSecret('auth_token cookie (input hidden): ');
        const ct0 = await readSecret('ct0 cookie (input hidden): ');
        if (!authToken || !ct0) throw new Error('both cookies are needed');
        const result = (await client.put('/integrations/x/session', {
          authToken,
          ct0,
          acknowledgeTerms: true,
        })) as { account?: { username?: string } };
        return `Connected X as @${result.account?.username ?? '?'} through your session. X cards will now send, paced. A different account adds to your pool: og senders.`;
      }

      if (network === 'linkedin') {
        if (flags['accept-linkedin-risk'] !== true) {
          return [
            'Automating LinkedIn is against its User Agreement and can get the account restricted.',
            'OutreachGraph paces every action minutes apart and caps each kind (20 invitations a day and 100 a week,',
            '60 profile visits, 30 follows, 25 messages, 25 comments) to keep that risk low, not zero.',
            'Every card still waits for your approval unless a campaign is on trusted automation.',
            '',
            'To go ahead: og connect linkedin --accept-linkedin-risk',
            'You will be asked for the li_at cookie: in a browser signed in to LinkedIn, open',
            'DevTools > Application > Cookies > https://www.linkedin.com and copy the li_at value.',
          ].join('\n');
        }
        const liAt = await readSecret('li_at cookie (input hidden): ');
        if (!liAt) throw new Error('no cookie entered');
        const result = (await client.put('/integrations/linkedin', {
          liAt,
          acknowledgeTerms: true,
        })) as { account?: { publicIdentifier?: string } };
        return `Connected LinkedIn as ${result.account?.publicIdentifier ?? '?'}. Approved LinkedIn comments, invitations, visits, follows and messages will now go out, paced. A different member adds to your pool: og senders.`;
      }

      throw new Error(`og connect ${CONNECTABLE.join(' | ')}`);
    },
  },
  {
    name: 'disconnect',
    usage: 'og disconnect x | linkedin | hubspot | pipedrive',
    summary: 'Remove every connected X account or LinkedIn session (one: og senders), or a CRM.',
    async run({ client, args }) {
      const network = args[0];
      if (!network || !(CONNECTABLE as readonly string[]).includes(network)) {
        throw new Error(`og disconnect ${CONNECTABLE.join(' | ')}`);
      }
      if (!client.delete) throw new Error('this client cannot disconnect');
      // Every X account in the pool, however each was connected. Removing
      // just one is `DELETE /senders/:id`.
      const path =
        network === 'x-session'
          ? 'x'
          : (CRMS as readonly string[]).includes(network)
            ? `crm/${network}`
            : network;
      const result = (await client.delete(`/integrations/${path}`)) as Record<string, unknown>;
      return result.disconnected
        ? `Disconnected ${network}.`
        : `No ${network} account was connected.`;
    },
  },
  {
    name: 'senders',
    usage:
      'og senders | og senders pause <id> | og senders resume <id> | og senders cap <id> <n|default> | og senders warmup <id> on|off | og senders label <id> <text> | og senders remove <id>',
    summary: 'Sending accounts: what each may send today, warm-up, pause and caps.',
    async run({ client, args }) {
      const [sub, id, value] = args;

      if (!sub) {
        const result = (await client.get('/senders')) as Record<string, unknown>;
        const list = rows(result, 'senders');
        if (list.length === 0) {
          return 'No sending accounts connected. og connect linkedin | og connect x-session, or add a mailbox in Settings.';
        }
        return list
          .map((sender) => {
            const warmup = sender.warmup as Record<string, unknown> | undefined;
            const warming =
              warmup?.enabled === true && warmup.complete !== true
                ? `  warm-up day ${text(warmup, 'day')}`
                : '';
            const name = text(sender, 'label') || text(sender, 'handle') || '?';
            const reason = text(sender, 'statusReason');
            return (
              `${text(sender, 'id')}  ${pad(text(sender, 'network'), 8)} ${pad(name, 28)} ` +
              `${pad(text(sender, 'status'), 7)} ` +
              `${text(sender, 'sentToday')}/${text(sender, 'effectiveCapToday')} today ` +
              `(cap ${text(sender, 'configuredCap')})${warming}` +
              (reason && text(sender, 'status') !== 'active' ? `  — ${reason}` : '')
            );
          })
          .join('\n');
      }

      if (!id) throw new Error(`og senders ${sub} <id>`);

      if (sub === 'remove') {
        if (!client.delete) throw new Error('this client cannot remove senders');
        await client.delete(`/senders/${id}`);
        return `Removed ${id}. Conversations it started move to the rest of the pool.`;
      }

      if (!client.patch) throw new Error('this client cannot change senders');

      let body: Record<string, unknown>;
      if (sub === 'pause') body = { paused: true };
      else if (sub === 'resume') body = { paused: false };
      else if (sub === 'cap') {
        if (value === 'default') body = { dailyCap: null };
        else {
          const cap = Number(value);
          if (!value || !Number.isInteger(cap) || cap < 0) {
            throw new Error('og senders cap <id> <n>, a whole number, or "default"');
          }
          body = { dailyCap: cap };
        }
      } else if (sub === 'warmup') {
        if (value !== 'on' && value !== 'off') throw new Error('og senders warmup <id> on|off');
        body = { warmup: value === 'on' };
      } else if (sub === 'label') {
        body = { label: args.slice(2).join(' ') || null };
      } else {
        throw new Error('og senders [pause|resume|cap|warmup|label|remove] <id> …');
      }

      const result = (await client.patch(`/senders/${id}`, body)) as {
        sender?: Record<string, unknown>;
      };
      const sender = result.sender ?? {};
      return (
        `${text(sender, 'id', id)} is ${text(sender, 'status', '?')}: ` +
        `${text(sender, 'sentToday', '0')}/${text(sender, 'effectiveCapToday', '?')} today, ` +
        `cap ${text(sender, 'configuredCap', '?')}.`
      );
    },
  },
  {
    name: 'mailboxes',
    usage:
      'og mailboxes | og mailboxes detect <email> | og mailboxes dns <id> | og mailboxes warmup <id> on|off | og mailboxes add <email> [--name "Jane"] [--cap 50] [--no-warmup]  (password prompted, or OG_MAILBOX_PASSWORD)',
    summary: 'The addresses outreach sends from: health, replies, DNS, and adding one.',
    async run({ client, args, flags }) {
      const [sub, arg] = args;

      if (!sub) {
        const result = (await client.get('/mailboxes')) as Record<string, unknown>;
        const list = rows(result, 'mailboxes');
        if (list.length === 0) {
          return 'No mailboxes yet. og mailboxes add you@company.com';
        }
        return list
          .map((mailbox) => {
            const replies = mailbox.readsReplies
              ? text(mailbox, 'repliesError')
                ? `replies FAILING: ${text(mailbox, 'repliesError')}`
                : 'replies read'
              : 'replies NOT read (no IMAP)';
            return (
              `${text(mailbox, 'id')}  ${pad(text(mailbox, 'fromEmail') || '?', 30)} ` +
              `${pad(text(mailbox, 'status'), 7)} health ${pad(text(mailbox, 'healthScore'), 3)} ` +
              `bounce ${pad(text(mailbox, 'bounceRisk'), 6)} ` +
              `${text(mailbox, 'sentToday')}/${text(mailbox, 'effectiveCapToday')} today  ${replies}`
            );
          })
          .join('\n');
      }

      if (sub === 'detect' || sub === 'add') {
        if (!arg) throw new Error(`og mailboxes ${sub} <email>`);
        const { detected } = (await client.post('/mailboxes/detect', { email: arg })) as {
          detected: {
            providerLabel: string;
            source: string;
            smtp: { host: string; port: number; secure: boolean };
            imap: { host: string; port: number } | null;
            note: string | null;
          };
        };
        const found =
          `${detected.providerLabel} (${detected.source}): sends via ${detected.smtp.host}:${detected.smtp.port}` +
          (detected.imap ? `, reads via ${detected.imap.host}:${detected.imap.port}` : '');
        if (sub === 'detect') return detected.note ? `${found}\n${detected.note}` : found;

        // From the environment or a hidden prompt, never a flag: a flag lands
        // in shell history.
        if (detected.note) process.stderr.write(`${detected.note}\n`);
        const password =
          process.env.OG_MAILBOX_PASSWORD ||
          (await readSecret(`password for ${arg} (input hidden): `));
        if (!password) throw new Error('no password entered');

        const name = flagString(flags, 'name');
        const result = (await client.put('/integrations/email', {
          host: detected.smtp.host,
          port: detected.smtp.port,
          secure: detected.smtp.secure,
          username: arg,
          password,
          fromEmail: arg,
          ...(name ? { fromName: name } : {}),
          ...(detected.imap
            ? { imapHost: detected.imap.host, imapPort: detected.imap.port, imapSecure: true }
            : {}),
        })) as { account?: { accountId?: string } };

        const id = result.account?.accountId;
        const cap = Number(flagString(flags, 'cap'));
        if (id && client.patch) {
          await client.patch(`/senders/${id}`, {
            ...(Number.isInteger(cap) && cap >= 0 ? { dailyCap: cap } : {}),
            warmup: flags['no-warmup'] !== true,
          });
        }
        return `Connected ${arg} (${id ?? '?'}). ${found}. Check its domain: og mailboxes dns ${id ?? '<id>'}`;
      }

      if (sub === 'dns') {
        if (!arg) throw new Error('og mailboxes dns <id>');
        const { dns } = (await client.get(`/mailboxes/${encodeURIComponent(arg)}/dns`)) as {
          dns: Record<string, unknown>;
        };
        return [
          `${text(dns, 'domain')}: ${text(dns, 'status')}`,
          ...['spf', 'dkim', 'dmarc', 'mx', 'blacklist']
            .filter((key) => dns[key] !== undefined)
            .map((key) => {
              const check = (dns[key] ?? {}) as Record<string, unknown>;
              const label = key === 'blacklist' ? 'BL' : key.toUpperCase();
              return `  ${pad(label, 6)} ${pad(text(check, 'status'), 5)} ${text(check, 'detail')}`;
            }),
        ].join('\n');
      }

      if (sub === 'warmup') {
        const value = args[2];
        if (!arg || (value !== 'on' && value !== 'off')) {
          throw new Error('og mailboxes warmup <id> on|off');
        }
        if (!client.patch) throw new Error('this client cannot change mailboxes');
        await client.patch(`/senders/${encodeURIComponent(arg)}`, {
          warmupNetwork: value === 'on',
        });
        const result = (await client.get('/mailboxes')) as Record<string, unknown>;
        const mailbox = rows(result, 'mailboxes').find((m) => text(m, 'id') === arg) ?? {};
        const warm = (mailbox.warmupNetwork ?? {}) as Record<string, unknown>;
        if (value === 'off') return `Warm-up network off for ${arg}.`;
        return (
          `Warm-up network on for ${text(mailbox, 'fromEmail', arg)}. ` +
          `Filter tag: ${text(warm, 'tag', '?')} (Gmail: Has the words "${text(warm, 'tag', '?')}", Skip the Inbox).` +
          (Number(warm.peers ?? 0) === 0
            ? ' No other mailbox is in the network yet; add a second one.'
            : '')
        );
      }

      throw new Error('og mailboxes [detect|dns|add|warmup] …');
    },
  },
  {
    name: 'inbox',
    usage:
      'og inbox [--filter need_reply|replied|sent|all] [--label <label>] | og inbox show <personId> | og inbox reply <personId> "text"',
    summary: 'Every conversation, what each reply was labelled, and answering one.',
    async run({ client, args, flags }) {
      const [sub, personId, ...rest] = args;

      if (sub === 'show') {
        if (!personId) throw new Error('a person id is required: og inbox show <personId>');
        return renderThread((await client.get(`/inbox/${personId}`)) as Record<string, unknown>);
      }

      if (sub === 'reply') {
        const message = rest.join(' ').trim() || flagString(flags, 'text');
        if (!personId || !message) {
          throw new Error('usage: og inbox reply <personId> "what to say"');
        }
        const result = (await client.post(`/inbox/${personId}/reply`, {
          text: message,
          ...(flagString(flags, 'subject') ? { subject: flagString(flags, 'subject') } : {}),
        })) as Record<string, unknown>;

        // Sending is the outcome that matters; "approved but not sent" must
        // not read like success in a terminal any more than on a card.
        return result.sent
          ? `Sent to ${text(result, 'to')} — ${text(result, 'subject')}`
          : `Not sent: ${text(result, 'reason', text(result, 'note', 'unknown reason'))}`;
      }

      if (sub !== undefined && sub !== 'list') {
        throw new Error(`unknown inbox command "${sub}": use show or reply`);
      }

      const result = await client.get('/inbox', {
        filter: flagString(flags, 'filter') ?? 'all',
        ...(flagString(flags, 'label') ? { label: flagString(flags, 'label') } : {}),
        limit: flagString(flags, 'limit') ?? '25',
      });
      const conversations = rows(result, 'conversations');
      if (conversations.length === 0) return 'No conversations here yet.';

      return conversations
        .map((conv) => {
          const label = conv.label as { label?: string; confidence?: number } | null;
          return [
            pad(text(conv, 'person_id'), 22),
            pad(text(conv, 'status'), 11),
            pad(label?.label ?? '-', 20),
            pad(conv.pending_reply_id ? 'draft' : '', 6),
            text(conv, 'name'),
          ].join(' ');
        })
        .join('\n');
    },
  },
  {
    name: 'ideas',
    usage:
      'og ideas list [--status build] | show <id> | scan [--subs a,b] | build <id> | dismiss <id> | subs [a b c]',
    summary: 'What people keep asking for on Reddit, ranked; build one with chovy.com.',
    run: runIdeas,
  },
  {
    name: 'audience',
    usage:
      'og audience list | watch <network:handle | url> [--campaign <id>] [--kinds follow,like] [--every <minutes>] | unwatch <id> | run <id>',
    summary: 'Turn the people who engage with your own accounts into prospects.',
    run: runAudience,
  },
  {
    name: 'jobs',
    usage:
      'og jobs list [--status s] | search "<keyword>" [--boards a,b] [--limit n] | add <url…> [--campaign <id>] | show <id> | resolve <id> | promote <id> <contactId> [--campaign <id>] | status <id> <status> | note <id> <text> | rm <id>',
    summary: 'Job postings by URL or keyword, and the real people behind each one.',
    run: runJobs,
  },
  {
    name: 'leads',
    usage:
      'og leads add <campaignId> <file.csv> --consent-source "<where>" [--allow-flagged] [--keep-project-duplicates] [--report out.csv] | report <taskId> [--csv] | screened <campaignId> [--all] | enrich <campaignId> [--max <searches>] | enrichment <campaignId> | health <campaignId> | accounts <campaignId> | allow <personId> | hold <personId>',
    summary: 'Add a CSV of leads to a running campaign, with a per-row report and screening.',
    run: runLeads,
  },
  {
    name: 'webhooks',
    usage:
      'og webhooks list | add <https-url> [--slack] [--events a,b] | rm <id> | test <id> | deliveries [id]',
    summary: 'Send events to Slack, Zapier, Make, n8n or your own endpoint.',
    run: runWebhooks,
  },
  {
    name: 'status',
    usage: 'og status',
    summary: 'What the pipeline is doing right now.',
    async run({ client }) {
      const result = (await client.get('/status')) as Record<string, unknown>;
      return JSON.stringify(result, null, 2);
    },
  },
];

/**
 * Repeated flags collect into a list.
 *
 * `--ask a --ask b` is how a shell expresses a list without inventing a
 * delimiter that will eventually appear inside a question.
 */
function asList(value: string | boolean | readonly string[] | undefined): readonly string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export function commandByName(name: string): Command | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function usage(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length)) + 2;

  return [
    'og — OutreachGraph from the terminal',
    '',
    'Usage: og <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((command) => `  ${pad(command.name, width)}${command.summary}`),
    '',
    'Configuration, from the environment:',
    '  OUTREACHGRAPH_API_URL           https://api.outreachgraph.com',
    '  OUTREACHGRAPH_API_TOKEN         a service token',
    '  OUTREACHGRAPH_WORKSPACE_ID      wsp_…',
    '  OUTREACHGRAPH_ORGANIZATION_ID   org_…',
  ].join('\n');
}
