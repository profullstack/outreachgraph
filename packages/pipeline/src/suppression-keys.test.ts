import { describe, expect, test } from 'bun:test';
import { domainMatchKey, emailMatchKey, normaliseDomain } from './suppression-keys';

describe('match keys', () => {
  test('email keys are case and whitespace insensitive', () => {
    expect(emailMatchKey('  Jane@Example.COM ')).toBe('email:jane@example.com');
  });

  test('domain keys strip scheme, www, path and port', () => {
    expect(normaliseDomain('https://www.Example.com/about?x=1')).toBe('example.com');
    expect(normaliseDomain('example.com:8443')).toBe('example.com');
    expect(domainMatchKey('WWW.Acme.io')).toBe('domain:acme.io');
  });
});
