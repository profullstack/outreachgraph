/**
 * Account expansion at send time: one contact per company at a time, in
 * persona order. The rules are in `@outreachgraph/domain` (`personas.ts`).
 */

import {
  classifyPersona,
  EXPANSION_GAP_DAYS,
  PERSONA_LABELS,
  personaRank,
  type PersonaOrUnknown,
} from '@outreachgraph/domain';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';

export interface CompanyBusy {
  readonly personId: string;
  readonly name: string;
  readonly persona: PersonaOrUnknown;
  /** When the colleague's window closes and the next person may be written to. */
  readonly until: string;
}

/**
 * The colleague currently "holding" a company, if any: someone else there who
 * is on an active cadence, or was emailed within the last 21 days and has not
 * answered. A reply ends the hold — the company is talking to us, and the next
 * person is introduced by reference rather than kept waiting.
 */
export async function companyHeldBy(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly companyId: string;
    readonly personId: string;
    readonly at: Date;
  },
): Promise<CompanyBusy | undefined> {
  const since = new Date(input.at.getTime() - EXPANSION_GAP_DAYS * 86_400_000).toISOString();

  const row = await queryOne<{
    person_id: string;
    display_name: string;
    current_title: string | null;
    last_at: string | null;
    enrolled: number;
  }>(
    db,
    `SELECT p.id AS person_id, p.display_name, p.current_title,
            (SELECT MAX(i.occurred_at) FROM interactions i
              WHERE i.workspace_id = ? AND i.person_id = p.id
                AND i.direction = 'outbound' AND i.network = 'email') AS last_at,
            (SELECT COUNT(*) FROM cadence_enrollments e
              WHERE e.workspace_id = ? AND e.person_id = p.id AND e.status = 'active') AS enrolled
       FROM people p
      WHERE p.current_company_id = ? AND p.id <> ? AND p.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM interactions r
              WHERE r.workspace_id = ? AND r.person_id = p.id AND r.direction = 'inbound'
                AND r.state IN ('replied', 'responded'))
        AND (
          EXISTS (SELECT 1 FROM interactions i
                   WHERE i.workspace_id = ? AND i.person_id = p.id AND i.direction = 'outbound'
                     AND i.network = 'email' AND i.occurred_at >= ?)
          OR EXISTS (SELECT 1 FROM cadence_enrollments e
                   WHERE e.workspace_id = ? AND e.person_id = p.id AND e.status = 'active')
        )
      ORDER BY last_at DESC
      LIMIT 1`,
    [
      input.workspaceId,
      input.workspaceId,
      input.companyId,
      input.personId,
      input.workspaceId,
      input.workspaceId,
      since,
      input.workspaceId,
    ],
  );
  if (!row) return undefined;

  const last = row.last_at ? Date.parse(row.last_at) : input.at.getTime();
  return {
    personId: row.person_id,
    name: row.display_name,
    persona: classifyPersona(row.current_title),
    until: new Date(last + EXPANSION_GAP_DAYS * 86_400_000).toISOString(),
  };
}

export function describeCompanyHold(held: CompanyBusy, company: string | null): string {
  const where = company ? ` at ${company}` : '';
  return (
    `one contact per company: ${held.name} (${PERSONA_LABELS[held.persona]})${where} ` +
    `is mid-sequence until ${held.until.slice(0, 10)}`
  );
}

export interface AccountContact {
  readonly personId: string;
  readonly name: string;
  readonly title: string | null;
  readonly persona: PersonaOrUnknown;
  /** contacted, replied, next (first in line), waiting (behind them), not_queued */
  readonly state: 'replied' | 'contacted' | 'next' | 'waiting' | 'not_queued';
  readonly lastContactedAt: string | null;
}

export interface Account {
  readonly companyId: string;
  readonly company: string;
  readonly contacts: readonly AccountContact[];
  /** Personas nobody at the company covers yet, in planner order. */
  readonly missing: readonly PersonaOrUnknown[];
}

/**
 * Every company in a campaign with who has been reached, who is next, and
 * which personas are still missing — the account expansion view.
 */
export async function campaignAccounts(
  db: Client,
  input: { readonly workspaceId: string; readonly campaignId: string; readonly limit?: number },
): Promise<Account[]> {
  const rows = await queryAll<{
    company_id: string;
    company: string;
    person_id: string;
    display_name: string;
    current_title: string | null;
    last_at: string | null;
    replied: number;
    pending: number;
  }>(
    db,
    `SELECT co.id AS company_id, co.name AS company, p.id AS person_id, p.display_name,
            p.current_title,
            (SELECT MAX(i.occurred_at) FROM interactions i
              WHERE i.workspace_id = cp.workspace_id AND i.person_id = p.id
                AND i.direction = 'outbound') AS last_at,
            (SELECT COUNT(*) FROM interactions r
              WHERE r.workspace_id = cp.workspace_id AND r.person_id = p.id
                AND r.direction = 'inbound' AND r.state IN ('replied', 'responded')) AS replied,
            (SELECT COUNT(*) FROM recommendations rc
              WHERE rc.workspace_id = cp.workspace_id AND rc.person_id = p.id
                AND rc.campaign_id = cp.campaign_id AND rc.status = 'pending') AS pending
       FROM campaign_people cp
       JOIN people p ON p.id = cp.person_id
       JOIN companies co ON co.id = p.current_company_id
      WHERE cp.workspace_id = ? AND cp.campaign_id = ? AND p.status = 'active'
      ORDER BY co.name, p.display_name`,
    [input.workspaceId, input.campaignId],
  );

  const byCompany = new Map<string, { company: string; rows: typeof rows }>();
  for (const row of rows) {
    const entry = byCompany.get(row.company_id) ?? { company: row.company, rows: [] };
    entry.rows.push(row);
    byCompany.set(row.company_id, entry);
  }

  const accounts: Account[] = [];
  for (const [companyId, entry] of byCompany) {
    const queued = entry.rows
      .filter((row) => !row.last_at && Number(row.pending) > 0)
      .sort(
        (a, b) =>
          personaRank(classifyPersona(a.current_title)) -
          personaRank(classifyPersona(b.current_title)),
      );
    const nextId = queued[0]?.person_id;

    const contacts = entry.rows
      .map((row): AccountContact => {
        const persona = classifyPersona(row.current_title);
        const state: AccountContact['state'] =
          Number(row.replied) > 0
            ? 'replied'
            : row.last_at
              ? 'contacted'
              : row.person_id === nextId
                ? 'next'
                : Number(row.pending) > 0
                  ? 'waiting'
                  : 'not_queued';
        return {
          personId: row.person_id,
          name: row.display_name,
          title: row.current_title,
          persona,
          state,
          lastContactedAt: row.last_at,
        };
      })
      .sort((a, b) => personaRank(a.persona) - personaRank(b.persona));

    const covered = new Set(contacts.map((contact) => contact.persona));
    const missing = (['budget_holder', 'pain_feeler', 'blocker', 'champion'] as const).filter(
      (persona) => !covered.has(persona),
    );
    accounts.push({ companyId, company: entry.company, contacts, missing });
  }

  return accounts.slice(0, input.limit ?? 500);
}
