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
