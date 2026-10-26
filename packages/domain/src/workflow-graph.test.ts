import { describe, expect, test } from 'bun:test';
import {
  applySettings,
  buildWorkflowPlan,
  compileWorkflow,
  describeSchedule,
  ENGINEERING_CONTRACT_TEMPLATE,
  nextWorkflowRunAt,
  settingsOf,
  topologicalOrder,
  validateWorkflowDefinition,
  workflowTemplate,
  type WorkflowDefinition,
  type WorkflowNode,
} from './workflow-graph';
import { interpretWorkflowPrompt } from './workflow';

const TEMPLATE = ENGINEERING_CONTRACT_TEMPLATE.definition;

function withNodes(nodes: readonly Partial<WorkflowNode>[]): unknown {
  return { ...TEMPLATE, nodes };
}

function errorsOf(raw: unknown): readonly string[] {
  const result = validateWorkflowDefinition(raw);
  return result.ok ? [] : result.errors;
}

describe('validateWorkflowDefinition', () => {
  test('the template is valid and unchanged by validation', () => {
    const result = validateWorkflowDefinition(TEMPLATE);
    expect(result).toEqual({ ok: true, definition: TEMPLATE, warnings: [] });
  });

  test('refuses an unknown action rather than improvising one', () => {
    const errors = errorsOf(
      withNodes([...TEMPLATE.nodes, { id: 'shell', type: 'run_code' as never, after: [] }]),
    );
    expect(errors).toEqual(['shell: unknown action “run_code”']);
  });

  test('refuses a cycle', () => {
    const nodes = TEMPLATE.nodes.map((n) => (n.id === 'enrich' ? { ...n, after: ['crm'] } : n));
    expect(errorsOf(withNodes(nodes))).toEqual([
      'the steps form a cycle; a workflow must always move forward',
    ]);
  });

  test('refuses a send that skips de-duplication or approval', () => {
    const nodes = TEMPLATE.nodes
      .filter((n) => n.id !== 'dedupe' && n.id !== 'approve')
      .map((n) =>
        n.id === 'draft'
          ? { ...n, after: ['score'] }
          : n.id === 'send'
            ? { ...n, after: ['draft'] }
            : n,
      );
    expect(errorsOf(withNodes(nodes))[0]).toBe(
      'every send must come after “De-duplicate”, “Approval”',
    );
  });

  test('refuses dangling references, duplicate ids and reply conditions without a branch', () => {
    const errors = errorsOf(
      withNodes([
        { id: 'discover-1', type: 'discover_opportunities', after: [], config: { query: 'x' } },
        { id: 'discover-1', type: 'enrich', after: [] },
        { id: 'notify', type: 'notify', after: ['ghost'], when: ['interested'] },
      ]),
    );
    expect(errors).toEqual([
      'discover-1: the id is used twice',
      'notify: follows “ghost”, which does not exist',
      'notify: reply conditions need a branch step before it',
    ]);
  });

  test('clamps node inputs and keeps verification on', () => {
    const nodes = TEMPLATE.nodes.map((n) =>
      n.type === 'send'
        ? { ...n, config: { dailyLimit: 50_000, maxPerAddressPerWeek: 0, extra: 'drop me' } }
        : n.type === 'verify_contact'
          ? { ...n, config: { requireVerified: false } }
          : n,
    );
    const result = validateWorkflowDefinition(withNodes(nodes));
    if (!result.ok) throw new Error(result.errors.join('; '));
    const by = (type: string) => result.definition.nodes.find((n) => n.type === type)!.config;
    expect(by('send')).toEqual({ channel: 'email', dailyLimit: 1_000, maxPerAddressPerWeek: 1 });
    expect(by('verify_contact')).toEqual({ requireVerified: true, allowSharedInbox: false });
  });

  test('a research-only workflow is allowed and says so', () => {
    const nodes = TEMPLATE.nodes.filter(
      (n) => !['send', 'wait', 'classify', 'route', 'notify', 'crm'].includes(n.id),
    );
    const result = validateWorkflowDefinition(withNodes(nodes));
    expect(result.ok && result.warnings[0]).toContain('never sends');
  });
});

describe('settings and definitions', () => {
  test('compile and read back are inverse', () => {
    const settings = settingsOf(TEMPLATE);
    expect(compileWorkflow(settings)).toEqual(TEMPLATE);
  });

  test('applying an English edit keeps the person’s own node edits and ids', () => {
    const customised: WorkflowDefinition = {
      ...TEMPLATE,
      nodes: TEMPLATE.nodes.map((n) =>
        n.id === 'wait' ? { ...n, label: 'Give them a week', config: { days: 7 } } : n,
      ),
    };
    const edit = interpretWorkflowPrompt(
      'Make it 60 a day and also search job boards for companies hiring a golang engineer. Drop Remote-first US startups hiring engineers.',
      settingsOf(customised),
    );
    const next = applySettings(customised, edit.spec);
    const result = validateWorkflowDefinition(next);
    if (!result.ok) throw new Error(result.errors.join('; '));

    const wait = next.nodes.find((n) => n.id === 'wait')!;
    expect(wait).toMatchObject({ label: 'Give them a week', config: { days: 7 } });
    expect(next.nodes.find((n) => n.type === 'send')!.config.dailyLimit).toBe(60);
    const discover = next.nodes.filter((n) => n.type === 'discover_opportunities');
    expect(discover.map((n) => n.id)).toEqual([
      'discover-1',
      'discover-2',
      'discover-3',
      'discover-5',
    ]);
    expect(discover.at(-1)!.config.query).toBe('golang engineer');
    expect(next.nodes.find((n) => n.id === 'enrich')!.after).toEqual([
      'discover-1',
      'discover-2',
      'discover-3',
      'discover-5',
    ]);
  });
});

describe('buildWorkflowPlan', () => {
  test('a trigger, then every step in dependency order', () => {
    const plan = buildWorkflowPlan(TEMPLATE);
    expect(plan[0]!.type).toBe('trigger');
    expect(plan.map((s) => s.id).slice(1)).toEqual(topologicalOrder(TEMPLATE.nodes)!);
    const send = plan.find((s) => s.type === 'send')!;
    expect(send.detail).toContain('Up to 200 a day');
    expect(send.detail).toContain('never a target');
    expect(send.sideEffect).toBe(true);
  });

  test('says when the workspace ceiling is below the asked-for limit, and what skips', () => {
    const plan = buildWorkflowPlan(TEMPLATE, {
      workspaceDailyCap: 25,
      jobSearchEnabled: false,
      crmConnected: false,
    });
    const send = plan.find((s) => s.type === 'send')!;
    expect(send.detail).toContain('Up to 25 a day (asked for 200)');
    expect(send.warnings[0]).toContain('at most 25');
    expect(plan.filter((s) => s.warnings.some((w) => w.includes('skips')))).toHaveLength(3);
  });
});

describe('nextWorkflowRunAt', () => {
  const weekdays8 = {
    kind: 'weekdays',
    hour: 8,
    minute: 0,
    timezone: 'America/Los_Angeles',
  } as const;

  test('08:00 in Los Angeles is 15:00 UTC in summer and 16:00 UTC in winter', () => {
    expect(nextWorkflowRunAt(weekdays8, new Date('2026-07-01T00:00:00Z'))?.toISOString()).toBe(
      '2026-07-01T15:00:00.000Z',
    );
    expect(nextWorkflowRunAt(weekdays8, new Date('2026-12-01T00:00:00Z'))?.toISOString()).toBe(
      '2026-12-01T16:00:00.000Z',
    );
  });

  test('across the November DST change, the local hour holds', () => {
    // Friday 30 Oct 2026, after the run: next is Monday 2 Nov, after PDT ends.
    expect(nextWorkflowRunAt(weekdays8, new Date('2026-10-30T18:00:00Z'))?.toISOString()).toBe(
      '2026-11-02T16:00:00.000Z',
    );
  });

  test('the local date decides the weekday, not the UTC one', () => {
    // 01:00 UTC Saturday is still Friday evening in Los Angeles; Friday's 08:00 has passed.
    expect(nextWorkflowRunAt(weekdays8, new Date('2026-10-24T01:00:00Z'))?.toISOString()).toBe(
      '2026-10-26T15:00:00.000Z',
    );
  });

  test('weekly lands on its day; manual and event never', () => {
    const at = new Date('2026-10-22T12:00:00Z');
    expect(
      nextWorkflowRunAt(
        { kind: 'weekly', hour: 9, minute: 0, timezone: 'UTC', weekday: 1 },
        at,
      )?.toISOString(),
    ).toBe('2026-10-26T09:00:00.000Z');
    expect(
      nextWorkflowRunAt({ kind: 'manual', hour: 9, minute: 0, timezone: 'UTC' }, at),
    ).toBeNull();
    expect(
      nextWorkflowRunAt(
        { kind: 'event', hour: 9, minute: 0, timezone: 'UTC', event: 'reply_received' },
        at,
      ),
    ).toBeNull();
  });

  test('strictly after: a run at its slot is next due the following day', () => {
    const daily = { kind: 'daily', hour: 15, minute: 0, timezone: 'UTC' } as const;
    expect(nextWorkflowRunAt(daily, new Date('2026-10-22T15:00:00Z'))?.toISOString()).toBe(
      '2026-10-23T15:00:00.000Z',
    );
  });

  test('describes itself', () => {
    expect(describeSchedule(weekdays8)).toBe('Every weekday at 08:00 America/Los_Angeles');
  });
});

test('the template is found by id and asks for 200 a day, approved', () => {
  const template = workflowTemplate('engineering-contract-acquisition')!;
  const settings = settingsOf(template.definition);
  expect(settings.outreach).toMatchObject({ dailyLimit: 200, approval: 'review' });
  expect(workflowTemplate('nope')).toBeUndefined();
});
