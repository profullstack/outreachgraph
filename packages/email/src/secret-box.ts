/**
 * Encryption for stored credentials.
 *
 * An SMTP password is the first secret this product holds *on behalf of a
 * customer*, which makes it categorically different from the API keys in the
 * container's environment. Those are ours and live in a vault; this one is
 * theirs and lives in a row in Turso, next to their prospects, in whatever
 * backups that database produces. Storing it in the clear would mean a database
 * dump is also a mail-server credential dump for every customer at once.
 *
 * AES-256-GCM, so a tampered ciphertext fails to decrypt rather than silently
 * producing a wrong password and an unexplainable authentication failure.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * Raised when no key material is configured.
 *
 * Deliberately not a silent fallback to plaintext. A product that quietly
 * stores passwords unencrypted when a variable is missing is one where nobody
 * ever discovers the variable is missing.
 */
export class SecretUnavailableError extends Error {
  constructor() {
    super(
      'credential encryption is not configured: set CREDENTIAL_KEY (or API_TOKEN) ' +
        'before saving a mail server password',
    );
    this.name = 'SecretUnavailableError';
  }
}

/**
 * The root secret, in preference order.
 *
 * `CREDENTIAL_KEY` is the intended variable. `API_TOKEN` is accepted as a
 * fallback because it is already set on every deployment, which means this
 * feature works the moment it ships instead of after someone remembers to add
 * a variable — and it is a secret of the same grade, not a public value.
 *
 * Both are run through HKDF rather than used directly, so the encryption key is
 * not the same bytes as the API token even when the token is the input: leaking
 * one does not hand over the other, and the `info` label keeps this key
 * distinct from any other key later derived from the same root.
 */
function rootSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.CREDENTIAL_KEY?.trim();
  if (explicit) return explicit;

  const shared = env.API_TOKEN?.trim();
  if (shared) return shared;

  // Local development has neither, and refusing to run there would make the
  // settings page untestable without a deployment. Never reached in production,
  // where the guard below applies.
  if (env.NODE_ENV !== 'production') return 'outreachgraph-development-credential-key';

  return undefined;
}

function derive(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'outreachgraph.credentials', 'smtp-v1', KEY_BYTES));
}

/** True when credentials can be stored at all. The API checks before offering. */
export function canStoreSecrets(env: NodeJS.ProcessEnv = process.env): boolean {
  return rootSecret(env) !== undefined;
}

export function encryptSecret(plaintext: string, env: NodeJS.ProcessEnv = process.env): string {
  const secret = rootSecret(env);
  if (!secret) throw new SecretUnavailableError();

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', derive(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

/**
 * Reverses `encryptSecret`, or returns undefined.
 *
 * Undefined rather than a throw for the one case that actually happens in
 * practice: `API_TOKEN` was rotated, so every stored secret is now
 * undecryptable. That is a "re-enter your password" state, not a crash — the
 * caller marks the account unverified and asks again.
 */
export function decryptSecret(
  payload: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const secret = rootSecret(env);
  if (!secret) return undefined;

  const [version, iv, tag, body] = payload.split('.');
  if (version !== VERSION || !iv || !tag || !body) return undefined;

  try {
    const decipher = createDecipheriv('aes-256-gcm', derive(secret), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    return undefined;
  }
}
