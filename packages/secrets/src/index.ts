/**
 * Encryption for credentials the customer hands us (PRD §34).
 *
 * The schema has carried `access_token_enc` since the first migration with a
 * comment promising the column never leaves the process in plaintext. Nothing
 * ever wrote to it, so the promise was free. It is not free any more: a
 * workspace's SMTP password is a credential to someone else's mailbox, and a
 * database backup, a support query or a stray `SELECT *` must not be enough to
 * read it.
 *
 * AES-256-GCM, one random nonce per value, the authentication tag stored with
 * the ciphertext. GCM rather than CBC because a tampered value must fail to
 * decrypt rather than decrypt into something attacker-shaped, and a fresh
 * nonce per value because reusing one under the same key in GCM leaks the
 * relationship between plaintexts.
 *
 * The key comes from the environment and is never derived from something
 * guessable. There is deliberately no fallback: with no key configured,
 * storing a credential fails loudly rather than writing a password to a column
 * whose name claims it is encrypted.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Marks the format so a later scheme can be told apart from this one. */
const PREFIX = 'v1';

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

export class SecretDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptError';
  }
}

/**
 * Reads the 32-byte key from a base64 or hex string.
 *
 * Both encodings are accepted because both are what a person actually pastes
 * into a deployment's variables, and silently truncating a key of the wrong
 * length would produce a system that encrypts fine and cannot be audited.
 */
export function parseSecretKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) throw new SecretKeyError('encryption key is empty');

  const decoded = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');

  if (decoded.length !== KEY_BYTES) {
    throw new SecretKeyError(
      `encryption key must decode to ${KEY_BYTES} bytes, got ${decoded.length}`,
    );
  }

  return decoded;
}

/**
 * The configured key, or `undefined` when none is set.
 *
 * Returning `undefined` rather than throwing lets a deployment without the key
 * keep running everything that does not touch credentials — the whole product
 * except connecting a mailbox — and lets the connect route explain exactly
 * what is missing.
 */
export function secretKeyFromEnv(
  env: Record<string, string | undefined> = process.env,
): Buffer | undefined {
  const raw = env.SECRET_ENCRYPTION_KEY;
  if (!raw || !raw.trim()) return undefined;
  return parseSecretKey(raw);
}

/** Generates a key in the format `SECRET_ENCRYPTION_KEY` expects. */
export function generateSecretKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/** `v1.<nonce>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    PREFIX,
    nonce.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new SecretDecryptError('unrecognised ciphertext format');
  }

  const nonce = Buffer.from(parts[1] as string, 'base64url');
  const tag = Buffer.from(parts[2] as string, 'base64url');
  const ciphertext = Buffer.from(parts[3] as string, 'base64url');

  if (nonce.length !== NONCE_BYTES) throw new SecretDecryptError('bad nonce length');
  if (tag.length !== TAG_BYTES) throw new SecretDecryptError('bad tag length');

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // The tag check failed: either the value was tampered with or the key is
    // not the one it was written with. Both are the same answer to the caller
    // and neither should leak which.
    throw new SecretDecryptError('could not decrypt — wrong key or corrupted value');
  }
}

/** Constant-time comparison, for anything compared against a stored secret. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
