import { describe, expect, it } from 'bun:test';
import {
  buildIcs,
  cleanCrmText,
  cleanEmail,
  isCrmStage,
  isLoggableActivityKind,
  newPairuxRoomUrl,
  normaliseHandle,
} from './crm';

describe('crm rules', () => {
  it('knows its stages and which activities a caller may log', () => {
    expect(isCrmStage('proposal')).toBe(true);
    expect(isCrmStage('closed')).toBe(false);
    expect(isLoggableActivityKind('call')).toBe(true);
    expect(isLoggableActivityKind('stage')).toBe(false);
  });

  it('cleans text and addresses', () => {
    expect(cleanCrmText('  hi\u0000 there ', 100)).toBe('hi there');
    expect(cleanCrmText('   ', 100)).toBeNull();
    expect(cleanCrmText('abcdef', 3)).toBe('abc');
    expect(cleanEmail(' Ada@Example.COM ')).toBe('ada@example.com');
    expect(cleanEmail('not an address')).toBeNull();
  });

  it('accepts handles and refuses reserved or malformed ones', () => {
    expect(normaliseHandle('@Chovy')).toBe('chovy');
    expect(normaliseHandle('api')).toBeNull();
    expect(normaliseHandle('a')).toBeNull();
    expect(normaliseHandle('has space')).toBeNull();
  });
});

describe('newPairuxRoomUrl', () => {
  it('makes the room/key shape PairUX opens', () => {
    const url = newPairuxRoomUrl();
    expect(url).toMatch(/^https:\/\/pairux\.com\/r\/[A-Za-z0-9_-]{22}#k=[A-Za-z0-9_-]{43}$/);
    expect(newPairuxRoomUrl()).not.toBe(url);
  });

  it('is deterministic for a fixed source of randomness', () => {
    const zeros = (bytes: Uint8Array) => bytes.fill(0);
    expect(newPairuxRoomUrl(zeros)).toBe(
      `https://pairux.com/r/${'A'.repeat(22)}#k=${'A'.repeat(43)}`,
    );
  });
});

describe('buildIcs', () => {
  it('writes one escaped event with CRLF line ends', () => {
    const ics = buildIcs({
      uid: 'bkg_1',
      start: '2026-11-20T17:00:00.000Z',
      end: '2026-11-20T17:30:00.000Z',
      summary: 'Call; with Ada, Inc',
      description: 'line one\nline two',
      url: 'https://pairux.com/r/x#k=y',
      organizerEmail: 'host@example.com',
      attendeeEmail: 'ada@example.com',
      stamp: '2026-11-18T00:00:00.000Z',
    });
    expect(ics).toContain('DTSTART:20261120T170000Z\r\n');
    expect(ics).toContain('SUMMARY:Call\\; with Ada\\, Inc\r\n');
    expect(ics).toContain('DESCRIPTION:line one\\nline two\r\n');
    expect(ics).toContain('UID:bkg_1@outreachgraph.com');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('marks a cancellation', () => {
    const ics = buildIcs({
      uid: 'bkg_1',
      start: '2026-11-20T17:00:00.000Z',
      end: '2026-11-20T17:30:00.000Z',
      summary: 's',
      description: 'd',
      url: 'u',
      cancelled: true,
      sequence: 1,
    });
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
  });
});
