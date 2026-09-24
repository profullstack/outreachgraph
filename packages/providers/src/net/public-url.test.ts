/**
 * The SSRF guard. Every case here is a URL a customer could type into the
 * webhook form and a request the worker would otherwise make from inside the
 * deployment.
 */

import { describe, expect, test } from 'bun:test';
import { assertPublicUrl, isPrivateAddress, UnsafeUrlError, type HostLookup } from './public-url';

const resolvesTo =
  (...addresses: string[]): HostLookup =>
  async () =>
    addresses;

async function refusal(url: string, lookup: HostLookup = resolvesTo('93.184.216.34')) {
  try {
    await assertPublicUrl(url, { lookup });
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(UnsafeUrlError);
    return (error as UnsafeUrlError).reason;
  }
}

describe('isPrivateAddress', () => {
  test.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::a9fe:a9fe',
    'not-an-ip',
  ])('%s is private', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  test.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    '%s is public',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe('assertPublicUrl', () => {
  test('accepts an https URL whose host resolves publicly', async () => {
    const url = await assertPublicUrl('https://hooks.example.com/in', {
      lookup: resolvesTo('93.184.216.34'),
    });
    expect(url.hostname).toBe('hooks.example.com');
  });

  test('refuses http unless explicitly allowed', async () => {
    expect(await refusal('http://hooks.example.com/in')).toBe('scheme');
    const url = await assertPublicUrl('http://hooks.example.com/in', {
      allowHttp: true,
      lookup: resolvesTo('93.184.216.34'),
    });
    expect(url.protocol).toBe('http:');
  });

  test.each([
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://[::1]/',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5:5432/',
  ])('refuses a private literal: %s', async (url) => {
    expect(await refusal(url)).toBe('private_address');
  });

  test.each(['https://localhost/', 'https://api.internal/', 'https://printer.local/'])(
    'refuses a private host name without asking DNS: %s',
    async (url) => {
      let asked = false;
      const reason = await refusal(url, async () => {
        asked = true;
        return ['93.184.216.34'];
      });
      expect(reason).toBe('private_host');
      expect(asked).toBe(false);
    },
  );

  test('refuses a public name that resolves to a private address', async () => {
    expect(await refusal('https://evil.example/', resolvesTo('127.0.0.1'))).toBe('private_address');
  });

  test('refuses when any one of several answers is private', async () => {
    expect(await refusal('https://evil.example/', resolvesTo('93.184.216.34', '10.0.0.1'))).toBe(
      'private_address',
    );
  });

  test('refuses a name that does not resolve', async () => {
    expect(
      await refusal('https://nowhere.example/', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).toBe('unresolvable');
  });

  test('refuses embedded credentials and non-URLs', async () => {
    expect(await refusal('https://user:pw@hooks.example.com/')).toBe('credentials');
    expect(await refusal('not a url')).toBe('invalid');
    expect(await refusal('file:///etc/passwd')).toBe('scheme');
  });
});
