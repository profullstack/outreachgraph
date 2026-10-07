import { describe, expect, test } from 'bun:test';
import {
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
