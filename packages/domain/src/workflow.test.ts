import { describe, expect, test } from 'bun:test';
import { ENGINEERING_CONTRACT_TEMPLATE, settingsOf } from './workflow-graph';
import { interpretWorkflowPrompt, normaliseWorkflowSettings } from './workflow';

const TEMPLATE = settingsOf(ENGINEERING_CONTRACT_TEMPLATE.definition);

describe('interpretWorkflowPrompt', () => {
  test('reads a whole workflow out of one paragraph', () => {
    const { spec } = interpretWorkflowPrompt(
      'Find fintech startups that are hiring backend engineers. Search job boards for ' +
        'companies hiring a rust engineer and a platform engineer. Email the CTO or VP of ' +
        'Engineering at companies with 20 to 200 employees in Canada. Not agencies. ' +
        'Send up to 120 emails per day with my approval, every weekday at 9:30am ET.',
    );

    expect(spec.sources).toEqual([
      { kind: 'job_posts', query: 'rust engineer', limit: 100 },
      { kind: 'job_posts', query: 'platform engineer', limit: 100 },
      { kind: 'discover', query: 'fintech startups that are hiring backend engineers' },
    ]);
    expect(spec.targeting.titles).toEqual(['CTO', 'VP of Engineering']);
    expect(spec.targeting.industries).toEqual(['Fintech']);
    expect(spec.targeting.countries).toEqual(['Canada']);
    expect(spec.targeting.employeeCountMin).toBe(20);
    expect(spec.targeting.employeeCountMax).toBe(200);
    expect(spec.targeting.exclusions).toEqual(['agencies']);
    expect(spec.outreach.dailyLimit).toBe(120);
    expect(spec.outreach.approval).toBe('review');
    expect(spec.schedule).toEqual({
      kind: 'weekdays',
      hour: 9,
      minute: 30,
      timezone: 'America/New_York',
    });
  });

  test('several markets joined by "and" are several searches', () => {
    const { spec } = interpretWorkflowPrompt(
      'Find Bay Area software companies hiring engineers and remote-first US startups.',
    );
    expect(spec.sources).toEqual([
      { kind: 'discover', query: 'Bay Area software companies hiring engineers' },
      { kind: 'discover', query: 'remote-first US startups' },
    ]);
  });

  test('an excluded kind of company is never read as a search', () => {
    const { spec } = interpretWorkflowPrompt('Find SaaS startups. Not recruiting agencies.');
    expect(spec.sources).toEqual([{ kind: 'discover', query: 'SaaS startups' }]);
    expect(spec.targeting.exclusions).toEqual(['recruiting agencies']);
  });

  test('autopilot only when asked for in so many words', () => {
    expect(interpretWorkflowPrompt('Find SaaS companies.').spec.outreach.approval).toBe('review');
    expect(
      interpretWorkflowPrompt('Find SaaS companies and send automatically.').spec.outreach.approval,
    ).toBe('autopilot');
  });

  test('a reply can be the trigger', () => {
    const { spec } = interpretWorkflowPrompt('Find SaaS companies. Run whenever someone replies.');
    expect(spec.schedule.kind).toBe('event');
    expect(spec.schedule.event).toBe('reply_received');
  });

  test('caps the daily limit and says so', () => {
    const { spec, notes } = interpretWorkflowPrompt('Find dentists. 5,000 emails a day.');
    expect(spec.outreach.dailyLimit).toBe(1_000);
    expect(notes.join(' ')).toContain('capped');
  });

  test('falls back to the first sentence as the search', () => {
    const { spec, notes } = interpretWorkflowPrompt('Dental clinics in Ohio');
    expect(spec.sources).toEqual([{ kind: 'discover', query: 'Dental clinics in Ohio' }]);
    expect(notes.length).toBeGreaterThan(0);
  });

  test('an edit changes only what it mentions', () => {
    const { spec } = interpretWorkflowPrompt(
      'Make it 100 emails a day, add Germany and Canada, remove the United States. ' +
        'Run every Monday at 14:00.',
      TEMPLATE,
    );

    expect(spec.outreach.dailyLimit).toBe(100);
    expect(spec.targeting.countries).toEqual(['Canada', 'Germany']);
    expect(spec.schedule).toMatchObject({ kind: 'weekly', hour: 14, weekday: 1 });
    expect(spec.schedule.timezone).toBe('America/Los_Angeles');
    expect(spec.targeting.titles).toEqual(TEMPLATE.targeting.titles);
    expect(spec.sources).toEqual(TEMPLATE.sources);
    expect(spec.goal).toBe(TEMPLATE.goal);
  });

  test('an edit can drop the job-board sources', () => {
    const { spec } = interpretWorkflowPrompt('drop the job boards', TEMPLATE);
    expect(spec.sources.every((s) => s.kind === 'discover')).toBe(true);
  });

  test('reads the template prompt back into the template’s choices', () => {
    const { spec } = interpretWorkflowPrompt(ENGINEERING_CONTRACT_TEMPLATE.prompt);
    expect(spec.sources).toEqual(TEMPLATE.sources);
    expect(spec.outreach).toEqual(TEMPLATE.outreach);
    expect(spec.schedule).toEqual(TEMPLATE.schedule);
    expect(spec.targeting.countries).toEqual(['United States']);
    expect(spec.targeting.employeeCountMin).toBe(10);
    expect(spec.targeting.employeeCountMax).toBe(1000);
    expect([...spec.targeting.titles].sort()).toEqual([...TEMPLATE.targeting.titles].sort());
    expect(spec.targeting.exclusions).toEqual(TEMPLATE.targeting.exclusions);
  });
});

describe('normaliseWorkflowSettings', () => {
  test('refuses a workflow with nowhere to find people', () => {
    expect(normaliseWorkflowSettings({ sources: [] }).ok).toBe(false);
  });

  test('clamps, trims, de-duplicates and swaps a reversed range', () => {
    const result = normaliseWorkflowSettings({
      sources: [
        { kind: 'discover', query: '  shopify.com   agencies ' },
        { kind: 'discover', query: 'shopify com agencies' },
        { kind: 'job_posts', query: 'rust', limit: 900 },
        { kind: 'nope', query: 'x' },
      ],
      targeting: { titles: ['CTO', 'cto', ' '], employeeCountMin: 500, employeeCountMax: 10 },
      outreach: { dailyLimit: 9_999, approval: 'yolo' },
      schedule: { kind: 'weekly', hour: 40, timezone: 'Mars/Olympus' },
    });
    if (!result.ok) throw new Error(result.error);

    expect(result.spec.sources).toEqual([
      { kind: 'discover', query: 'shopify com agencies' },
      { kind: 'job_posts', query: 'rust', limit: 200 },
    ]);
    expect(result.spec.targeting.titles).toEqual(['CTO']);
    expect(result.spec.targeting.employeeCountMin).toBe(10);
    expect(result.spec.targeting.employeeCountMax).toBe(500);
    expect(result.spec.outreach).toEqual({
      channel: 'email',
      dailyLimit: 1_000,
      approval: 'review',
      maxPerAddressPerWeek: 1,
    });
    expect(result.spec.schedule).toEqual({
      kind: 'weekly',
      hour: 23,
      minute: 0,
      timezone: 'America/Los_Angeles',
      weekday: 1,
    });
    expect(result.warnings.length).toBe(2);
  });
});
