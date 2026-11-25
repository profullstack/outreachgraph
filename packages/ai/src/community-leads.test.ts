import { describe, expect, test } from 'bun:test';
import { StubModel } from './model';
import {
  draftLeadReply,
  fitReply,
  graphemeLength,
  replyLimitFor,
  intentFromJudgement,
  parseLeadJudgements,
  parseMonitorSuggestion,
} from './community-leads';

describe('lead judgements', () => {
  test('kind and fit become a score; the model never picks the number', () => {
    expect(intentFromJudgement('seeking', 'high')).toBe(88);
    expect(intentFromJudgement('problem', 'high')).toBe(72);
    expect(intentFromJudgement('problem', 'medium')).toBe(61);
    expect(intentFromJudgement('seeking', 'low')).toBe(44);
    expect(intentFromJudgement('discussion', 'high')).toBe(35);
    expect(intentFromJudgement('promo', 'high')).toBe(5);
    expect(intentFromJudgement('nonsense', 'high')).toBe(0);
  });

  test('parses classified answers, and a bare number from older prompts', () => {
    const raw =
      'Here you go: {"results": [' +
      '{"id": "0", "kind": "promo", "fit": "high", "reason": "ManageEngine ad"},' +
      '{"id": 1, "kind": "Seeking", "fit": "Medium", "reason": "wants a Splunk alternative"},' +
      '{"id": "2", "intent": 140}]}';
    expect(parseLeadJudgements(raw)).toEqual([
      { id: '0', intent: 5, reason: 'ManageEngine ad' },
      { id: '1', intent: 75, reason: 'wants a Splunk alternative' },
      { id: '2', intent: 100, reason: '' },
    ]);
    expect(parseLeadJudgements('no json')).toEqual([]);
  });

  test('monitor suggestions are cleaned', () => {
    expect(
      parseMonitorSuggestion(
        '{"keywords": ["SIEM", "x", "SIEM"], "subreddits": ["r/sysadmin", "bad name!"]}',
      ),
    ).toEqual({ keywords: ['siem'], subreddits: ['sysadmin'] });
  });
});

describe('reply length on Bluesky and W3BS Social', () => {
  const brand = { name: 'Acme', url: 'https://acme.example' };
  const long =
    'Rotating logs by hand is how most of us start, and it stops scaling around the third box. ' +
    'What worked for me was shipping everything to one place and alerting on the patterns, not the lines. ' +
    'I work on Acme, which does that with a one-line agent and keeps a week free. ' +
    'Happy to compare notes on retention and costs if that helps, since the tradeoffs are not obvious early on. ' +
    'https://acme.example';

  test('limits by network', () => {
    expect(replyLimitFor('bluesky')).toBe(300);
    expect(replyLimitFor('w3bs')).toBe(300);
    expect(replyLimitFor('reddit')).toBeUndefined();
  });

  test('fitReply cuts at a sentence and keeps the link', () => {
    const fitted = fitReply(long, 300);
    expect(graphemeLength(fitted)).toBeLessThanOrEqual(300);
    expect(fitted.endsWith('https://acme.example')).toBe(true);
    expect(fitted).toContain('Rotating logs by hand');
    expect(fitReply('short one', 300)).toBe('short one');
  });

  test('an over-long Bluesky draft is rewritten once, then fitted', async () => {
    const model = new StubModel([long, long]);
    const draft = await draftLeadReply(model, brand, {
      source: 'bluesky',
      text: 'how do I manage logs',
    });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]?.system).toContain('HARD LIMIT');
    expect(graphemeLength(draft ?? '')).toBeLessThanOrEqual(300);
  });

  test('the shorter rewrite wins when it fits', async () => {
    const model = new StubModel([
      long,
      'Ship logs to one place and alert on patterns. I work on Acme. https://acme.example',
    ]);
    const draft = await draftLeadReply(model, brand, { source: 'bluesky', text: 'logs?' });
    expect(draft).toBe(
      'Ship logs to one place and alert on patterns. I work on Acme. https://acme.example',
    );
  });

  test('Reddit keeps the long form and makes one call', async () => {
    const model = new StubModel(long);
    const draft = await draftLeadReply(model, brand, { source: 'reddit', text: 'logs?' });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.system).toContain('40-120 words');
    expect(draft).toBe(long);
  });
});
