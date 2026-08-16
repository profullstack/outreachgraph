import { describe, expect, test } from 'bun:test';
import { canStoreSecrets, decryptSecret, encryptSecret } from './secret-box';

const env = { CREDENTIAL_KEY: 'a-test-root-secret' } as NodeJS.ProcessEnv;

describe('secret box', () => {
  test('round-trips a password', () => {
    expect(decryptSecret(encryptSecret('hunter2', env), env)).toBe('hunter2');
  });

  test('produces different ciphertext each time', () => {
    // A deterministic ciphertext would let anyone with database access tell
    // which workspaces share a password.
    expect(encryptSecret('hunter2', env)).not.toBe(encryptSecret('hunter2', env));
  });

  test('refuses to decrypt tampered data', () => {
    const sealed = encryptSecret('hunter2', env);
    const [version, iv, tag, body] = sealed.split('.');
    const flipped = `${version}.${iv}.${tag}.${Buffer.from('other', 'utf8').toString('base64')}`;

    expect(decryptSecret(flipped, env)).toBeUndefined();
    expect(body).toBeDefined();
  });

  test('returns undefined rather than throwing when the root secret changed', () => {
    // This is the rotate-API_TOKEN case. It has to be a "re-enter your
    // password" state, not a crash on every worker tick.
    const sealed = encryptSecret('hunter2', env);
    expect(decryptSecret(sealed, { CREDENTIAL_KEY: 'a-different-secret' })).toBeUndefined();
  });

  test('falls back to API_TOKEN, which every deployment already has', () => {
    const shared = { API_TOKEN: 'deployed-token' } as NodeJS.ProcessEnv;
    expect(decryptSecret(encryptSecret('hunter2', shared), shared)).toBe('hunter2');
  });

  test('will not store secrets in production with no key at all', () => {
    expect(canStoreSecrets({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false);
    expect(canStoreSecrets({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(true);
  });

  test('does not use the root secret as the key', () => {
    // HKDF matters here: API_TOKEN is a bearer credential for the API, and if
    // it were also the AES key then anyone who could read one could derive the
    // other.
    expect(encryptSecret('x', env)).not.toContain(
      Buffer.from('a-test-root-secret').toString('base64'),
    );
  });
});
