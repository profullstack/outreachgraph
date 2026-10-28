/**
 * Server side of seal v2 (see ./seal.ts for the format and the client side).
 *
 * No server-held key opens a customer's credential any more. Each workspace's
 * credentials are sealed to that workspace's public key; the private key opens
 * only with the data key the workspace owner derives from their passphrase in
 * the browser or CLI and sends to /api/v1/keys/unlock. This process keeps the
 * opened private key in memory only, with a TTL (default 8h, max 7d) and Lock.
 * A restart empties it: autopilot and every other job that needs a credential
 * then waits ("locked: unlock to resume") instead of failing or falling back
 * to the platform sender.
 *
 * Synchronous node:crypto on purpose, so existing call sites stay sync where
 * they read a credential. Byte-compatible with the WebCrypto code in seal.ts
 * (ECDH P-256 shared x-coordinate, HKDF-SHA256, AES-256-GCM, same AAD).
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

import { decryptSecret as v1Decrypt } from './index';
import { isSealedValue, SEALED_PREFIX, clampUnlockTtlSeconds, type SealRecord } from './seal';

const KEY_CHECK_TEXT = 'outreachgraph-key-check-v2';

export const LOCKED_MESSAGE = 'locked: unlock your workspace keys (Settings > Keys) to resume';
export const SEAL_REQUIRED_MESSAGE =
  'locked: set a workspace key passphrase (Settings > Keys) before connecting accounts';

export class SecretsLockedError extends Error {
  readonly workspaceId: string;
  readonly reason: 'locked' | 'seal_required' | 'legacy';
  constructor(workspaceId: string, reason: 'locked' | 'seal_required' | 'legacy' = 'locked') {
    super(reason === 'seal_required' ? SEAL_REQUIRED_MESSAGE : LOCKED_MESSAGE);
    this.name = 'SecretsLockedError';
    this.workspaceId = workspaceId;
    this.reason = reason;
  }
}

export class WrongKeyError extends Error {
  constructor() {
    super('wrong key');
    this.name = 'WrongKeyError';
  }
}

function aad(ws: string, field: string): Buffer {
  return Buffer.from(`outreachgraph:v2:${ws}:${field}`, 'utf8');
}

function gcmOpen(
  key: Buffer,
  blob: { ciphertext: string; iv: string; tag: string },
  ad: Buffer,
): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'), {
    authTagLength: 16,
  });
  d.setAAD(ad);
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(blob.ciphertext, 'base64')), d.final()]);
}

function gcmSeal(
  key: Buffer,
  plaintext: Buffer,
  ad: Buffer,
): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(ad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
  };
}

function rawToPublicKey(raw: Buffer): KeyObject {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('bad P-256 public key');
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
}

function publicKeyToRaw(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

function boxKey(shared: Buffer, epk: Buffer, ws: string, field: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, epk, `outreachgraph/box/v2/${ws}/${field}`, 32));
}

/** True when `dek` is this workspace's data key. */
export function verifyDataKeySync(
  dek: Buffer,
  seal: Pick<SealRecord, 'key_check'>,
  ws: string,
): boolean {
  if (dek.length !== 32) return false;
  try {
    return gcmOpen(dek, seal.key_check, aad(ws, 'key_check')).toString('utf8') === KEY_CHECK_TEXT;
  } catch {
    return false;
  }
}

/** DEK -> the workspace's private key. Throws WrongKeyError. */
export function openPrivateKeySync(dek: Buffer, seal: SealRecord, ws: string): KeyObject {
  if (!verifyDataKeySync(dek, seal, ws)) throw new WrongKeyError();
  const pkcs8 = gcmOpen(dek, seal.private_sealed, aad(ws, 'private_key'));
  try {
    return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  } finally {
    pkcs8.fill(0);
  }
}

/** Seal to a workspace public key. Needs no unlock. */
export function sealToPublicKeySync(
  publicKeyB64: string,
  plaintext: string,
  ws: string,
  field: string,
): string {
  const recipient = rawToPublicKey(Buffer.from(publicKeyB64, 'base64'));
  const eph = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const epk = publicKeyToRaw(eph.publicKey);
  try {
    const blob = gcmSeal(
      boxKey(shared, epk, ws, field),
      Buffer.from(plaintext, 'utf8'),
      aad(ws, field),
    );
    const body = JSON.stringify({
      e: epk.toString('base64'),
      c: blob.ciphertext,
      i: blob.iv,
      t: blob.tag,
    });
    return SEALED_PREFIX + Buffer.from(body, 'utf8').toString('base64');
  } finally {
    shared.fill(0);
  }
}

export function openSealedSync(
  privateKey: KeyObject,
  sealed: string,
  ws: string,
  field: string,
): string {
  if (!isSealedValue(sealed)) throw new Error('not a sealed v2 value');
  const body = JSON.parse(
    Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64').toString('utf8'),
  ) as {
    e: string;
    c: string;
    i: string;
    t: string;
  };
  const epk = Buffer.from(body.e, 'base64');
  const shared = diffieHellman({ privateKey, publicKey: rawToPublicKey(epk) });
  try {
    const out = gcmOpen(
      boxKey(shared, epk, ws, field),
      { ciphertext: body.c, iv: body.i, tag: body.t },
      aad(ws, field),
    );
    const text = out.toString('utf8');
    out.fill(0);
    return text;
  } finally {
    shared.fill(0);
  }
}

export type SealLoader = (workspaceId: string) => Promise<SealRecord | null>;

export interface VaultOptions {
  readonly loadSeal: SealLoader;
  /** The old SECRET_ENCRYPTION_KEY: read ONLY by migrate(), and only while legacyMigration is on. */
  readonly legacyKey?: Buffer | undefined;
  readonly legacyMigration?: boolean;
  readonly now?: () => number;
}

type Entry = { key: KeyObject; unlockedAt: number; expiresAt: number };

/**
 * One per process. Holds unlocked workspaces' private keys in memory only.
 */
export class SecretVault {
  protected readonly unlocked = new Map<string, Entry>();
  private readonly pubCache = new Map<string, string>();
  private readonly lockedNoticed = new Set<string>();
  constructor(private readonly options: VaultOptions) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  forgetSeal(ws: string): void {
    this.pubCache.delete(ws);
  }

  async publicKey(ws: string): Promise<string | null> {
    const hit = this.pubCache.get(ws);
    if (hit) return hit;
    const seal = await this.options.loadSeal(ws);
    if (!seal) return null;
    this.pubCache.set(ws, seal.public_key);
    return seal.public_key;
  }

  async hasSeal(ws: string): Promise<boolean> {
    return (await this.publicKey(ws)) !== null;
  }

  /** Seal a credential for a workspace. Throws SecretsLockedError('seal_required') with no passphrase set. */
  async seal(plaintext: string, ws: string, field: string): Promise<string> {
    const pub = await this.publicKey(ws);
    if (!pub) throw new SecretsLockedError(ws, 'seal_required');
    return sealToPublicKeySync(pub, plaintext, ws, field);
  }

  private keyFor(ws: string): KeyObject | null {
    const e = this.unlocked.get(ws);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.unlocked.delete(ws);
      return null;
    }
    return e.key;
  }

  canOpen(ws: string): boolean {
    return this.keyFor(ws) !== null;
  }

  /** Open a credential. Legacy v1 values are never opened here (only by migrate). */
  open(encoded: string, ws: string, field: string): string {
    if (!isSealedValue(encoded)) throw new SecretsLockedError(ws, 'legacy');
    const key = this.keyFor(ws);
    if (!key) throw new SecretsLockedError(ws, 'locked');
    return openSealedSync(key, encoded, ws, field);
  }

  async unlock(ws: string, dekB64: string, ttlSeconds: unknown): Promise<{ expiresAt: string }> {
    this.forgetSeal(ws);
    const seal = await this.options.loadSeal(ws);
    if (!seal) throw new SecretsLockedError(ws, 'seal_required');
    return this.unlockWithSeal(ws, seal, dekB64, ttlSeconds);
  }

  /** Verify the data key against `seal` and hold the private key in memory. */
  unlockWithSeal(
    ws: string,
    seal: SealRecord,
    dekB64: string,
    ttlSeconds: unknown,
  ): { expiresAt: string } {
    const dek = Buffer.from(dekB64 ?? '', 'base64');
    try {
      const key = openPrivateKeySync(dek, seal, ws);
      const expiresAt = this.now() + clampUnlockTtlSeconds(ttlSeconds) * 1000;
      this.unlocked.set(ws, { key, unlockedAt: this.now(), expiresAt });
      this.lockedNoticed.delete(ws);
      return { expiresAt: new Date(expiresAt).toISOString() };
    } finally {
      dek.fill(0);
    }
  }

  lock(ws: string): void {
    this.unlocked.delete(ws);
  }

  /** Simulated restart (tests). */
  lockAll(): void {
    this.unlocked.clear();
  }

  status(ws: string): { unlocked: boolean; unlockedAt: string | null; expiresAt: string | null } {
    const key = this.keyFor(ws);
    const e = this.unlocked.get(ws);
    if (!key || !e) return { unlocked: false, unlockedAt: null, expiresAt: null };
    return {
      unlocked: true,
      unlockedAt: new Date(e.unlockedAt).toISOString(),
      expiresAt: new Date(e.expiresAt).toISOString(),
    };
  }

  /** True the first time per lock episode, so a loop logs/notifies once. */
  firstLockedNotice(ws: string): boolean {
    if (this.canOpen(ws) || this.lockedNoticed.has(ws)) return false;
    this.lockedNoticed.add(ws);
    return true;
  }

  get legacyMigrationEnabled(): boolean {
    return !!this.options.legacyKey && this.options.legacyMigration !== false;
  }

  /** Migration path only: opens a v1 value with the old server key. */
  legacyOpen(encoded: string): string {
    if (!this.legacyMigrationEnabled) throw new Error('legacy key migration is off');
    return v1Decrypt(encoded, this.options.legacyKey!);
  }
}
