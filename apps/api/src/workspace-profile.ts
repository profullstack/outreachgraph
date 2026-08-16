/**
 * What you sell, who buys it, how you write — per product.
 *
 * Three tables that already existed and nothing ever filled — `offerings`,
 * `campaign_filters` and `voice_profiles`. Until now the only thing writing
 * them was the test seed, and the default campaign bootstrapped an offering
 * named "Your offering" with placeholder text that every draft was then
 * grounded in.
 *
 * **A workspace sells more than one thing.** The schema always allowed it —
 * `offerings` is keyed by workspace and every campaign names the one it sells
 * — but every read here was `ORDER BY created_at ASC LIMIT 1`, so setup could
 * only ever see the first row and saving a second product silently overwrote
 * the first. That is the constraint this module used to impose on the product,
 * and it was never in the data model.
 *
 * So each product now owns the three things that make its outreach specific:
 *
 *   - its **offering** — the claims a draft is allowed to ground itself in,
 *   - its **voice profile** — a security product and a design tool should not
 *     sound the same,
 *   - its **campaign and ICP filters** — different buyers, different titles.
 *
 * Upserts rather than inserts throughout: this is a setup step people re-run
 * after changing their site or getting the ICP wrong the first time, and a
 * second run must correct that product rather than create a rival one.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import type { WorkspaceProfile } from '@outreachgraph/contracts';

export interface SavedProfile {
  readonly offeringId: string;
  readonly voiceProfileId: string;
  readonly campaignId: string;
}

/** JSON columns hold arrays; this keeps the encoding in one place. */
function list(values: readonly string[] | undefined): string {
  return JSON.stringify(values ?? []);
}

function parseList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export class UnknownProductError extends Error {
  constructor(offeringId: string) {
    super(`no product ${offeringId} in this workspace`);
    this.name = 'UnknownProductError';
  }
}

/**
 * Resolves which product is being written.
 *
 * An explicit id is scoped to the workspace before it is trusted — this value
 * arrives from a request body, and an unchecked id would let one workspace
 * rewrite another's offering.
 *
 * `create` is what makes a *second* product possible: without it, saving a new
 * one lands on the first row and overwrites the product the user already had.
 */
async function resolveOffering(
  db: Client,
  workspaceId: string,
  profile: WorkspaceProfile,
  create: boolean,
): Promise<{ id: string; existing: boolean }> {
  if (profile.offeringId) {
    const owned = await queryOne<{ id: string }>(
      db,
      'SELECT id FROM offerings WHERE id = ? AND workspace_id = ?',
      [profile.offeringId, workspaceId],
    );

    if (!owned) throw new UnknownProductError(profile.offeringId);
    return { id: owned.id, existing: true };
  }

  if (create) return { id: newId('offering'), existing: false };

  const first = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM offerings WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1',
    [workspaceId],
  );

  return first ? { id: first.id, existing: true } : { id: newId('offering'), existing: false };
}

export async function saveWorkspaceProfile(
  db: Client,
  workspaceId: string,
  profile: WorkspaceProfile,
  /** True to add a product rather than edit one. */
  options: { create?: boolean } = {},
): Promise<SavedProfile> {
  const stamp = now();

  const target = await resolveOffering(db, workspaceId, profile, options.create === true);
  const offeringId = target.id;
  const existingOffering = target.existing ? { id: offeringId } : undefined;

  if (existingOffering) {
    await db.execute({
      sql: `UPDATE offerings SET name = ?, category = ?, url = ?, description = ?,
              value_propositions = ?, likely_pains = ?, competitors = ?, updated_at = ?
             WHERE id = ?`,
      args: [
        profile.offering.name,
        profile.offering.category,
        profile.url ?? null,
        profile.offering.description ?? null,
        list(profile.offering.valuePropositions),
        list(profile.offering.likelyPains),
        list(profile.offering.competitors),
        stamp,
        offeringId,
      ],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO offerings (id, workspace_id, name, category, url, description,
              value_propositions, likely_pains, competitors, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        offeringId,
        workspaceId,
        profile.offering.name,
        profile.offering.category,
        profile.url ?? null,
        profile.offering.description ?? null,
        list(profile.offering.valuePropositions),
        list(profile.offering.likelyPains),
        list(profile.offering.competitors),
        stamp,
        stamp,
      ],
    });
  }

  // The campaign that sells this product, not merely the workspace's first.
  //
  // Reading the first campaign was what made a second product impossible: it
  // repointed the one campaign at the new offering, so the previous product
  // stopped being sold the moment another was described.
  const existingCampaign = await queryOne<{ id: string; voice_profile_id: string | null }>(
    db,
    `SELECT id, voice_profile_id FROM campaigns
      WHERE workspace_id = ? AND offering_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`,
    [workspaceId, offeringId],
  );

  // A campaign created before this workspace had a profile points at the
  // placeholder offering. Adopting it — rather than leaving it behind and
  // making a second one — is what stops a first-time setup producing two
  // campaigns for the same product.
  const adoptable = existingCampaign
    ? undefined
    : await queryOne<{ id: string; voice_profile_id: string | null }>(
        db,
        `SELECT c.id, c.voice_profile_id FROM campaigns c
           JOIN offerings o ON o.id = c.offering_id
          WHERE c.workspace_id = ? AND o.name = 'Unconfigured offering'
          ORDER BY c.created_at ASC LIMIT 1`,
        [workspaceId],
      );

  const campaign = existingCampaign ?? adoptable;

  // One voice per product: a security tool and a design tool should not sound
  // the same, and they did when every campaign shared the workspace's first.
  const voiceProfileId = campaign?.voice_profile_id ?? newId('voiceProfile');

  if (campaign?.voice_profile_id) {
    await db.execute({
      sql: `UPDATE voice_profiles SET name = ?, style = ?, instructions = ?, max_words = ?,
              updated_at = ? WHERE id = ?`,
      args: [
        profile.offering.name,
        profile.voice.style,
        profile.voice.instructions ?? null,
        profile.voice.maxWords ?? null,
        stamp,
        voiceProfileId,
      ],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO voice_profiles (id, workspace_id, name, style, instructions, max_words,
              created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        voiceProfileId,
        workspaceId,
        profile.offering.name,
        profile.voice.style,
        profile.voice.instructions ?? null,
        profile.voice.maxWords ?? null,
        stamp,
        stamp,
      ],
    });
  }

  const campaignId = campaign?.id ?? newId('campaign');

  if (campaign) {
    await db.execute({
      sql: `UPDATE campaigns SET name = ?, offering_id = ?, voice_profile_id = ?, updated_at = ?
             WHERE id = ?`,
      args: [profile.offering.name, offeringId, voiceProfileId, stamp, campaignId],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO campaigns (id, workspace_id, name, offering_id, voice_profile_id,
              approval_mode, status, created_at, updated_at, started_at)
            VALUES (?, ?, ?, ?, ?, 'draft_and_approve', 'active', ?, ?, ?)`,
      args: [
        campaignId,
        workspaceId,
        profile.offering.name,
        offeringId,
        voiceProfileId,
        stamp,
        stamp,
        stamp,
      ],
    });
  }

  await db.execute({
    sql: `INSERT INTO campaign_filters (campaign_id, titles, seniorities, industries,
            technologies, keywords, exclusions, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(campaign_id) DO UPDATE SET
            titles = excluded.titles, seniorities = excluded.seniorities,
            industries = excluded.industries, technologies = excluded.technologies,
            keywords = excluded.keywords, exclusions = excluded.exclusions,
            updated_at = excluded.updated_at`,
    args: [
      campaignId,
      list(profile.icp.titles),
      list(profile.icp.seniorities),
      list(profile.icp.industries),
      list(profile.icp.technologies),
      list(profile.icp.keywords),
      list(profile.icp.exclusions),
      stamp,
    ],
  });

  return { offeringId, voiceProfileId, campaignId };
}

export interface LoadedProfile {
  readonly configured: boolean;
  readonly offeringId?: string;
  readonly url?: string;
  readonly offering?: WorkspaceProfile['offering'];
  readonly icp?: WorkspaceProfile['icp'];
  readonly voice?: WorkspaceProfile['voice'];
  /** Every product in the workspace, so the UI can offer a choice. */
  readonly products?: ProductSummary[];
}

export interface ProductSummary {
  readonly offeringId: string;
  readonly name: string;
  readonly category: string;
  readonly url: string | null;
  readonly campaignId: string | null;
  readonly campaignStatus: string | null;
  readonly autopilot: boolean;
  /** False for the placeholder a first campaign bootstraps. */
  readonly configured: boolean;
}

/**
 * Every product the workspace sells.
 *
 * The placeholder offering a bare campaign bootstraps is included but marked
 * unconfigured — hiding it would leave a campaign running against a product
 * the settings page swears does not exist.
 */
export async function listProducts(db: Client, workspaceId: string): Promise<ProductSummary[]> {
  const rows = await db.execute({
    sql: `SELECT o.id, o.name, o.category, o.url,
                 c.id AS campaign_id, c.status AS campaign_status, c.approval_mode
            FROM offerings o
            LEFT JOIN campaigns c ON c.offering_id = o.id AND c.workspace_id = o.workspace_id
           WHERE o.workspace_id = ?
        ORDER BY o.created_at ASC`,
    args: [workspaceId],
  });

  const seen = new Set<string>();
  const products: ProductSummary[] = [];

  for (const row of rows.rows as unknown as {
    id: string;
    name: string;
    category: string;
    url: string | null;
    campaign_id: string | null;
    campaign_status: string | null;
    approval_mode: string | null;
  }[]) {
    // A product with two campaigns would otherwise appear twice; the first is
    // the one setup edits.
    if (seen.has(row.id)) continue;
    seen.add(row.id);

    products.push({
      offeringId: row.id,
      name: row.name,
      category: row.category,
      url: row.url,
      campaignId: row.campaign_id,
      campaignStatus: row.campaign_status,
      autopilot: row.approval_mode === 'trusted_automation',
      configured: row.name !== 'Unconfigured offering' && row.name !== 'Your offering',
    });
  }

  return products;
}

export async function loadWorkspaceProfile(
  db: Client,
  workspaceId: string,
  /** Which product to load. Defaults to the first, as it always did. */
  offeringId?: string,
): Promise<LoadedProfile> {
  const products = await listProducts(db, workspaceId);

  const offering = await queryOne<{
    id: string;
    name: string;
    category: string;
    url: string | null;
    description: string | null;
    value_propositions: string;
    likely_pains: string;
    competitors: string;
  }>(
    db,
    offeringId
      ? `SELECT id, name, category, url, description, value_propositions, likely_pains, competitors
           FROM offerings WHERE workspace_id = ? AND id = ?`
      : `SELECT id, name, category, url, description, value_propositions, likely_pains, competitors
           FROM offerings WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1`,
    offeringId ? [workspaceId, offeringId] : [workspaceId],
  );

  // The voice belonging to this product's campaign, not the workspace's first
  // — with several products, the first is another product's voice.
  const voice = offering
    ? await queryOne<{
        style: string;
        instructions: string | null;
        max_words: number | null;
      }>(
        db,
        `SELECT v.style, v.instructions, v.max_words
           FROM voice_profiles v
           JOIN campaigns c ON c.voice_profile_id = v.id
          WHERE c.workspace_id = ? AND c.offering_id = ?
          ORDER BY c.created_at ASC LIMIT 1`,
        [workspaceId, offering.id],
      )
    : undefined;

  // A voice profile is the signal, because only completing setup creates one —
  // the campaign bootstrap writes a placeholder offering but never a voice.
  // Keying off the offering instead meant comparing its name to the literal
  // string "Your offering", which is the kind of check that silently stops
  // working the day somebody edits the bootstrap copy.
  if (!offering || !voice) return { configured: false, products };

  const filters = await queryOne<{
    titles: string;
    seniorities: string;
    industries: string;
    technologies: string;
    keywords: string;
    exclusions: string;
  }>(
    db,
    // Scoped to this product's campaign. Unscoped, a second product's ICP was
    // read from the first product's filters.
    `SELECT f.titles, f.seniorities, f.industries, f.technologies, f.keywords, f.exclusions
       FROM campaign_filters f
       JOIN campaigns c ON c.id = f.campaign_id
      WHERE c.workspace_id = ? AND c.offering_id = ?
      ORDER BY c.created_at ASC LIMIT 1`,
    [workspaceId, offering.id],
  );

  return {
    configured: true,
    offeringId: offering.id,
    products,
    ...(offering.url ? { url: offering.url } : {}),
    offering: {
      name: offering.name,
      category: offering.category,
      ...(offering.description ? { description: offering.description } : {}),
      valuePropositions: parseList(offering.value_propositions),
      likelyPains: parseList(offering.likely_pains),
      competitors: parseList(offering.competitors),
    },
    icp: {
      titles: parseList(filters?.titles),
      seniorities: parseList(filters?.seniorities),
      industries: parseList(filters?.industries),
      technologies: parseList(filters?.technologies),
      keywords: parseList(filters?.keywords),
      exclusions: parseList(filters?.exclusions),
    },
    voice: {
      style: voice.style,
      ...(voice.instructions ? { instructions: voice.instructions } : {}),
      ...(voice.max_words ? { maxWords: voice.max_words } : {}),
    },
  };
}
