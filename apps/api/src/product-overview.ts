/**
 * One product, top to bottom: what it sells, who buys it, who we found, what
 * we wrote, and what came back.
 *
 * The product page used to be a settings form. Someone running fifty products
 * on autopilot does not open a product to edit its claims; they open it to see
 * whether it is working. This is everything that question needs in one read,
 * in the order the machine does it — the same shape AutoGTM tools use for a
 * project page, because it is the shape of the work.
 */

import { queryAll, type Client } from '@outreachgraph/db';
import { listCampaigns, type CampaignSummary } from './campaigns';
import {
  listProducts,
  loadWorkspaceProfile,
  type LoadedProfile,
  type ProductSummary,
} from './workspace-profile';

export interface LeadRow {
  readonly person_id: string;
  readonly name: string;
  readonly title: string | null;
  readonly company: string | null;
  readonly avatar_url: string | null;
  readonly stage: string;
  readonly contact: string;
  readonly match: number | null;
}

export interface MessageRow {
  readonly id: string;
  readonly person_id: string;
  readonly name: string;
  readonly company: string | null;
  readonly network: string;
  readonly status: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly created_at: string;
}

export interface ProductOverview {
  readonly product: ProductSummary;
  readonly profile: LoadedProfile;
  readonly campaign: CampaignSummary | null;
  readonly leads: readonly LeadRow[];
  readonly messages: readonly MessageRow[];
}

const LEADS = 50;
const MESSAGES = 10;

export async function loadProductOverview(
  db: Client,
  workspaceId: string,
  offeringId: string,
): Promise<ProductOverview | undefined> {
  const product = (await listProducts(db, workspaceId)).find((p) => p.offeringId === offeringId);
  if (!product) return undefined;

  const [profile, campaigns] = await Promise.all([
    loadWorkspaceProfile(db, workspaceId, offeringId),
    listCampaigns(db, workspaceId),
  ]);
  const campaign = campaigns.find((c) => c.id === product.campaignId) ?? null;

  if (!campaign) return { product, profile, campaign, leads: [], messages: [] };

  const [leads, messages] = await Promise.all([
    queryAll<Omit<LeadRow, 'match'> & { match_score: number | null }>(
      db,
      `SELECT p.id AS person_id, p.display_name AS name, p.current_title AS title,
              co.name AS company, p.avatar_url, cp.status AS stage,
              cp.interaction_state AS contact, s.opportunity AS match_score
         FROM campaign_people cp
         JOIN people p ON p.id = cp.person_id
         LEFT JOIN companies co ON co.id = p.current_company_id
         LEFT JOIN scores s ON s.person_id = cp.person_id AND s.campaign_id = cp.campaign_id
        WHERE cp.campaign_id = ? AND cp.workspace_id = ? AND p.status != 'deleted'
        ORDER BY COALESCE(s.opportunity, -1) DESC, cp.discovered_at DESC
        LIMIT ?`,
      [campaign.id, workspaceId, LEADS],
    ),
    queryAll<MessageRow>(
      db,
      `SELECT r.id, r.person_id, p.display_name AS name, co.name AS company, r.network,
              r.status, d.subject, d.body, r.created_at
         FROM recommendations r
         JOIN people p ON p.id = r.person_id
         LEFT JOIN companies co ON co.id = p.current_company_id
         JOIN drafts d ON d.recommendation_id = r.id
        WHERE r.campaign_id = ? AND r.workspace_id = ?
        ORDER BY r.created_at DESC
        LIMIT ?`,
      [campaign.id, workspaceId, MESSAGES],
    ),
  ]);

  return {
    product,
    profile,
    campaign,
    // `match_score`, not `match`, in the SQL: the Postgres driver reads a
    // bare MATCH as an FTS5 query and refuses the statement outright.
    leads: leads.map(({ match_score, ...row }) => ({
      ...row,
      match: match_score === null ? null : Math.round(Number(match_score)),
    })),
    messages,
  };
}
