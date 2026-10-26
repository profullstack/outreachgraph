/**
 * A product's "brain" as files: positioning, voice, audience and objections in
 * the shared markdown layout a marketing team keeps in a private git repo
 * (see docs/brain-repo.md and `renderBrain` in the domain package).
 *
 * Export reads the offering, its campaign's voice profile, the targeting of
 * every campaign that sells it, and the classified inbound replies those
 * campaigns received. Import writes positioning back to the offering and voice
 * back to the voice profile, including the samples and prohibited claims the
 * composer reads but the setup form never wrote.
 */

import { z } from 'zod';
import {
  mergeAudiences,
  newId,
  OBJECTION_LABELS,
  parseBrainFiles,
  renderBrain,
  summariseObjections,
  type BrainAudience,
  type BrainVoice,
  type ParsedBrain,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { profileLimits } from '@outreachgraph/contracts';

function parseJsonList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

interface OfferingRow {
  id: string;
  name: string;
  category: string;
  url: string | null;
  description: string | null;
  value_propositions: string;
  likely_pains: string;
  competitors: string;
}

interface VoiceRow {
  id: string;
  name: string;
  style: string;
  instructions: string | null;
  max_words: number | null;
  samples: string;
  prohibited_claims: string;
}

async function offeringFor(
  db: Client,
  workspaceId: string,
  offeringId: string,
): Promise<OfferingRow | undefined> {
  return queryOne<OfferingRow>(
    db,
    `SELECT id, name, category, url, description, value_propositions, likely_pains, competitors
       FROM offerings WHERE workspace_id = ? AND id = ?`,
    [workspaceId, offeringId],
  );
}

/** The voice of the campaign setup edits: active first, then oldest. */
async function voiceFor(
  db: Client,
  workspaceId: string,
  offeringId: string,
): Promise<VoiceRow | undefined> {
  return queryOne<VoiceRow>(
    db,
    `SELECT v.id, v.name, v.style, v.instructions, v.max_words, v.samples, v.prohibited_claims
       FROM voice_profiles v
       JOIN campaigns c ON c.voice_profile_id = v.id
      WHERE c.workspace_id = ? AND c.offering_id = ?
      ORDER BY CASE c.status WHEN 'active' THEN 0 ELSE 1 END, c.created_at ASC LIMIT 1`,
    [workspaceId, offeringId],
  );
}

/** How far back objections are read. Older pushback is about an older product. */
const OBJECTION_LIMIT = 500;

export interface BrainExport {
  readonly offeringId: string;
  readonly files: Record<string, string>;
}

export async function exportBrain(
  db: Client,
  workspaceId: string,
  offeringId: string,
  options: { slug?: string; exportedAt?: string } = {},
): Promise<BrainExport | undefined> {
  const offering = await offeringFor(db, workspaceId, offeringId);
  if (!offering) return undefined;

  const voice = await voiceFor(db, workspaceId, offeringId);

  const filters = await queryAll<Record<string, string>>(
    db,
    `SELECT f.titles, f.seniorities, f.industries, f.countries, f.technologies, f.keywords,
            f.exclusions
       FROM campaign_filters f
       JOIN campaigns c ON c.id = f.campaign_id
      WHERE c.workspace_id = ? AND c.offering_id = ?
      ORDER BY c.created_at ASC`,
    [workspaceId, offeringId],
  );
  const audience: BrainAudience = mergeAudiences(
    filters.map((f) => ({
      titles: parseJsonList(f.titles),
      seniorities: parseJsonList(f.seniorities),
      industries: parseJsonList(f.industries),
      countries: parseJsonList(f.countries),
      technologies: parseJsonList(f.technologies),
      keywords: parseJsonList(f.keywords),
      exclusions: parseJsonList(f.exclusions),
    })),
  );

  const labels = OBJECTION_LABELS.map(() => '?').join(', ');
  const replies = await queryAll<{
    reply_label: string;
    reply_label_reason: string;
    body: string | null;
    occurred_at: string;
    display_name: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    company_domain: string | null;
  }>(
    db,
    `SELECT i.reply_label, i.reply_label_reason, i.body, i.occurred_at,
            p.display_name, p.first_name, p.last_name,
            co.name AS company_name, co.domain AS company_domain
       FROM interactions i
       JOIN campaigns c ON c.id = i.campaign_id
       LEFT JOIN people p ON p.id = i.person_id
       LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE i.workspace_id = ? AND c.workspace_id = ? AND c.offering_id = ?
        AND i.direction = 'inbound'
        AND i.reply_label IN (${labels})
        AND i.reply_label_reason IS NOT NULL AND i.reply_label_reason != ''
      ORDER BY i.occurred_at DESC
      LIMIT ${OBJECTION_LIMIT}`,
    [workspaceId, workspaceId, offeringId, ...OBJECTION_LABELS],
  );

  // The workspace's own people sign the emails being replied to, so their
  // names turn up in greetings and quotes too.
  const team = await queryAll<{ name: string | null }>(
    db,
    `SELECT u.name FROM users u
       JOIN organization_members m ON m.user_id = u.id
       JOIN workspaces w ON w.organization_id = m.organization_id
      WHERE w.id = ?`,
    [workspaceId],
  );
  const teamNames = team.map((t) => t.name ?? '').filter(Boolean);

  const objections = summariseObjections(
    replies.map((r) => ({
      label: r.reply_label,
      reason: r.reply_label_reason,
      body: r.body,
      occurredAt: r.occurred_at,
      names: [
        r.display_name,
        r.first_name,
        r.last_name,
        r.company_name,
        r.company_domain,
        ...teamNames,
      ].filter((n): n is string => typeof n === 'string' && n.trim().length > 0),
    })),
  );

  const brainVoice: BrainVoice | undefined = voice
    ? {
        name: voice.name,
        style: voice.style,
        instructions: voice.instructions,
        maxWords: voice.max_words,
        samples: parseJsonList(voice.samples),
        prohibitedClaims: parseJsonList(voice.prohibited_claims),
      }
    : undefined;

  const files = renderBrain(
    {
      product: {
        offeringId: offering.id,
        name: offering.name,
        url: offering.url,
        category: offering.category,
        description: offering.description,
        valuePropositions: parseJsonList(offering.value_propositions),
        likelyPains: parseJsonList(offering.likely_pains),
        competitors: parseJsonList(offering.competitors),
      },
      ...(brainVoice ? { voice: brainVoice } : {}),
    },
    {
      audience,
      objections,
      ...(options.slug ? { slug: options.slug } : {}),
      ...(options.exportedAt ? { exportedAt: options.exportedAt } : {}),
    },
  );

  return { offeringId: offering.id, files };
}

// ------------------------------------------------------------------ import

/** Total bytes a brain import may carry. Knowledge files are prose, not assets. */
export const BRAIN_MAX_BYTES = 512 * 1024;

export const brainImportSchema = z.object({
  files: z
    .record(z.string().max(300), z.string())
    .refine((files) => Object.keys(files).length <= 50, {
      message: 'at most 50 files',
    }),
  slug: z.string().trim().max(64).optional(),
});

const term = z.string().trim().min(1).max(profileLimits.term);
const sentence = z.string().trim().min(1).max(profileLimits.sentence);

const productPatch = z.object({
  name: z.string().trim().min(1).max(profileLimits.label).optional(),
  category: z.string().trim().min(1).max(profileLimits.label).optional(),
  url: z.string().trim().max(profileLimits.url).nullable().optional(),
  description: z.string().trim().max(profileLimits.description).nullable().optional(),
  valuePropositions: z.array(sentence).max(profileLimits.entries).optional(),
  likelyPains: z.array(sentence).max(profileLimits.entries).optional(),
  competitors: z.array(term).max(profileLimits.entries).optional(),
});

const voicePatch = z.object({
  style: z.string().trim().min(1).max(profileLimits.style).optional(),
  instructions: z.string().trim().max(profileLimits.instructions).nullable().optional(),
  maxWords: z.number().int().positive().max(400).nullable().optional(),
  samples: z
    .array(z.string().trim().min(1).max(profileLimits.instructions))
    .max(profileLimits.entries)
    .optional(),
  prohibitedClaims: z.array(sentence).max(profileLimits.entries).optional(),
});

export class BrainValidationError extends Error {
  readonly details: Record<string, string[]>;
  constructor(message: string, details: Record<string, string[]>) {
    super(message);
    this.name = 'BrainValidationError';
    this.details = details;
  }
}

function issues(prefix: string, error: z.ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = [prefix, ...issue.path].join('.');
    (details[key] ??= []).push(issue.message);
  }
  return details;
}

/** Parses and validates; throws BrainValidationError with field paths. */
export function validateBrain(files: Readonly<Record<string, string>>, slug?: string): ParsedBrain {
  const bytes = Object.values(files).reduce((sum, f) => sum + Buffer.byteLength(f), 0);
  if (bytes > BRAIN_MAX_BYTES) {
    throw new BrainValidationError('brain files are too large', {
      files: [`${bytes} bytes; at most ${BRAIN_MAX_BYTES}`],
    });
  }

  const parsed = parseBrainFiles(files, slug ? { slug } : {});
  if (!parsed.product && !parsed.voice) {
    throw new BrainValidationError('no knowledge/positioning.md or knowledge/voice.md found', {
      files: [slug ? `expected knowledge/${slug}/positioning.md` : 'expected knowledge/*.md'],
    });
  }

  const details: Record<string, string[]> = {};
  const product = parsed.product ? productPatch.safeParse(parsed.product) : undefined;
  if (product && !product.success) Object.assign(details, issues('positioning', product.error));
  const voice = parsed.voice ? voicePatch.safeParse(parsed.voice) : undefined;
  if (voice && !voice.success) Object.assign(details, issues('voice', voice.error));
  if (Object.keys(details).length > 0) {
    throw new BrainValidationError('those brain files do not fit', details);
  }

  return {
    ...(product?.success ? { product: product.data } : {}),
    ...(voice?.success ? { voice: voice.data } : {}),
  };
}

export interface BrainImportResult {
  readonly offeringId: string;
  readonly product: readonly string[];
  readonly voice: readonly string[];
  readonly voiceProfileId: string | null;
}

/**
 * Writes what the files say, and only that: a field absent from the files
 * keeps its stored value, so a brain holding only voice.md cannot blank the
 * product's positioning.
 */
export async function importBrain(
  db: Client,
  workspaceId: string,
  offeringId: string,
  parsed: ParsedBrain,
): Promise<BrainImportResult | undefined> {
  const offering = await offeringFor(db, workspaceId, offeringId);
  if (!offering) return undefined;
  const stamp = now();

  const productFields: string[] = [];
  if (parsed.product) {
    const p = parsed.product;
    const next = {
      name: p.name ?? offering.name,
      category: p.category ?? offering.category,
      url: p.url !== undefined ? p.url || null : offering.url,
      description: p.description !== undefined ? p.description || null : offering.description,
      value_propositions: p.valuePropositions
        ? JSON.stringify(p.valuePropositions)
        : offering.value_propositions,
      likely_pains: p.likelyPains ? JSON.stringify(p.likelyPains) : offering.likely_pains,
      competitors: p.competitors ? JSON.stringify(p.competitors) : offering.competitors,
    };
    for (const [key, value] of Object.entries(next)) {
      if (value !== (offering as unknown as Record<string, unknown>)[key]) productFields.push(key);
    }
    if (productFields.length > 0) {
      await db.execute({
        sql: `UPDATE offerings SET name = ?, category = ?, url = ?, description = ?,
                value_propositions = ?, likely_pains = ?, competitors = ?, updated_at = ?
               WHERE id = ? AND workspace_id = ?`,
        args: [
          next.name,
          next.category,
          next.url,
          next.description,
          next.value_propositions,
          next.likely_pains,
          next.competitors,
          stamp,
          offeringId,
          workspaceId,
        ],
      });
    }
  }

  const voiceFields: string[] = [];
  let voiceProfileId: string | null = null;
  if (parsed.voice) {
    const v = parsed.voice;
    const existing = await voiceFor(db, workspaceId, offeringId);

    const next = {
      style: v.style ?? existing?.style ?? 'direct and specific',
      instructions:
        v.instructions !== undefined ? v.instructions || null : (existing?.instructions ?? null),
      max_words: v.maxWords !== undefined ? v.maxWords : (existing?.max_words ?? null),
      samples: v.samples ? JSON.stringify(v.samples) : (existing?.samples ?? '[]'),
      prohibited_claims: v.prohibitedClaims
        ? JSON.stringify(v.prohibitedClaims)
        : (existing?.prohibited_claims ?? '[]'),
    };

    if (existing) {
      voiceProfileId = existing.id;
      for (const [key, value] of Object.entries(next)) {
        if (value !== (existing as unknown as Record<string, unknown>)[key]) voiceFields.push(key);
      }
      if (voiceFields.length > 0) {
        await db.execute({
          sql: `UPDATE voice_profiles SET style = ?, instructions = ?, max_words = ?, samples = ?,
                  prohibited_claims = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
          args: [
            next.style,
            next.instructions,
            next.max_words,
            next.samples,
            next.prohibited_claims,
            stamp,
            existing.id,
            workspaceId,
          ],
        });
      }
    } else {
      // No voice yet: create one and give it to the product's campaign, which
      // is where the composer looks for it.
      const campaign = await queryOne<{ id: string }>(
        db,
        `SELECT id FROM campaigns WHERE workspace_id = ? AND offering_id = ?
          ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`,
        [workspaceId, offeringId],
      );
      voiceProfileId = newId('voiceProfile');
      await db.execute({
        sql: `INSERT INTO voice_profiles (id, workspace_id, name, style, instructions, samples,
                max_words, prohibited_claims, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          voiceProfileId,
          workspaceId,
          parsed.product?.name ?? offering.name,
          next.style,
          next.instructions,
          next.samples,
          next.max_words,
          next.prohibited_claims,
          stamp,
          stamp,
        ],
      });
      if (campaign) {
        await db.execute({
          sql: 'UPDATE campaigns SET voice_profile_id = ?, updated_at = ? WHERE id = ?',
          args: [voiceProfileId, stamp, campaign.id],
        });
      }
      voiceFields.push(...Object.keys(next));
    }
  }

  return { offeringId, product: productFields, voice: voiceFields, voiceProfileId };
}
