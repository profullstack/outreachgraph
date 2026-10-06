/**
 * Screened leads: who is held back from cold outreach, and the human override.
 *
 * Screening itself is pure (`@outreachgraph/domain`, `screenLead`) and runs at
 * import. This is what reads its verdict back. The hold is enforced where every
 * other "do not contact" is, as an input to the policy engine
 * (`personScreenedOut`), so the approval queue, autopilot, cadences and card
 * generation all refuse the same person for the same reason, and an answer to
 * someone who wrote back is never blocked by it.
 */

import { describeFindings, parseFindings, type ScreenFinding } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';

/**
 * Why this person is held back from cold outreach in this workspace, or
 * undefined when they are not (never screened, screened clean, or allowed).
 */
export async function screenHold(
  db: Client,
  workspaceId: string,
  personId: string,
): Promise<string | undefined> {
  const row = await queryOne<{ findings: string }>(
    db,
    `SELECT findings FROM lead_screens
      WHERE workspace_id = ? AND person_id = ? AND allowed_at IS NULL`,
    [workspaceId, personId],
  );
  return holdReason(row?.findings);
}

/** The policy engine's reason text from stored findings, or undefined for none. */
export function holdReason(json: string | null | undefined): string | undefined {
  const findings = parseFindings(json);
  return findings.length > 0
    ? `${describeFindings(findings)}. Allow the lead to send to them anyway.`
    : undefined;
}

/**
 * Sends to a screened lead anyway (`allow: true`), or holds them back again.
 * Returns false when screening never held this person.
 */
export async function setScreenAllowed(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly personId: string;
    readonly allow: boolean;
    readonly userId?: string | undefined;
  },
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE lead_screens SET allowed_at = ?, allowed_by = ?
           WHERE workspace_id = ? AND person_id = ?`,
    args: [
      input.allow ? now() : null,
      input.allow ? (input.userId ?? 'api') : null,
      input.workspaceId,
      input.personId,
    ],
  });
  return result.rowsAffected > 0;
}

export interface ScreenedLead {
  readonly personId: string;
  readonly name: string;
  readonly email: string | null;
  readonly findings: readonly ScreenFinding[];
  readonly screenedAt: string;
  readonly allowedAt: string | null;
}

/**
 * The campaign's screened leads, held first. With `includeAllowed` false
 * (the default) only the ones still held back are listed.
 */
export async function screenedLeads(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly campaignId: string;
    readonly includeAllowed?: boolean;
    readonly limit?: number;
  },
): Promise<ScreenedLead[]> {
  const rows = await queryAll<{
    person_id: string;
    display_name: string;
    email: string | null;
    findings: string;
    screened_at: string;
    allowed_at: string | null;
  }>(
    db,
    `SELECT ls.person_id, p.display_name, ls.findings, ls.screened_at, ls.allowed_at,
            (SELECT pe.address FROM person_emails pe
              WHERE pe.person_id = ls.person_id AND pe.workspace_id = ls.workspace_id
              ORDER BY pe.created_at LIMIT 1) AS email
       FROM lead_screens ls
       JOIN campaign_people cp ON cp.person_id = ls.person_id AND cp.campaign_id = ?
       JOIN people p ON p.id = ls.person_id
      WHERE ls.workspace_id = ? AND ls.findings != '[]' AND p.status != 'deleted'
        ${input.includeAllowed ? '' : 'AND ls.allowed_at IS NULL'}
      ORDER BY (ls.allowed_at IS NULL) DESC, ls.screened_at DESC
      LIMIT ?`,
    [input.campaignId, input.workspaceId, Math.min(input.limit ?? 200, 1000)],
  );

  return rows.map((row) => ({
    personId: row.person_id,
    name: row.display_name,
    email: row.email,
    findings: parseFindings(row.findings),
    screenedAt: row.screened_at,
    allowedAt: row.allowed_at,
  }));
}

/** How many of a campaign's leads screening is holding back right now. */
export async function countScreenedHeld(
  db: Client,
  workspaceId: string,
  campaignId: string,
): Promise<number> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM lead_screens ls
       JOIN campaign_people cp ON cp.person_id = ls.person_id AND cp.campaign_id = ?
      WHERE ls.workspace_id = ? AND ls.findings != '[]' AND ls.allowed_at IS NULL`,
    [campaignId, workspaceId],
  );
  return Number(row?.n ?? 0);
}
