/**
 * Prefixed identifiers.
 *
 * Every entity uses a human-readable prefix so an id is self-describing in
 * logs, API payloads and audit events (PRD §9.1, §9.2, §11.1, §13.2).
 */

export const ID_PREFIXES = {
  organization: 'org',
  workspace: 'wsp',
  user: 'usr',
  session: 'ses',
  offering: 'off',
  voiceProfile: 'voi',
  campaign: 'cmp',
  company: 'co',
  person: 'per',
  socialIdentity: 'sid',
  // A profile the company published about itself, not one belonging to a
  // person — a distinct prefix so the two can never be confused in a log line.
  companyIdentity: 'cid',
  identityEvidence: 'evd',
  // A proposed personal address, which is a claim awaiting a decision rather
  // than an identity. It only becomes a `sid` once a human confirms it.
  emailCandidate: 'emc',
  identityCandidate: 'idc',
  providerRecord: 'prv',
  fieldProvenance: 'fpv',
  sourceDocument: 'src',
  signal: 'sig',
  score: 'scr',
  recommendation: 'rec',
  draft: 'drf',
  approval: 'apr',
  action: 'act',
  interaction: 'int',
  videoAsset: 'vid',
  integration: 'itg',
  integrationAccount: 'ita',
  suppression: 'sup',
  privacyRequest: 'pri',
  deletionJob: 'del',
  job: 'job',
  policyRule: 'pol',
  usageEvent: 'usg',
  auditEvent: 'aud',
  stageEvent: 'stg',
  notification: 'ntf',
  socialPost: 'spo',
  workflowEvent: 'wfe',
  // A tracked link's id is the token in the URL a prospect clicks, so it is
  // public by construction. The 26 characters of base32 randomness are what
  // keep it unguessable — a short or sequential token would let anyone
  // enumerate who a workspace has written to.
  trackedLink: 'tlk',
  linkClick: 'clk',
  cadence: 'cad',
  cadenceStep: 'cst',
  enrollment: 'enr',
  cadenceRun: 'crn',
  researchGrid: 'grd',
  gridQuestion: 'gqn',
  gridCell: 'gcl',
  termExpansion: 'tex',
} as const;

export type EntityKind = keyof typeof ID_PREFIXES;

/** `per_9x3k...` — prefix, underscore, then 26 chars of base32 randomness. */
export type PrefixedId<K extends EntityKind = EntityKind> = `${(typeof ID_PREFIXES)[K]}_${string}`;

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, no i/l/o/u
const RANDOM_LEN = 26;

/**
 * Generates a prefixed id.
 *
 * `randomBytes` is injectable so tests and the deterministic fixture provider
 * produce stable ids without stubbing globals.
 */
export function newId<K extends EntityKind>(
  kind: K,
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): PrefixedId<K> {
  const bytes = randomBytes(RANDOM_LEN);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return `${ID_PREFIXES[kind]}_${out}` as PrefixedId<K>;
}

function defaultRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Narrowing guard for trust boundaries: API input, provider payloads. */
export function isId<K extends EntityKind>(kind: K, value: unknown): value is PrefixedId<K> {
  if (typeof value !== 'string') return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  if (!value.startsWith(prefix)) return false;
  const rest = value.slice(prefix.length);
  return rest.length > 0 && [...rest].every((c) => ALPHABET.includes(c));
}

export function assertId<K extends EntityKind>(kind: K, value: unknown): PrefixedId<K> {
  if (!isId(kind, value)) {
    throw new TypeError(`expected a ${ID_PREFIXES[kind]}_ id, received ${String(value)}`);
  }
  return value;
}
