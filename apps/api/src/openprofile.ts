/**
 * A person's OpenProfile.md as it is served: the generated document, the
 * owner's corrections over it, and the public view of the result.
 *
 * Three facts decide what a reader gets. The openprofile job writes the
 * generated file (`openprofiles`) and may rewrite it any time. The person, or
 * the operator for them, writes an overlay (`openprofile_settings.overrides`)
 * that a rewrite never touches: their identity keys, headline and sections
 * win, section by section, exactly as @profullstack/openprofile applies them
 * everywhere else. And `public` is off until somebody switches it on: a
 * private profile is served only to the workspace that holds the person, a
 * public one to anybody, minus the keys a public page never carries.
 *
 * Who may edit: the operator, as for every other write about a person; or the
 * person themselves, carrying an OpenAccess bearer with the `openprofile:edit`
 * scope whose principal is provably them, by an email this workspace has
 * verified for them or by the OpenProfile.md they publish. Nobody else.
 */

import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  EDIT_SCOPE,
  accounts,
  applyOverrides,
  identityValue,
  mergeOverrides,
  normaliseEmail,
  normaliseUrl,
  overridesFromDocument,
  parseOpenProfile,
  renderOpenProfile,
  type OpenProfileDoc,
  type Overrides,
} from '@profullstack/openprofile';

export { EDIT_SCOPE };

export interface ProfileSettings {
  readonly personId: string;
  readonly public: boolean;
  readonly handle: string | null;
  readonly overrides: Overrides;
  readonly ownerUserId: string | null;
  readonly claimedAt: string | null;
  readonly claimMethod: string | null;
  readonly publishedAt: string | null;
  /** Null until anything was ever saved. */
  readonly updatedAt: string | null;
}

interface SettingsRow {
  person_id: string;
  public: number;
  handle: string | null;
  overrides_json: string;
  owner_user_id: string | null;
  claimed_at: string | null;
  claim_method: string | null;
  published_at: string | null;
  updated_at: string;
}

function parseOverrides(json: string): Overrides {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Overrides) : {};
  } catch {
    return {};
  }
}

const DEFAULTS = (personId: string): ProfileSettings => ({
  personId,
  public: false,
  handle: null,
  overrides: {},
  ownerUserId: null,
  claimedAt: null,
  claimMethod: null,
  publishedAt: null,
  updatedAt: null,
});

export async function loadSettings(db: Client, personId: string): Promise<ProfileSettings> {
  const row = await queryOne<SettingsRow>(
    db,
    'SELECT * FROM openprofile_settings WHERE person_id = ?',
    [personId],
  );
  if (!row) return DEFAULTS(personId);
  return {
    personId,
    public: row.public === 1,
    handle: row.handle,
    overrides: parseOverrides(row.overrides_json),
    ownerUserId: row.owner_user_id,
    claimedAt: row.claimed_at,
    claimMethod: row.claim_method,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

export interface SettingsPatch {
  readonly overrides?: Overrides;
  readonly public?: boolean;
  readonly handle?: string | null;
  readonly claim?: { userId: string | null; method: 'email' | 'profile' | 'operator' };
}

/** Upsert; every field not in the patch keeps its stored value. Returns the row as now stored. */
export async function saveSettings(
  db: Client,
  personId: string,
  patch: SettingsPatch,
  stamp = now(),
): Promise<ProfileSettings> {
  const current = await loadSettings(db, personId);
  const isPublic = patch.public ?? current.public;
  const next: ProfileSettings = {
    personId,
    public: isPublic,
    handle: patch.handle === undefined ? current.handle : patch.handle,
    overrides: patch.overrides ?? current.overrides,
    ownerUserId: patch.claim ? patch.claim.userId : current.ownerUserId,
    claimedAt: patch.claim ? stamp : current.claimedAt,
    claimMethod: patch.claim ? patch.claim.method : current.claimMethod,
    publishedAt: isPublic && !current.public ? stamp : isPublic ? current.publishedAt : null,
    updatedAt: stamp,
  };
  await db.execute({
    sql: `INSERT INTO openprofile_settings (person_id, public, handle, overrides_json, owner_user_id,
                                            claimed_at, claim_method, published_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(person_id) DO UPDATE SET
            public = excluded.public, handle = excluded.handle, overrides_json = excluded.overrides_json,
            owner_user_id = excluded.owner_user_id, claimed_at = excluded.claimed_at,
            claim_method = excluded.claim_method, published_at = excluded.published_at,
            updated_at = excluded.updated_at`,
    args: [
      personId,
      next.public ? 1 : 0,
      next.handle,
      JSON.stringify(next.overrides),
      next.ownerUserId,
      next.claimedAt,
      next.claimMethod,
      next.publishedAt,
      next.updatedAt,
    ],
  });
  return next;
}

/** Identity keys a public page never carries, whatever a source said. */
const PRIVATE_IDENTITY_KEYS = new Set(['email', 'phone', 'tel', 'mobile', 'address', 'whatsapp']);

/** Sections that exist to be reached at, which a public directory has no business holding. */
const PRIVATE_SECTIONS = new Set(['contact']);

/**
 * The document as a stranger may see it: no email, no phone, no contact
 * section, no mailto bullets anywhere. Everything else was on the open web
 * already, which is where the generator read it.
 */
export function publicView(doc: OpenProfileDoc): OpenProfileDoc {
  return {
    ...doc,
    identity: doc.identity.filter((entry) => !PRIVATE_IDENTITY_KEYS.has(entry.key.toLowerCase())),
    sections: doc.sections
      .filter((section) => !PRIVATE_SECTIONS.has(section.name))
      .map((section) => ({
        ...section,
        body: section.body
          .split('\n')
          .filter((line) => !/mailto:|\btel:/i.test(line))
          .join('\n')
          .trim(),
      }))
      .filter((section) => section.body !== ''),
  };
}

/** The generated Markdown with the owner's overlay applied, public or private view. */
export function composeProfile(
  generated: string,
  overrides: Overrides,
  view: 'public' | 'private',
): { doc: OpenProfileDoc; markdown: string } {
  const withOverrides = applyOverrides(parseOpenProfile(generated), overrides);
  const doc = view === 'public' ? publicView(withOverrides) : withOverrides;
  return { doc, markdown: renderOpenProfile(doc) };
}

/**
 * The overlay a request body means. A Markdown body is the whole file, so
 * everything in it becomes an override and the sections it lacks stay with
 * the generator; a JSON body is a partial merge over what is stored.
 */
export function overridesFromRequest(
  contentType: string | null,
  body: string | Record<string, unknown>,
  generated: string,
  stored: Overrides,
): Overrides {
  if (typeof body === 'string' || /text\/(markdown|plain)/i.test(contentType ?? '')) {
    const markdown = typeof body === 'string' ? body : String(body.markdown ?? '');
    return mergeOverrides(stored, overridesFromDocument(markdown, parseOpenProfile(generated)));
  }
  if (typeof body.markdown === 'string') {
    return mergeOverrides(
      stored,
      overridesFromDocument(body.markdown, parseOpenProfile(generated)),
    );
  }
  const patch: Overrides = {};
  if (typeof body.name === 'string' || body.name === null) patch.name = body.name as string | null;
  if (typeof body.headline === 'string' || body.headline === null)
    patch.headline = body.headline as string | null;
  if (typeof body.prose === 'string' || body.prose === null)
    patch.prose = body.prose as string | null;
  if (body.identity && typeof body.identity === 'object') {
    patch.identity = {};
    for (const [key, value] of Object.entries(body.identity as Record<string, unknown>)) {
      if (typeof value === 'string' || value === null) patch.identity[key] = value;
    }
  }
  if (body.sections && typeof body.sections === 'object') {
    patch.sections = {};
    for (const [key, value] of Object.entries(body.sections as Record<string, unknown>)) {
      if (typeof value === 'string') patch.sections[key] = value;
      else if (value === null) patch.sections[key] = 'none';
    }
  }
  return mergeOverrides(stored, patch);
}

/** Every email this deployment has verified as the person's own. */
export async function verifiedEmails(db: Client, personId: string): Promise<string[]> {
  const rows = await queryAll<{ address: string }>(
    db,
    `SELECT address FROM person_emails WHERE person_id = ? AND verified = 1
     UNION
     SELECT handle AS address FROM social_identities
      WHERE person_id = ? AND network = 'email' AND handle IS NOT NULL AND confidence >= 0.9`,
    [personId, personId],
  );
  const out = new Set<string>();
  for (const row of rows) {
    const email = normaliseEmail(row.address);
    if (email) out.add(email);
  }
  return [...out];
}

/** The claims of an OpenAccess access token, as far as this module reads them. */
export interface BearerClaims {
  readonly sub?: unknown;
  readonly scope?: unknown;
  readonly email?: unknown;
  readonly profile?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Whether a bearer may edit this person's profile: the token must carry the
 * edit scope, and its principal must be the person, shown by an email this
 * deployment verified for them or by the OpenProfile.md they publish.
 */
export function bearerMayEdit(
  claims: BearerClaims,
  subject: { emails: readonly string[]; publishedUrl: string | null },
): { ok: true; method: 'email' | 'profile' } | { ok: false; reason: string } {
  const scopes = typeof claims.scope === 'string' ? claims.scope.split(/\s+/) : [];
  if (!scopes.includes(EDIT_SCOPE))
    return { ok: false, reason: `token lacks the ${EDIT_SCOPE} scope` };
  const email = typeof claims.email === 'string' ? normaliseEmail(claims.email) : null;
  if (email && subject.emails.includes(email)) return { ok: true, method: 'email' };
  const profile = typeof claims.profile === 'string' ? claims.profile : null;
  if (
    profile &&
    subject.publishedUrl &&
    normaliseUrl(profile) === normaliseUrl(subject.publishedUrl)
  )
    return { ok: true, method: 'profile' };
  return { ok: false, reason: 'the token is not for the person this profile is about' };
}

/** What the listing says about one public profile, derived from the served document. */
export function listingEntry(
  doc: OpenProfileDoc,
  personId: string,
  updatedAt: string,
  origin: string,
): {
  id: string;
  name: string | null;
  url: string;
  page: string;
  updatedAt: string;
  accounts: string[];
  web: string | null;
} {
  const url = `${origin}/api/v1/people/${encodeURIComponent(personId)}/openprofile.md`;
  return {
    id: personId,
    name: doc.name,
    url,
    // OutreachGraph has no public person page; the file is the page.
    page: url,
    updatedAt,
    accounts: accounts(doc)
      .map((entry) => entry.url)
      .filter((entry) => /^https?:\/\//i.test(entry)),
    web: identityValue(doc, 'Web'),
  };
}

/** The opaque cursor of the listing: where the previous page stopped. */
export function encodeCursor(updatedAt: string, personId: string): string {
  return Buffer.from(`${updatedAt}|${personId}`, 'utf8').toString('base64url');
}

export function decodeCursor(
  cursor: string | undefined,
): { updatedAt: string; personId: string } | undefined {
  if (!cursor) return undefined;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const at = text.indexOf('|');
  if (at <= 0) return undefined;
  return { updatedAt: text.slice(0, at), personId: text.slice(at + 1) };
}
