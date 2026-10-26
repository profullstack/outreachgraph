/**
 * `og workflow*` — custom workflows from a terminal (PRD-ECO §14).
 *
 * A client of `/api/v1/workflows` and nothing else: list, inspect, create from
 * English or a template, edit in English, dry-run, publish, run, pause,
 * resume, read run logs, cancel, export and import. There is no faster path
 * here than the web app has — every run happens server-side, where the policy
 * engine is.
 */

import type { Command, CommandContext } from './commands';

function text(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function rows(value: unknown, key: string): readonly Record<string, unknown>[] {
  const list = (value as Record<string, unknown>)[key];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

function flagString(flags: CommandContext['flags'], key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function object(value: unknown, key: string): Record<string, unknown> {
  const inner = (value as Record<string, unknown>)[key];
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : {};
}

function idArg(args: readonly string[], usage: string): string {
  const id = args[0];
  if (!id) throw new Error(`usage: ${usage}`);
  return encodeURIComponent(id);
}

/** A workflow plan, one step per line, in dependency order. */
export function renderPlan(plan: readonly Record<string, unknown>[]): string {
  return plan
    .map((step, index) => {
      const warnings = Array.isArray(step.warnings) ? (step.warnings as string[]) : [];
      const when = Array.isArray(step.when) ? ` [on ${(step.when as string[]).join('/')}]` : '';
      return [
        `${String(index).padStart(2)}. ${text(step, 'title')}${when}`,
        `    ${text(step, 'detail')}`,
        ...warnings.map((w) => `    ! ${w}`),
      ].join('\n');
    })
    .join('\n');
}

function runLine(run: Record<string, unknown>): string {
  return [
    pad(text(run, 'id'), 30),
    pad(text(run, 'trigger'), 9),
    pad(text(run, 'status'), 16),
    pad(`try ${text(run, 'attempt', '1')}`, 6),
    text(run, 'startedAt'),
  ].join(' ');
}

/** One run's per-step log: what happened at each step, and why. */
export function renderRun(run: Record<string, unknown>): string {
  return [
    `Run ${text(run, 'runId', text(run, 'id'))}: ${text(run, 'status')}${
      run.retryAt ? ` (retry at ${text(run, 'retryAt')})` : ''
    }`,
    ...rows(run, 'steps').map(
      (s) => `  ${pad(text(s, 'status'), 9)} ${pad(text(s, 'id'), 12)} ${text(s, 'detail')}`,
    ),
    ...(run.error ? ['', `Errors:\n${text(run, 'error')}`] : []),
  ].join('\n');
}

export const WORKFLOW_COMMANDS: readonly Command[] = [
  {
    name: 'workflows',
    usage: 'og workflows [--archived]',
    summary: 'Saved workflows: state, version, last run, failures this week.',
    async run({ client, flags }) {
      const result = await client.get(
        '/workflows',
        flags.archived === true ? { archived: '1' } : {},
      );
      const list = rows(result, 'workflows');
      if (list.length === 0) {
        return 'No workflows yet. Try: og workflow-create --template engineering-contract-acquisition';
      }
      return list
        .map((w) =>
          [
            pad(text(w, 'id'), 30),
            pad(text(w, 'status'), 8),
            pad(`v${text(w, 'publishedVersion', '-')}/${text(w, 'version')}`, 8),
            pad(text(w, 'lastRunStatus', 'never run'), 16),
            pad(`${text(w, 'failuresThisWeek', '0')} failed`, 10),
            text(w, 'name'),
          ].join(' '),
        )
        .join('\n');
    },
  },
  {
    name: 'workflow',
    usage: 'og workflow <id> [--json]',
    summary: 'One workflow: its step plan, schedule and recent runs.',
    async run({ client, args, flags }) {
      const result = await client.get(`/workflows/${idArg(args, 'og workflow <id>')}`);
      if (flags.json === true) return JSON.stringify(result, null, 2);
      const w = object(result, 'workflow');
      return [
        `${text(w, 'name')} — ${text(w, 'status')}, v${text(w, 'publishedVersion', '-')} published, v${text(w, 'version')} current`,
        `${text(w, 'schedule')} · next run ${text(w, 'nextRunAt', '—')}`,
        '',
        renderPlan(rows(w, 'plan')),
        '',
        'Recent runs:',
        ...(rows(result, 'runs').length ? rows(result, 'runs').map(runLine) : ['  none']),
      ].join('\n');
    },
  },
  {
    name: 'workflow-create',
    usage: 'og workflow-create "<plain-English description>" | --template <id> [--name <name>]',
    summary: 'Create a draft workflow from English or a template, and print its plan.',
    async run({ client, args, flags }) {
      const prompt = args.join(' ').trim();
      const templateId = flagString(flags, 'template');
      if (!prompt && !templateId) {
        throw new Error(
          'describe it, or use a template: og workflow-create --template engineering-contract-acquisition',
        );
      }
      const result = await client.post('/workflows', {
        ...(prompt ? { prompt } : {}),
        ...(templateId ? { templateId } : {}),
        ...(flagString(flags, 'name') ? { name: flagString(flags, 'name') } : {}),
      });
      const w = object(result, 'workflow');
      return [
        `Created ${text(w, 'id')} — “${text(w, 'name')}” (a draft: nothing runs until you publish)`,
        '',
        renderPlan(rows(w, 'plan')),
        '',
        `Next: og workflow-dry-run ${text(w, 'id')}, then og workflow-publish ${text(w, 'id')}`,
      ].join('\n');
    },
  },
  {
    name: 'workflow-edit',
    usage: 'og workflow-edit <id> "<change in plain English>"',
    summary: 'Change a workflow in English ("make it 100 a day, add Canada"): a new version.',
    async run({ client, args }) {
      const [id, ...rest] = args;
      const instruction = rest.join(' ').trim();
      if (!id || !instruction) throw new Error('usage: og workflow-edit <id> "<change>"');
      if (!client.patch) throw new Error('this client cannot edit');
      const result = await client.patch(`/workflows/${encodeURIComponent(id)}`, { instruction });
      const w = object(result, 'workflow');
      return [
        `v${text(w, 'version')} saved (read by ${text(result as Record<string, unknown>, 'interpretedBy', 'rules')}); v${text(w, 'publishedVersion', '-')} is still the one that runs.`,
        '',
        renderPlan(rows(w, 'plan')),
        '',
        `Publish it: og workflow-publish ${id}`,
      ].join('\n');
    },
  },
  {
    name: 'workflow-dry-run',
    usage: 'og workflow-dry-run <id> [--json]',
    summary: 'Preview a run: matched jobs, contacts, send / no-send per person. Sends nothing.',
    async run({ client, args, flags }) {
      const result = await client.post(
        `/workflows/${idArg(args, 'og workflow-dry-run <id>')}/dry-run`,
        {},
      );
      if (flags.json === true) return JSON.stringify(result, null, 2);
      const p = object(result, 'preview');
      const estimate = object(p, 'estimate');
      const policy = object(p, 'policy');
      return [
        `Dry run ${text(p, 'runId')}: nothing was sent.`,
        `Cap ${text(estimate, 'effectiveDailyCap')}/day (asked ${text(estimate, 'dailyLimit')}), ${text(estimate, 'sentToday')} sent today. Policy engine: ${text(policy, 'decision')} (${text(policy, 'reason')})`,
        '',
        'Checks:',
        ...rows(p, 'checks').map(
          (c) => `  ${pad(text(c, 'status'), 8)} ${text(c, 'title')}: ${text(c, 'detail')}`,
        ),
        '',
        'Matched jobs:',
        ...(rows(p, 'jobs').length
          ? rows(p, 'jobs').map(
              (j) => `  ${text(j, 'title', '?')} at ${text(j, 'company', '?')}  ${text(j, 'url')}`,
            )
          : ['  none yet']),
        '',
        'People:',
        ...(rows(p, 'candidates').length
          ? rows(p, 'candidates').map(
              (c) =>
                `  ${pad(text(c, 'decision'), 19)} ${text(c, 'name')} <${text(c, 'address', 'no address')}>: ${text(c, 'reason')}`,
            )
          : ['  none in the campaign yet']),
      ].join('\n');
    },
  },
  {
    name: 'workflow-publish',
    usage: 'og workflow-publish <id>',
    summary: 'Publish the current version and switch the workflow on.',
    async run({ client, args }) {
      const result = await client.post(
        `/workflows/${idArg(args, 'og workflow-publish <id>')}/publish`,
        {},
      );
      const w = object(result, 'workflow');
      return `Published v${text(w, 'publishedVersion')}. ${text(w, 'schedule')}; next run ${text(w, 'nextRunAt', 'when triggered')}.`;
    },
  },
  {
    name: 'workflow-run',
    usage: 'og workflow-run <id>',
    summary: 'Run the published version now and print the per-step log.',
    async run({ client, args }) {
      const result = await client.post(`/workflows/${idArg(args, 'og workflow-run <id>')}/run`, {});
      return renderRun(object(result, 'run'));
    },
  },
  {
    name: 'workflow-pause',
    usage: 'og workflow-pause <id>',
    summary: 'Stop the scheduled runs and the campaign’s sending.',
    async run({ client, args }) {
      const id = idArg(args, 'og workflow-pause <id>');
      await client.post(`/workflows/${id}/pause`, {});
      return `Paused. Nothing more runs or sends until og workflow-resume ${args[0]}.`;
    },
  },
  {
    name: 'workflow-resume',
    usage: 'og workflow-resume <id>',
    summary: 'Resume a paused workflow on its schedule.',
    async run({ client, args }) {
      const result = await client.post(
        `/workflows/${idArg(args, 'og workflow-resume <id>')}/resume`,
        {},
      );
      return `Resumed; next run ${text(object(result, 'workflow'), 'nextRunAt', 'when triggered')}.`;
    },
  },
  {
    name: 'workflow-runs',
    usage: 'og workflow-runs <id> [<runId>]',
    summary: 'Run history, or one run’s per-step log and errors.',
    async run({ client, args }) {
      const id = idArg(args, 'og workflow-runs <id> [<runId>]');
      const runId = args[1];
      if (runId) {
        const result = await client.get(`/workflows/${id}/runs/${encodeURIComponent(runId)}`);
        return renderRun(object(result, 'run'));
      }
      const list = rows(await client.get(`/workflows/${id}/runs`), 'runs');
      return list.length ? list.map(runLine).join('\n') : 'No runs yet.';
    },
  },
  {
    name: 'workflow-cancel',
    usage: 'og workflow-cancel <id> <runId>',
    summary: 'Cancel a running run or a pending retry.',
    async run({ client, args }) {
      const [id, runId] = args;
      if (!id || !runId) throw new Error('usage: og workflow-cancel <id> <runId>');
      await client.post(
        `/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/cancel`,
        {},
      );
      return `Cancelled ${runId}.`;
    },
  },
  {
    name: 'workflow-export',
    usage: 'og workflow-export <id> > workflow.json',
    summary: 'Print a workflow as JSON, for og workflow-import.',
    async run({ client, args }) {
      const result = await client.get(
        `/workflows/${idArg(args, 'og workflow-export <id>')}/export`,
      );
      return JSON.stringify(result, null, 2);
    },
  },
  {
    name: 'workflow-import',
    usage: 'og workflow-import <file.json> [--name <name>]',
    summary: 'Create a draft workflow from an exported file.',
    async run({ client, args, flags }) {
      const file = args[0];
      if (!file) throw new Error('usage: og workflow-import <file.json>');
      const parsed = JSON.parse((await import('node:fs')).readFileSync(file, 'utf8')) as Record<
        string,
        unknown
      >;
      const result = await client.post('/workflows/import', {
        name: flagString(flags, 'name') ?? text(parsed, 'name', 'Imported workflow'),
        ...(typeof parsed.prompt === 'string' ? { prompt: parsed.prompt } : {}),
        definition: parsed.definition,
      });
      return `Imported as ${text(object(result, 'workflow'), 'id')} (a draft).`;
    },
  },
];
