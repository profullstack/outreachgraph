import { describe, expect, test } from 'bun:test';
import {
  decryptSecret,
  encryptSecret,
  generateSecretKey,
  parseSecretKey,
  secretEquals,
  secretKeyFromEnv,
  SecretDecryptError,
  SecretKeyError,
} from './index';

const KEY = parseSecretKey(generateSecretKey());

describe('encryptSecret / decryptSecret', () => {
  test('round-trips a password', () => {
    const encrypted = encryptSecret('hunter2-app-password', KEY);
    expect(decryptSecret(encrypted, KEY)).toBe('hunter2-app-password');
  });

  test('the ciphertext does not contain the plaintext', () => {
    // The obvious property, and the one worth asserting: the column is called
    // `access_token_enc` and a reader of the database must not be able to see
    // the password in it.
    const encrypted = encryptSecret('correct-horse-battery', KEY);
    expect(encrypted).not.toContain('correct-horse-battery');
  });

  test('a fresh nonce per call, so the same password encrypts differently', () => {
    // GCM leaks the relationship between plaintexts if a nonce is reused under
    // one key. Two workspaces with the same app password must not be visibly
    // the same in the table.
    const a = encryptSecret('same-password', KEY);
    const b = encryptSecret('same-password', KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY));
  });

  test('handles unicode and long values', () => {
    const value = `${'ü'.repeat(200)}—🔑`;
    expect(decryptSecret(encryptSecret(value, KEY), KEY)).toBe(value);
  });

  test('refuses a value encrypted under a different key', () => {
    const other = parseSecretKey(generateSecretKey());
    const encrypted = encryptSecret('secret', KEY);
    expect(() => decryptSecret(encrypted, other)).toThrow(SecretDecryptError);
  });

  test('refuses a tampered ciphertext rather than returning something else', () => {
    // This is the whole reason for GCM over CBC: a modified value must fail
    // the tag check, not decrypt into attacker-shaped bytes.
    const encrypted = encryptSecret('secret', KEY);
    const parts = encrypted.split('.');
    const body = Buffer.from(parts[3] as string, 'base64url');
    body[0] = (body[0]! ^ 0xff) & 0xff;
    parts[3] = body.toString('base64url');

    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow(SecretDecryptError);
  });

  test('refuses a value that is not in the expected format', () => {
    expect(() => decryptSecret('plaintext-password', KEY)).toThrow(SecretDecryptError);
    expect(() => decryptSecret('v2.a.b.c', KEY)).toThrow(SecretDecryptError);
  });
});

describe('parseSecretKey', () => {
  test('accepts base64 and hex, because both are what people paste', () => {
    const raw = Buffer.alloc(32, 7);
    expect(parseSecretKey(raw.toString('base64'))).toEqual(raw);
    expect(parseSecretKey(raw.toString('hex'))).toEqual(raw);
  });

  test('rejects a key of the wrong length instead of padding it', () => {
    expect(() => parseSecretKey(Buffer.alloc(16).toString('base64'))).toThrow(SecretKeyError);
    expect(() => parseSecretKey('')).toThrow(SecretKeyError);
  });

  test('generateSecretKey produces something parseSecretKey accepts', () => {
    expect(parseSecretKey(generateSecretKey())).toHaveLength(32);
  });
});

describe('secretKeyFromEnv', () => {
  test('is undefined when nothing is configured', () => {
    // Absent is a normal state — nobody has connected a mailbox yet — so it
    // must not throw and take the process down.
    expect(secretKeyFromEnv({})).toBeUndefined();
    expect(secretKeyFromEnv({ SECRET_ENCRYPTION_KEY: '   ' })).toBeUndefined();
  });

  test('throws on a key that is present but unusable', () => {
    // Present-but-wrong is not normal: every stored credential would silently
    // read as no-account, and a product that quietly stops sending is worse
    // than one that refuses to start.
    expect(() => secretKeyFromEnv({ SECRET_ENCRYPTION_KEY: 'too-short' })).toThrow(SecretKeyError);
  });

  test('reads a valid key', () => {
    const key = generateSecretKey();
    expect(secretKeyFromEnv({ SECRET_ENCRYPTION_KEY: key })).toEqual(parseSecretKey(key));
  });
});

describe('secretEquals', () => {
  test('compares by value', () => {
    expect(secretEquals('abc', 'abc')).toBe(true);
    expect(secretEquals('abc', 'abd')).toBe(false);
    expect(secretEquals('abc', 'abcd')).toBe(false);
  });
});
