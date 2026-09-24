import { describe, expect, test } from 'bun:test';
import { endpointWants, normaliseEventFilter } from './webhooks';

describe('endpointWants', () => {
  test('an empty filter means every event', () => {
    expect(endpointWants([], 'reply.received')).toBe(true);
    expect(endpointWants([], 'person.suppressed')).toBe(true);
  });

  test('a filter means only those events', () => {
    expect(endpointWants(['reply.received'], 'reply.received')).toBe(true);
    expect(endpointWants(['reply.received'], 'link.clicked')).toBe(false);
    expect(endpointWants(['*'], 'link.clicked')).toBe(true);
  });

  test('ping is never broadcast, whatever the filter', () => {
    expect(endpointWants([], 'ping')).toBe(false);
    expect(endpointWants(['*'], 'ping')).toBe(false);
  });
});

describe('normaliseEventFilter', () => {
  test('dedupes, trims and accepts known names', () => {
    expect(normaliseEventFilter([' reply.received', 'reply.received', 'action.sent'])).toEqual({
      ok: true,
      events: ['reply.received', 'action.sent'],
    });
  });

  test('refuses a typo rather than subscribing to nothing', () => {
    expect(normaliseEventFilter(['reply.recieved'])).toEqual({
      ok: false,
      unknown: ['reply.recieved'],
    });
  });

  test('* and nothing both mean everything', () => {
    expect(normaliseEventFilter(['*'])).toEqual({ ok: true, events: [] });
    expect(normaliseEventFilter(undefined)).toEqual({ ok: true, events: [] });
  });
});
