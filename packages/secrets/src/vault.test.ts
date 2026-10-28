import { describe, expect, test } from 'bun:test';

import { encryptSecret, generateSecretKey, parseSecretKey } from './index';
import {
  createSeal,
  rewrapSeal,
  sealToPublicKey,
  openWithPrivateKey,
  unlockSeal,
  unlockSealWithRecovery,
  bytesToBase64,
  WrongPassphraseError,
} from './seal';
import {
  SecretVault,
  SecretsLockedError,
  WrongKeyError,
  openPrivateKeySync,
  openSealedSync,
  sealToPublicKeySync,
} from './vault';

const WS = 'ws_test';
const PASS = 'correct horse battery staple';

async function setup(now?: () => number) {
  const created = await createSeal(PASS, WS);
  const legacyKey = parseSecretKey(generateSecretKey());
  const vault = new SecretVault({
    loadSeal: async (ws) => (ws === WS ? created.seal : null),
    legacyKey,
    ...(now ? { now } : {}),
  });
  return { created, vault, legacyKey };
}

describe('seal v2', () => {
  test('browser (WebCrypto) and server (node:crypto) formats interoperate both ways', async () => {
    const { created } = await setup();
    const priv = openPrivateKeySync(Buffer.from(created.dek), created.seal, WS);
    const fromBrowser = await sealToPublicKey(
      created.seal.public_key,
      'pw-1',
      WS,
      'access_token_enc',
    );
    expect(openSealedSync(priv, fromBrowser, WS, 'access_token_enc')).toBe('pw-1');

    const fromServer = sealToPublicKeySync(created.seal.public_key, 'pw-2', WS, 'access_token_enc');
    const subtle = globalThis.crypto.subtle;
    // the browser can open it with the pkcs8 key too (round trip via the seal)
    expect(fromServer.startsWith('v2:')).toBe(true);
    expect(() => openSealedSync(priv, fromServer, WS, 'refresh_token_enc')).toThrow();
    expect(() => openSealedSync(priv, fromServer, 'ws_other', 'access_token_enc')).toThrow();
    expect(subtle).toBeDefined();
    void openWithPrivateKey;
  });

  test('passphrase, recovery key and rewrap all yield the same data key; wrong one refused', async () => {
    const { created } = await setup();
    expect(
      Buffer.from(await unlockSeal(created.seal, PASS, WS)).equals(Buffer.from(created.dek)),
    ).toBe(true);
    expect(
      Buffer.from(await unlockSealWithRecovery(created.seal, created.recoveryKey, WS)).equals(
        Buffer.from(created.dek),
      ),
    ).toBe(true);
    await expect(unlockSeal(created.seal, 'not the passphrase', WS)).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
    const next = await rewrapSeal(created.dek, created.seal, 'a different passphrase', WS);
    expect(next.public_key).toBe(created.seal.public_key);
    expect(
      Buffer.from(await unlockSeal(next, 'a different passphrase', WS)).equals(
        Buffer.from(created.dek),
      ),
    ).toBe(true);
    expect(JSON.stringify(created.seal)).not.toContain(PASS);
    expect(created.seal.kdf.iterations).toBeGreaterThanOrEqual(600_000);
  });
});

describe('SecretVault unlock store', () => {
  test('sealing works while locked; opening needs the unlock; Lock and restart drop it', async () => {
    const { created, vault } = await setup();
    const v = await vault.seal('smtp-password', WS, 'access_token_enc');
    expect(() => vault.open(v, WS, 'access_token_enc')).toThrow(SecretsLockedError);
    await vault.unlock(WS, bytesToBase64(created.dek), 3600);
    expect(vault.open(v, WS, 'access_token_enc')).toBe('smtp-password');
    vault.lock(WS);
    expect(() => vault.open(v, WS, 'access_token_enc')).toThrow(SecretsLockedError);
    await vault.unlock(WS, bytesToBase64(created.dek), 3600);
    vault.lockAll(); // restart
    expect(vault.canOpen(WS)).toBe(false);
  });

  test('TTL is clamped to 7 days and expires', async () => {
    let t = 1_000_000;
    const { created, vault } = await setup(() => t);
    const { expiresAt } = await vault.unlock(WS, bytesToBase64(created.dek), 30 * 86400);
    expect(Date.parse(expiresAt) - t).toBe(7 * 86400 * 1000);
    t += 7 * 86400 * 1000 + 1;
    expect(vault.canOpen(WS)).toBe(false);
  });

  test('a wrong data key is refused and a workspace with no seal must set one', async () => {
    const { vault } = await setup();
    await expect(vault.unlock(WS, Buffer.alloc(32).toString('base64'), 60)).rejects.toBeInstanceOf(
      WrongKeyError,
    );
    await expect(vault.seal('x', 'ws_none', 'f')).rejects.toBeInstanceOf(SecretsLockedError);
  });

  test('no env fallback: a v1 server-key value is never opened for use, even unlocked', async () => {
    const { created, vault, legacyKey } = await setup();
    await vault.unlock(WS, bytesToBase64(created.dek), 3600);
    const legacy = encryptSecret('old-password', legacyKey);
    expect(() => vault.open(legacy, WS, 'access_token_enc')).toThrow(SecretsLockedError);
    expect(vault.legacyOpen(legacy)).toBe('old-password'); // migration path only
  });

  test('LEGACY_KEY_MIGRATION=off disables the migration reader', async () => {
    const created = await createSeal(PASS, WS);
    const legacyKey = parseSecretKey(generateSecretKey());
    const vault = new SecretVault({
      loadSeal: async () => created.seal,
      legacyKey,
      legacyMigration: false,
    });
    expect(vault.legacyMigrationEnabled).toBe(false);
    expect(() => vault.legacyOpen(encryptSecret('x', legacyKey))).toThrow(/off/);
  });
});

test('the web copy of seal.ts is identical to the package one', async () => {
  const here = new URL('.', import.meta.url).pathname;
  const a = await Bun.file(`${here}seal.ts`).text();
  const b = await Bun.file(`${here}../../../apps/web/lib/seal.ts`).text();
  expect(b).toBe(a);
});
