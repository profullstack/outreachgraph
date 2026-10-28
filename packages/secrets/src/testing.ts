/**
 * Test helper: a SecretVault where every workspace already has a seal and is
 * unlocked, so tests that store and read credentials keep working without a
 * passphrase round trip. Never used by application code.
 */

import { createCipheriv, generateKeyPairSync, randomBytes } from 'node:crypto';

import { SecretVault } from './vault';
import type { SealRecord } from './seal';

function gcm(key: Buffer, plaintext: Buffer, ad: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(ad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
  };
}

/** A seal built without a passphrase (wrapped_dek is a dummy). Returns the DEK too. */
export function makeTestSeal(workspaceId: string): { seal: SealRecord; dek: Buffer } {
  const dek = randomBytes(32);
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const raw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  const pkcs8 = pair.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const ad = (f: string) => `outreachgraph:v2:${workspaceId}:${f}`;
  const seal: SealRecord = {
    v: 2,
    kdf: { alg: 'PBKDF2-SHA256', iterations: 600_000, salt: randomBytes(16).toString('base64') },
    wrapped_dek: gcm(randomBytes(32), dek, ad('dek:passphrase')),
    recovery_wrapped_dek: null,
    key_check: gcm(dek, Buffer.from('outreachgraph-key-check-v2', 'utf8'), ad('key_check')),
    public_key: raw.toString('base64'),
    private_sealed: gcm(dek, pkcs8, ad('private_key')),
  };
  return { seal, dek };
}

export class TestVault extends SecretVault {
  readonly seals = new Map<string, { seal: SealRecord; dek: Buffer }>();
  readonly autoUnlock: boolean;
  constructor(opts: { autoUnlock?: boolean; legacyKey?: Buffer } = {}) {
    const seals = new Map<string, { seal: SealRecord; dek: Buffer }>();
    super({
      loadSeal: async (ws) => seals.get(ws)?.seal ?? null,
      ...(opts.legacyKey ? { legacyKey: opts.legacyKey } : {}),
    });
    this.seals = seals;
    this.autoUnlock = opts.autoUnlock ?? true;
  }

  provision(ws: string): { seal: SealRecord; dek: Buffer } {
    let s = this.seals.get(ws);
    if (!s) {
      s = makeTestSeal(ws);
      this.seals.set(ws, s);
    }
    return s;
  }

  private ensure(ws: string): void {
    if (!this.autoUnlock || super.canOpen(ws)) return;
    const { seal, dek } = this.provision(ws);
    this.unlockWithSeal(ws, seal, dek.toString('base64'), 3600);
  }

  override async publicKey(ws: string): Promise<string | null> {
    if (this.autoUnlock) this.provision(ws);
    return super.publicKey(ws);
  }

  override canOpen(ws: string): boolean {
    this.ensure(ws);
    return super.canOpen(ws);
  }

  override open(encoded: string, ws: string, field: string): string {
    this.ensure(ws);
    return super.open(encoded, ws, field);
  }
}

export function testVault(): TestVault {
  return new TestVault();
}
