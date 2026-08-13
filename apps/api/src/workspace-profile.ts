/**
 * The workspace's own profile: what you sell, who buys it, how you write.
 *
 * Three tables that already existed and nothing ever filled — `offerings`,
 * `campaign_filters` and `voice_profiles`. Until now the only thing writing
 * them was the test seed, and the default campaign bootstrapped an offering
 * named "Your offering" with placeholder text that every draft was then
 * grounded in.
 *
 * Upserts rather than inserts throughout: this is a setup step people re-run
 * after changing their site or getting the ICP wrong the first time, and a
 * second run must correct the profile rather than create a rival one.
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

export async function saveWorkspaceProfile(
  db: Client,
  workspaceId: string,
  profile: WorkspaceProfile,
): Promise<SavedProfile> {
  const stamp = now();

  const existingOffering = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM offerings WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1',
    [workspaceId],
  );

  const offeringId = existingOffering?.id ?? newId('offering');

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

  const existingVoice = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM voice_profiles WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1',
    [workspaceId],
  );

  const voiceProfileId = existingVoice?.id ?? newId('voiceProfile');

  if (existingVoice) {
    await db.execute({
      sql: `UPDATE voice_profiles SET style = ?, instructions = ?, max_words = ?, updated_at = ?
             WHERE id = ?`,
      args: [
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
            VALUES (?, ?, 'Default', ?, ?, ?, ?, ?)`,
      args: [
        voiceProfileId,
        workspaceId,
        profile.voice.style,
        profile.voice.instructions ?? null,
        profile.voice.maxWords ?? null,
        stamp,
        stamp,
      ],
    });
  }

  // The campaign is what joins the three together, and it is what the pipeline
  // reads. A workspace whose profile is set but whose campaign still points at
  // the placeholder offering would draft against text nobody wrote.
  const existingCampaign = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM campaigns WHERE workspace_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`,
    [workspaceId],
  );

  const campaignId = existingCampaign?.id ?? newId('campaign');

  if (existingCampaign) {
    await db.execute({
      sql: `UPDATE campaigns SET offering_id = ?, voice_profile_id = ?, updated_at = ? WHERE id = ?`,
      args: [offeringId, voiceProfileId, stamp, campaignId],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO campaigns (id, workspace_id, name, offering_id, voice_profile_id,
              approval_mode, status, created_at, updated_at, started_at)
            VALUES (?, ?, 'First campaign', ?, ?, 'draft_and_approve', 'active', ?, ?, ?)`,
      args: [campaignId, workspaceId, offeringId, voiceProfileId, stamp, stamp, stamp],
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
  readonly url?: string;
  readonly offering?: WorkspaceProfile['offering'];
  readonly icp?: WorkspaceProfile['icp'];
  readonly voice?: WorkspaceProfile['voice'];
}

export async function loadWorkspaceProfile(
  db: Client,
  workspaceId: string,
): Promise<LoadedProfile> {
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
    `SELECT id, name, category, url, description, value_propositions, likely_pains, competitors
       FROM offerings WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1`,
    [workspaceId],
  );

  const voice = await queryOne<{
    style: string;
    instructions: string | null;
    max_words: number | null;
  }>(
    db,
    `SELECT style, instructions, max_words FROM voice_profiles
       WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1`,
    [workspaceId],
  );

  // A voice profile is the signal, because only completing setup creates one —
  // the campaign bootstrap writes a placeholder offering but never a voice.
  // Keying off the offering instead meant comparing its name to the literal
  // string "Your offering", which is the kind of check that silently stops
  // working the day somebody edits the bootstrap copy.
  if (!offering || !voice) return { configured: false };

  const filters = await queryOne<{
    titles: string;
    seniorities: string;
    industries: string;
    technologies: string;
    keywords: string;
    exclusions: string;
  }>(
    db,
    `SELECT f.titles, f.seniorities, f.industries, f.technologies, f.keywords, f.exclusions
       FROM campaign_filters f
       JOIN campaigns c ON c.id = f.campaign_id
      WHERE c.workspace_id = ? ORDER BY c.created_at ASC LIMIT 1`,
    [workspaceId],
  );

  return {
    configured: true,
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
