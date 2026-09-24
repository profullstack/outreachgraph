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

const CONNECTABLE = ['x', 'x-session', 'linkedin'] as const;

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
      'og connect x-session --accept-x-risk | og connect linkedin --accept-linkedin-risk | og connect x',
    summary:
      'Connect X or LinkedIn through your browser session (free), or X over OAuth 2.1 (paid API).',
    async run({ client, args, flags }) {
      const network = args[0];
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
        return `Connected X as @${result.account?.username ?? '?'} through your session. X cards will now send, paced.`;
      }

      if (network === 'linkedin') {
        if (flags['accept-linkedin-risk'] !== true) {
          return [
            'Automating LinkedIn is against its User Agreement and can get the account restricted.',
            'OutreachGraph paces comments (about 25 a day, minutes apart) to keep that risk low, not zero.',
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
        return `Connected LinkedIn as ${result.account?.publicIdentifier ?? '?'}. LinkedIn comments will now send, paced.`;
      }

      throw new Error(`og connect ${CONNECTABLE.join(' | ')}`);
    },
  },
  {
    name: 'disconnect',
    usage: 'og disconnect x | og disconnect linkedin',
    summary: 'Remove a connected X account or LinkedIn session.',
    async run({ client, args }) {
      const network = args[0];
      if (!network || !(CONNECTABLE as readonly string[]).includes(network)) {
        throw new Error(`og disconnect ${CONNECTABLE.join(' | ')}`);
      }
      if (!client.delete) throw new Error('this client cannot disconnect');
      // One X account per workspace, however it was connected.
      const path = network === 'x-session' ? 'x' : network;
      const result = (await client.delete(`/integrations/${path}`)) as Record<string, unknown>;
      return result.disconnected
        ? `Disconnected ${network}.`
        : `No ${network} account was connected.`;
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
