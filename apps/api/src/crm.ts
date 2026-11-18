/**
 * A small, agent-friendly CRM and a public booking page (PRD §39).
 *
 * Three surfaces:
 *
 *   - `/api/v1/crm`: deals (who, stage, next step, value), their timeline
 *     (notes, call notes, meetings) and reminders. Workspace-scoped like
 *     everything else; a viewer may read, not write.
 *   - `/api/v1/calendar`: the signed-in user's own booking page and the calls
 *     booked on it.
 *   - `/api/v1/public/calendar`: keyless, for the page at
 *     `/calendar/<handle>`. A guest reads the page, its free slots, and books
 *     one. The guest's manage link carries a token whose hash is all we keep.
 *
 * Every booking is a PairUX call. The room link is minted here
 * (`newPairuxRoomUrl`) and needs nothing from PairUX: the room is the link,
 * and its key sits in the fragment, so it never reaches a server.
 *
 * A booking lands in the CRM by itself: the guest's deal is found by email or
 * made at stage `meeting`, a meeting activity is written, and a "write call
 * notes" reminder is set for when the call ends. Nothing here sends outreach:
 * the only mail is the confirmation, the cancellation, the reminder an hour
 * before the call, and due reminders to the person they are assigned to.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { promoBlock } from '@profullstack/cross-promo';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  BOOKING_MAX_DAYS_AHEAD,
  BOOKING_REMINDER_LEAD_MINUTES,
  buildIcs,
  cleanCrmText,
  cleanEmail,
  computeSlots,
  CRM_LIMITS,
  CRM_STAGES,
  DEFAULT_AVAILABILITY,
  isBookingDuration,
  isClosedStage,
  isCrmStage,
  isLoggableActivityKind,
  isSlotAvailable,
  isValidTimezone,
  newId,
  newPairuxRoomUrl,
  normaliseHandle,
  normalizeAvailability,
  type CrmStage,
  type WeeklyAvailability,
} from '@outreachgraph/domain';
import { ConsoleMailer, type Mailer, type Message } from '@outreachgraph/email';
import { mailerForWorkspace } from '@outreachgraph/pipeline';
import type { SecretVault } from '@outreachgraph/secrets';
import { ApiError, type AppEnv, type RequestActor } from './context';
import { clientKey, FixedWindowLimiter } from './public-directory';
import * as repo from './repository';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ helpers

function safeJson(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw ApiError.badRequest('body must be a JSON object');
}

function requireWriter(actor: RequestActor): void {
  if (actor.role === 'viewer') throw ApiError.forbidden('viewers can read the CRM, not change it');
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function intOrNull(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(Math.round(n), min), max);
}

function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// -------------------------------------------------------------------- views

interface DealRow {
  id: string;
  workspace_id: string;
  title: string;
  contact_name: string | null;
  contact_email: string | null;
  company: string | null;
  person_id: string | null;
  stage: string;
  value_cents: number | bigint | null;
  next_step: string | null;
  owner_user_id: string | null;
  source: string;
  last_activity_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DealView {
  readonly id: string;
  readonly title: string;
  readonly contactName: string | null;
  readonly contactEmail: string | null;
  readonly company: string | null;
  readonly personId: string | null;
  readonly stage: CrmStage;
  readonly valueCents: number | null;
  readonly nextStep: string | null;
  readonly ownerUserId: string | null;
  readonly source: string;
  readonly lastActivityAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function dealView(row: DealRow): DealView {
  return {
    id: row.id,
    title: row.title,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    company: row.company,
    personId: row.person_id,
    stage: isCrmStage(row.stage) ? row.stage : 'lead',
    valueCents: row.value_cents === null ? null : num(row.value_cents),
    nextStep: row.next_step,
    ownerUserId: row.owner_user_id,
    source: row.source,
    lastActivityAt: row.last_activity_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const DEAL_COLUMNS_BY_ID = `SELECT id, workspace_id, title, contact_name, contact_email, company,
    person_id, stage, value_cents, next_step, owner_user_id, source, last_activity_at,
    closed_at, created_at, updated_at
  FROM crm_deals WHERE id = ? AND workspace_id = ?`;

interface ActivityRow {
  id: string;
  deal_id: string;
  kind: string;
  body: string;
  occurred_at: string;
  duration_minutes: number | bigint | null;
  author_user_id: string | null;
  booking_id: string | null;
  created_at: string;
}

function activityView(row: ActivityRow) {
  return {
    id: row.id,
    dealId: row.deal_id,
    kind: row.kind,
    body: row.body,
    occurredAt: row.occurred_at,
    durationMinutes: row.duration_minutes === null ? null : num(row.duration_minutes),
    authorUserId: row.author_user_id,
    bookingId: row.booking_id,
    createdAt: row.created_at,
  };
}

interface ReminderRow {
  id: string;
  deal_id: string | null;
  title: string;
  due_at: string;
  done_at: string | null;
  assignee_user_id: string | null;
  notified_at: string | null;
  booking_id: string | null;
  created_at: string;
  deal_title?: string | null;
}

function reminderView(row: ReminderRow) {
  return {
    id: row.id,
    dealId: row.deal_id,
    dealTitle: row.deal_title ?? null,
    title: row.title,
    dueAt: row.due_at,
    doneAt: row.done_at,
    assigneeUserId: row.assignee_user_id,
    notifiedAt: row.notified_at,
    bookingId: row.booking_id,
    createdAt: row.created_at,
  };
}

interface BookingRow {
  id: string;
  page_id: string;
  workspace_id: string;
  deal_id: string | null;
  starts_at: string;
  ends_at: string;
  guest_name: string;
  guest_email: string;
  guest_note: string | null;
  guest_timezone: string | null;
  meeting_url: string;
  status: string;
  reminded_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

function bookingView(row: BookingRow) {
  return {
    id: row.id,
    dealId: row.deal_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    guestName: row.guest_name,
    guestEmail: row.guest_email,
    guestNote: row.guest_note,
    guestTimezone: row.guest_timezone,
    meetingUrl: row.meeting_url,
    status: row.status,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
  };
}

interface PageRow {
  id: string;
  workspace_id: string;
  user_id: string;
  handle: string;
  title: string;
  description: string;
  host_name: string;
  duration_minutes: number | bigint;
  timezone: string;
  availability: string;
  buffer_minutes: number | bigint;
  min_notice_minutes: number | bigint;
  max_days_ahead: number | bigint;
  active: number | bigint;
  created_at: string;
  updated_at: string;
}

function parseAvailability(raw: string): WeeklyAvailability {
  try {
    return normalizeAvailability(JSON.parse(raw));
  } catch {
    return DEFAULT_AVAILABILITY;
  }
}

function pageView(row: PageRow) {
  return {
    id: row.id,
    handle: row.handle,
    title: row.title,
    description: row.description,
    hostName: row.host_name,
    durationMinutes: num(row.duration_minutes),
    timezone: row.timezone,
    availability: parseAvailability(row.availability),
    bufferMinutes: num(row.buffer_minutes),
    minNoticeMinutes: num(row.min_notice_minutes),
    maxDaysAhead: num(row.max_days_ahead),
    active: num(row.active) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PAGE_BY_HANDLE = `SELECT id, workspace_id, user_id, handle, title, description, host_name,
    duration_minutes, timezone, availability, buffer_minutes, min_notice_minutes,
    max_days_ahead, active, created_at, updated_at
  FROM booking_pages WHERE handle = ?`;

const PAGE_BY_USER = `SELECT id, workspace_id, user_id, handle, title, description, host_name,
    duration_minutes, timezone, availability, buffer_minutes, min_notice_minutes,
    max_days_ahead, active, created_at, updated_at
  FROM booking_pages WHERE user_id = ?`;

const PAGE_BY_ID = `SELECT id, workspace_id, user_id, handle, title, description, host_name,
    duration_minutes, timezone, availability, buffer_minutes, min_notice_minutes,
    max_days_ahead, active, created_at, updated_at
  FROM booking_pages WHERE id = ?`;

// -------------------------------------------------------------- deal writes

async function loadDeal(db: Client, workspaceId: string, id: string): Promise<DealRow> {
  const row = await queryOne<DealRow>(db, DEAL_COLUMNS_BY_ID, [id, workspaceId]);
  if (!row) throw ApiError.notFound('deal');
  return row;
}

async function writeActivity(
  db: Client,
  input: {
    workspaceId: string;
    dealId: string;
    kind: string;
    body: string;
    occurredAt?: string;
    durationMinutes?: number | null;
    authorUserId?: string | null;
    bookingId?: string | null;
  },
): Promise<string> {
  const id = newId('crmActivity');
  const stamp = now();
  const occurredAt = input.occurredAt ?? stamp;
  await db.execute({
    sql: `INSERT INTO crm_activities (id, workspace_id, deal_id, kind, body, occurred_at,
            duration_minutes, author_user_id, booking_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.workspaceId,
      input.dealId,
      input.kind,
      input.body,
      occurredAt,
      input.durationMinutes ?? null,
      input.authorUserId ?? null,
      input.bookingId ?? null,
      stamp,
    ],
  });
  await db.execute({
    sql: `UPDATE crm_deals SET last_activity_at = ?, updated_at = ?
          WHERE id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)`,
    args: [occurredAt, stamp, input.dealId, occurredAt],
  });
  return id;
}

interface DealInput {
  title?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  company?: string | null;
  personId?: string | null;
  stage?: CrmStage;
  valueCents?: number | null;
  nextStep?: string | null;
  ownerUserId?: string | null;
}

/** Reads a deal body. Absent keys stay absent so PATCH can keep what was there. */
function readDealInput(body: Record<string, unknown>): DealInput {
  const input: DealInput = {};
  if ('title' in body) input.title = cleanCrmText(body.title, CRM_LIMITS.title);
  if ('contactName' in body) input.contactName = cleanCrmText(body.contactName, CRM_LIMITS.name);
  if ('contactEmail' in body) {
    if (body.contactEmail === null || body.contactEmail === '') input.contactEmail = null;
    else {
      const email = cleanEmail(body.contactEmail);
      if (!email) throw ApiError.badRequest('contactEmail is not an email address');
      input.contactEmail = email;
    }
  }
  if ('company' in body) input.company = cleanCrmText(body.company, CRM_LIMITS.company);
  if ('personId' in body) input.personId = cleanCrmText(body.personId, 64);
  if ('stage' in body) {
    if (!isCrmStage(body.stage)) {
      throw ApiError.badRequest(`stage must be one of ${CRM_STAGES.join(', ')}`);
    }
    input.stage = body.stage;
  }
  if ('valueCents' in body) input.valueCents = intOrNull(body.valueCents, 0, 1e13);
  else if ('value' in body) {
    const value = intOrNull(Number(body.value) * 100, 0, 1e13);
    input.valueCents = value;
  }
  if ('nextStep' in body) input.nextStep = cleanCrmText(body.nextStep, CRM_LIMITS.nextStep);
  if ('ownerUserId' in body) input.ownerUserId = cleanCrmText(body.ownerUserId, 64);
  return input;
}

async function assertPerson(db: Client, personId: string | null | undefined): Promise<void> {
  if (!personId) return;
  const person = await queryOne<{ id: string }>(db, 'SELECT id FROM people WHERE id = ?', [
    personId,
  ]);
  if (!person) throw ApiError.badRequest('personId does not name a known person');
}

export async function createDeal(
  db: Client,
  workspaceId: string,
  input: DealInput & { source?: string },
  authorUserId: string | null,
): Promise<DealRow> {
  await assertPerson(db, input.personId);
  const title =
    input.title ||
    [input.contactName, input.company].filter(Boolean).join(' · ') ||
    input.contactEmail ||
    '';
  if (!title) {
    throw ApiError.badRequest('a deal needs a title, a contactName, a company or a contactEmail');
  }
  const id = newId('crmDeal');
  const stamp = now();
  const stage = input.stage ?? 'lead';
  await db.execute({
    sql: `INSERT INTO crm_deals (id, workspace_id, title, contact_name, contact_email, company,
            person_id, stage, value_cents, next_step, owner_user_id, source, last_activity_at,
            closed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      workspaceId,
      title,
      input.contactName ?? null,
      input.contactEmail ?? null,
      input.company ?? null,
      input.personId ?? null,
      stage,
      input.valueCents ?? null,
      input.nextStep ?? null,
      input.ownerUserId ?? authorUserId,
      input.source ?? 'manual',
      null,
      isClosedStage(stage) ? stamp : null,
      stamp,
      stamp,
    ],
  });
  return loadDeal(db, workspaceId, id);
}

async function updateDeal(
  db: Client,
  workspaceId: string,
  id: string,
  input: DealInput,
  authorUserId: string | null,
): Promise<DealRow> {
  const before = await loadDeal(db, workspaceId, id);
  await assertPerson(db, input.personId);
  const stamp = now();
  const stage = input.stage ?? (isCrmStage(before.stage) ? before.stage : 'lead');
  const closedAt = isClosedStage(stage) ? (before.closed_at ?? stamp) : null;
  await db.execute({
    sql: `UPDATE crm_deals SET title = ?, contact_name = ?, contact_email = ?, company = ?,
            person_id = ?, stage = ?, value_cents = ?, next_step = ?, owner_user_id = ?,
            closed_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
    args: [
      input.title ?? before.title,
      input.contactName === undefined ? before.contact_name : input.contactName,
      input.contactEmail === undefined ? before.contact_email : input.contactEmail,
      input.company === undefined ? before.company : input.company,
      input.personId === undefined ? before.person_id : input.personId,
      stage,
      input.valueCents === undefined
        ? before.value_cents === null
          ? null
          : num(before.value_cents)
        : input.valueCents,
      input.nextStep === undefined ? before.next_step : input.nextStep,
      input.ownerUserId === undefined ? before.owner_user_id : input.ownerUserId,
      closedAt,
      stamp,
      id,
      workspaceId,
    ],
  });
  if (stage !== before.stage) {
    await writeActivity(db, {
      workspaceId,
      dealId: id,
      kind: 'stage',
      body: `${before.stage} → ${stage}`,
      authorUserId,
    });
  }
  return loadDeal(db, workspaceId, id);
}

async function dealDetail(db: Client, workspaceId: string, id: string) {
  const deal = await loadDeal(db, workspaceId, id);
  const activities = await queryAll<ActivityRow>(
    db,
    `SELECT id, deal_id, kind, body, occurred_at, duration_minutes, author_user_id, booking_id,
       created_at
     FROM crm_activities WHERE deal_id = ? AND workspace_id = ?
     ORDER BY occurred_at DESC LIMIT 200`,
    [id, workspaceId],
  );
  const reminders = await queryAll<ReminderRow>(
    db,
    `SELECT id, deal_id, title, due_at, done_at, assignee_user_id, notified_at, booking_id,
       created_at
     FROM crm_reminders WHERE deal_id = ? AND workspace_id = ?
     ORDER BY done_at IS NOT NULL, due_at ASC LIMIT 100`,
    [id, workspaceId],
  );
  const bookings = await queryAll<BookingRow>(
    db,
    `SELECT id, page_id, workspace_id, deal_id, starts_at, ends_at, guest_name, guest_email,
       guest_note, guest_timezone, meeting_url, status, reminded_at, cancelled_at, created_at
     FROM bookings WHERE deal_id = ? AND workspace_id = ?
     ORDER BY starts_at DESC LIMIT 50`,
    [id, workspaceId],
  );
  return {
    deal: dealView(deal),
    activities: activities.map(activityView),
    reminders: reminders.map(reminderView),
    bookings: bookings.map(bookingView),
  };
}

async function createReminder(
  db: Client,
  input: {
    workspaceId: string;
    dealId: string | null;
    title: string;
    dueAt: string;
    assigneeUserId: string | null;
    bookingId?: string | null;
  },
): Promise<ReminderRow> {
  const id = newId('crmReminder');
  const stamp = now();
  await db.execute({
    sql: `INSERT INTO crm_reminders (id, workspace_id, deal_id, title, due_at, done_at,
            assignee_user_id, notified_at, booking_id, created_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
    args: [
      id,
      input.workspaceId,
      input.dealId,
      input.title,
      input.dueAt,
      input.assigneeUserId,
      input.bookingId ?? null,
      stamp,
    ],
  });
  const row = await queryOne<ReminderRow>(
    db,
    `SELECT id, deal_id, title, due_at, done_at, assignee_user_id, notified_at, booking_id,
       created_at FROM crm_reminders WHERE id = ?`,
    [id],
  );
  if (!row) throw new Error('reminder vanished after insert');
  return row;
}

// ------------------------------------------------------------- CRM routes

export function crmDealRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  /**
   * What needs doing: the pipeline by stage, reminders due within a day,
   * the next two weeks of booked calls, and open deals gone quiet. The one
   * call an agent should make first.
   */
  router.get('/summary', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const stamp = now();
    const horizon = new Date(Date.parse(stamp) + DAY_MS).toISOString();
    const twoWeeks = new Date(Date.parse(stamp) + 14 * DAY_MS).toISOString();
    const quiet = new Date(Date.parse(stamp) - 14 * DAY_MS).toISOString();

    const stageRows = await queryAll<{ stage: string; n: number | bigint; v: number | bigint }>(
      db,
      `SELECT stage, COUNT(*) AS n, COALESCE(SUM(value_cents), 0) AS v
       FROM crm_deals WHERE workspace_id = ? GROUP BY stage`,
      [actor.workspaceId],
    );
    const stages = CRM_STAGES.map((stage) => {
      const row = stageRows.find((r) => r.stage === stage);
      return { stage, deals: row ? num(row.n) : 0, valueCents: row ? num(row.v) : 0 };
    });

    const dueReminders = await queryAll<ReminderRow>(
      db,
      `SELECT r.id, r.deal_id, r.title, r.due_at, r.done_at, r.assignee_user_id, r.notified_at,
         r.booking_id, r.created_at, d.title AS deal_title
       FROM crm_reminders r LEFT JOIN crm_deals d ON d.id = r.deal_id
       WHERE r.workspace_id = ? AND r.done_at IS NULL AND r.due_at <= ?
       ORDER BY r.due_at ASC LIMIT 50`,
      [actor.workspaceId, horizon],
    );

    const upcoming = await queryAll<BookingRow>(
      db,
      `SELECT id, page_id, workspace_id, deal_id, starts_at, ends_at, guest_name,
         guest_email, guest_note, guest_timezone, meeting_url, status, reminded_at,
         cancelled_at, created_at
       FROM bookings
       WHERE workspace_id = ? AND status = 'confirmed' AND ends_at >= ? AND starts_at <= ?
       ORDER BY starts_at ASC LIMIT 50`,
      [actor.workspaceId, stamp, twoWeeks],
    );

    const stale = await queryAll<DealRow>(
      db,
      `SELECT id, workspace_id, title, contact_name, contact_email, company, person_id, stage,
         value_cents, next_step, owner_user_id, source, last_activity_at, closed_at,
         created_at, updated_at
       FROM crm_deals
       WHERE workspace_id = ? AND stage IN ('lead', 'contacted', 'replied', 'meeting', 'proposal')
         AND COALESCE(last_activity_at, created_at) < ?
       ORDER BY COALESCE(last_activity_at, created_at) ASC LIMIT 20`,
      [actor.workspaceId, quiet],
    );

    return c.json({
      stages,
      dueReminders: dueReminders.map(reminderView),
      upcomingBookings: upcoming.map(bookingView),
      staleDeals: stale.map(dealView),
    });
  });

  router.get('/deals', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const stage = c.req.query('stage');
    const email = cleanEmail(c.req.query('email'));
    const q = cleanCrmText(c.req.query('q'), 100);
    const limit = intOrNull(c.req.query('limit'), 1, 500) ?? 200;
    if (stage && !isCrmStage(stage)) {
      throw ApiError.badRequest(`stage must be one of ${CRM_STAGES.join(', ')}`);
    }
    const like = q ? `%${q.toLowerCase()}%` : null;
    const rows = await queryAll<DealRow>(
      db,
      `SELECT id, workspace_id, title, contact_name, contact_email, company, person_id, stage,
         value_cents, next_step, owner_user_id, source, last_activity_at, closed_at,
         created_at, updated_at
       FROM crm_deals
       WHERE workspace_id = ?
         AND stage = COALESCE(?, stage)
         AND COALESCE(contact_email, '') = COALESCE(?, COALESCE(contact_email, ''))
         AND (LOWER(title) LIKE COALESCE(?, '%')
              OR LOWER(COALESCE(contact_name, '')) LIKE COALESCE(?, '%')
              OR LOWER(COALESCE(company, '')) LIKE COALESCE(?, '%')
              OR LOWER(COALESCE(contact_email, '')) LIKE COALESCE(?, '%'))
       ORDER BY updated_at DESC LIMIT ?`,
      [actor.workspaceId, stage ?? null, email, like, like, like, like, limit],
    );
    return c.json({ deals: rows.map(dealView) });
  });

  router.post('/deals', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const db = c.get('db');
    const body = safeJson(await c.req.raw.text());
    const input = readDealInput(body);
    const deal = await createDeal(
      db,
      actor.workspaceId,
      { ...input, source: actor.credential === 'api_key' ? 'api' : 'manual' },
      actor.userId,
    );
    const note = cleanCrmText(body.note, CRM_LIMITS.body);
    if (note) {
      await writeActivity(db, {
        workspaceId: actor.workspaceId,
        dealId: deal.id,
        kind: 'note',
        body: note,
        authorUserId: actor.userId,
      });
    }
    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'crm.deal_created',
      entityKind: 'crm_deal',
      entityId: deal.id,
      detail: { stage: deal.stage },
    });
    return c.json(await dealDetail(db, actor.workspaceId, deal.id), 201);
  });

  router.get('/deals/:id', async (c) => {
    const actor = c.get('actor');
    return c.json(await dealDetail(c.get('db'), actor.workspaceId, c.req.param('id')));
  });

  router.patch('/deals/:id', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const db = c.get('db');
    const input = readDealInput(safeJson(await c.req.raw.text()));
    if (input.title === null) throw ApiError.badRequest('title cannot be empty');
    await updateDeal(db, actor.workspaceId, c.req.param('id'), input, actor.userId);
    return c.json(await dealDetail(db, actor.workspaceId, c.req.param('id')));
  });

  router.delete('/deals/:id', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const db = c.get('db');
    await loadDeal(db, actor.workspaceId, c.req.param('id'));
    await db.execute({
      sql: 'DELETE FROM crm_deals WHERE id = ? AND workspace_id = ?',
      args: [c.req.param('id'), actor.workspaceId],
    });
    return c.json({ deleted: true });
  });

  router.post('/deals/:id/activities', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const db = c.get('db');
    const deal = await loadDeal(db, actor.workspaceId, c.req.param('id'));
    const body = safeJson(await c.req.raw.text());
    const kind = body.kind ?? 'note';
    if (!isLoggableActivityKind(kind)) {
      throw ApiError.badRequest('kind must be note, call, meeting or email');
    }
    const text = cleanCrmText(body.body, CRM_LIMITS.body);
    if (!text) throw ApiError.badRequest('body is required');
    const id = await writeActivity(db, {
      workspaceId: actor.workspaceId,
      dealId: deal.id,
      kind,
      body: text,
      occurredAt: isoOrNull(body.occurredAt) ?? now(),
      durationMinutes: intOrNull(body.durationMinutes, 0, 24 * 60),
      authorUserId: actor.userId,
    });
    const row = await queryOne<ActivityRow>(
      db,
      `SELECT id, deal_id, kind, body, occurred_at, duration_minutes, author_user_id, booking_id,
         created_at FROM crm_activities WHERE id = ?`,
      [id],
    );
    return c.json({ activity: row ? activityView(row) : null }, 201);
  });

  router.get('/activities', async (c) => {
    const actor = c.get('actor');
    const limit = intOrNull(c.req.query('limit'), 1, 500) ?? 50;
    const rows = await queryAll<ActivityRow & { deal_title: string }>(
      c.get('db'),
      `SELECT a.id, a.deal_id, a.kind, a.body, a.occurred_at, a.duration_minutes,
         a.author_user_id, a.booking_id, a.created_at, d.title AS deal_title
       FROM crm_activities a JOIN crm_deals d ON d.id = a.deal_id
       WHERE a.workspace_id = ? ORDER BY a.occurred_at DESC LIMIT ?`,
      [actor.workspaceId, limit],
    );
    return c.json({
      activities: rows.map((row) => ({ ...activityView(row), dealTitle: row.deal_title })),
    });
  });

  router.get('/reminders', async (c) => {
    const actor = c.get('actor');
    const status = c.req.query('status') ?? 'open';
    if (!['open', 'done', 'all'].includes(status)) {
      throw ApiError.badRequest('status must be open, done or all');
    }
    const rows = await queryAll<ReminderRow>(
      c.get('db'),
      `SELECT r.id, r.deal_id, r.title, r.due_at, r.done_at, r.assignee_user_id, r.notified_at,
         r.booking_id, r.created_at, d.title AS deal_title
       FROM crm_reminders r LEFT JOIN crm_deals d ON d.id = r.deal_id
       WHERE r.workspace_id = ?
         AND (? = 'all' OR (? = 'open' AND r.done_at IS NULL) OR (? = 'done' AND r.done_at IS NOT NULL))
       ORDER BY r.due_at ASC LIMIT 500`,
      [actor.workspaceId, status, status, status],
    );
    return c.json({ reminders: rows.map(reminderView) });
  });

  router.post('/reminders', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const db = c.get('db');
    const body = safeJson(await c.req.raw.text());
    const title = cleanCrmText(body.title, CRM_LIMITS.reminder);
    const dueAt = isoOrNull(body.dueAt);
    if (!title) throw ApiError.badRequest('title is required');
    if (!dueAt) throw ApiError.badRequest('dueAt must be an ISO date-time');
    const dealId = cleanCrmText(body.dealId, 64);
    if (dealId) await loadDeal(db, actor.workspaceId, dealId);
    const row = await createReminder(db, {
      workspaceId: actor.workspaceId,
      dealId,
      title,
      dueAt,
      assigneeUserId: cleanCrmText(body.assigneeUserId, 64) ?? actor.userId,
    });
    return c.json({ reminder: reminderView(row) }, 201);
  });

  router.patch('/reminders/:id', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const db = c.get('db');
    const existing = await queryOne<ReminderRow>(
      db,
      `SELECT id, deal_id, title, due_at, done_at, assignee_user_id, notified_at, booking_id,
         created_at FROM crm_reminders WHERE id = ? AND workspace_id = ?`,
      [c.req.param('id'), actor.workspaceId],
    );
    if (!existing) throw ApiError.notFound('reminder');
    const body = safeJson(await c.req.raw.text());
    const title =
      'title' in body
        ? (cleanCrmText(body.title, CRM_LIMITS.reminder) ?? existing.title)
        : existing.title;
    const dueAt = 'dueAt' in body ? (isoOrNull(body.dueAt) ?? existing.due_at) : existing.due_at;
    const doneAt =
      typeof body.done === 'boolean'
        ? body.done
          ? (existing.done_at ?? now())
          : null
        : existing.done_at;
    // Moving the due date re-arms the email.
    const notifiedAt = dueAt !== existing.due_at ? null : existing.notified_at;
    await db.execute({
      sql: `UPDATE crm_reminders SET title = ?, due_at = ?, done_at = ?, notified_at = ?
            WHERE id = ? AND workspace_id = ?`,
      args: [title, dueAt, doneAt, notifiedAt, existing.id, actor.workspaceId],
    });
    if (doneAt && !existing.done_at && existing.deal_id) {
      await writeActivity(db, {
        workspaceId: actor.workspaceId,
        dealId: existing.deal_id,
        kind: 'note',
        body: `Done: ${title}`,
        authorUserId: actor.userId,
      });
    }
    return c.json({
      reminder: reminderView({
        ...existing,
        title,
        due_at: dueAt,
        done_at: doneAt,
        notified_at: notifiedAt,
      }),
    });
  });

  router.delete('/reminders/:id', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    await c.get('db').execute({
      sql: 'DELETE FROM crm_reminders WHERE id = ? AND workspace_id = ?',
      args: [c.req.param('id'), actor.workspaceId],
    });
    return c.json({ deleted: true });
  });

  return router;
}

// --------------------------------------------------------- booking emails

export interface CalendarOptions {
  /** The platform mailer: used only when the workspace has no mailbox of its own. */
  readonly mailer?: Mailer;
  readonly appUrl?: string;
  /** Unseals the workspace's connected SMTP mailbox, which booking mail is sent from. */
  readonly encryptionKey?: SecretVault | undefined;
}

/** Who a message is sent for: the workspace whose mailbox carries it. */
interface MailScope {
  readonly db: Client;
  readonly options: CalendarOptions;
  readonly workspaceId: string;
}

/**
 * The workspace's own connected mailbox (cha0spunk@/knox@ for ours), through
 * the email queue like every other send; the platform mailer only when the
 * workspace has none, and the console when there is neither.
 */
async function resolveMailer(scope: MailScope): Promise<Mailer> {
  try {
    const found = await mailerForWorkspace(scope.db, scope.workspaceId, {
      encryptionKey: scope.options.encryptionKey,
      fallback: scope.options.mailer,
    });
    if (found) return found.mailer;
  } catch (error) {
    console.warn(`crm mail: no usable mailbox for ${scope.workspaceId}: ${String(error)}`);
  }
  return scope.options.mailer ?? new ConsoleMailer();
}

function appBase(options: CalendarOptions): string {
  return (options.appUrl ?? 'http://localhost:8080').replace(/\/$/, '');
}

function whenText(iso: string, zone: string | null): string {
  const timeZone = zone && isValidTimezone(zone) ? zone : 'UTC';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

async function promoFor(seed: string): Promise<{ text: string; html: string }> {
  try {
    const block = await promoBlock({
      site: 'outreachgraph.com',
      audience: ['makers', 'developers', 'freelancers'],
      seed,
      fetchOptions: { timeoutMs: 2_500 },
    });
    return { text: block.text, html: block.html };
  } catch {
    return { text: '', html: '' };
  }
}

interface BookingMailContext {
  readonly booking: BookingRow;
  readonly page: PageRow;
  readonly hostEmail: string;
  readonly hostName: string;
  readonly manageUrl: string;
  readonly icsUrl: string;
}

function mailBody(lines: readonly (string | null)[], links: readonly [string, string][]) {
  const text = [
    ...lines.filter((l): l is string => l !== null),
    '',
    ...links.map(([l, u]) => `${l}: ${u}`),
  ].join('\n');
  const html = [
    ...lines
      .filter((l): l is string => l !== null)
      .map((l) => (l ? `<p>${escapeHtml(l)}</p>` : '')),
    ...links.map(([label, url]) => `<p><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></p>`),
  ].join('\n');
  return { text, html };
}

async function sendSafely(scope: MailScope, message: Message): Promise<boolean> {
  try {
    const mailer = await resolveMailer(scope);
    await mailer.send({ ...message, tenantId: scope.workspaceId });
    return true;
  } catch (error) {
    console.warn(`crm mail ${message.idempotencyKey ?? ''} failed: ${String(error)}`);
    return false;
  }
}

async function mailBookingConfirmed(db: Client, options: CalendarOptions, ctx: BookingMailContext) {
  const mailer: MailScope = { db, options, workspaceId: ctx.booking.workspace_id };
  const { booking, page } = ctx;
  const guestWhen = whenText(booking.starts_at, booking.guest_timezone ?? page.timezone);
  const hostWhen = whenText(booking.starts_at, page.timezone);
  const promo = await promoFor(booking.guest_email);

  const guest = mailBody(
    [
      `Hi ${booking.guest_name},`,
      '',
      `You're booked with ${ctx.hostName}: ${page.title}.`,
      `When: ${guestWhen} (${String(num(page.duration_minutes))} minutes).`,
      'Where: a private PairUX call. Open the link at the time; nothing to install, it runs in your browser.',
    ],
    [
      ['Join the call', booking.meeting_url],
      ['Add to your calendar', ctx.icsUrl],
      ['Reschedule or cancel', ctx.manageUrl],
    ],
  );
  await sendSafely(mailer, {
    to: booking.guest_email,
    subject: `Booked: ${page.title} with ${ctx.hostName}, ${guestWhen}`,
    text: guest.text + (promo.text ? `\n\n${promo.text}` : ''),
    html: guest.html + (promo.html ? `\n${promo.html}` : ''),
    replyTo: ctx.hostEmail,
    kind: 'transactional',
    idempotencyKey: `booking:${booking.id}:guest-confirmed`,
  });

  const host = mailBody(
    [
      `${booking.guest_name} <${booking.guest_email}> booked ${page.title}.`,
      `When: ${hostWhen}.`,
      booking.guest_note ? `Their note: ${booking.guest_note}` : null,
      'It is in your OutreachGraph CRM as a deal at the meeting stage.',
    ],
    [
      ['Join the call', booking.meeting_url],
      ['Add to your calendar', ctx.icsUrl],
      [
        'Open the CRM',
        `${appBase(options)}/crm${booking.deal_id ? `?deal=${booking.deal_id}` : ''}`,
      ],
    ],
  );
  await sendSafely(mailer, {
    to: ctx.hostEmail,
    subject: `New booking: ${booking.guest_name}, ${hostWhen}`,
    text: host.text,
    html: host.html,
    replyTo: booking.guest_email,
    kind: 'transactional',
    idempotencyKey: `booking:${booking.id}:host-confirmed`,
  });
}

async function mailBookingCancelled(
  db: Client,
  options: CalendarOptions,
  ctx: BookingMailContext,
  by: 'guest' | 'host',
) {
  const mailer: MailScope = { db, options, workspaceId: ctx.booking.workspace_id };
  const { booking, page } = ctx;
  const rebook = `${appBase(options)}/calendar/${page.handle}`;
  const guest = mailBody(
    [
      by === 'guest'
        ? `Your call with ${ctx.hostName} on ${whenText(booking.starts_at, booking.guest_timezone ?? page.timezone)} is cancelled.`
        : `${ctx.hostName} cancelled your call on ${whenText(booking.starts_at, booking.guest_timezone ?? page.timezone)}.`,
      'Pick another time whenever suits you.',
    ],
    [['Book another time', rebook]],
  );
  await sendSafely(mailer, {
    to: booking.guest_email,
    subject: `Cancelled: ${page.title} with ${ctx.hostName}`,
    text: guest.text,
    html: guest.html,
    replyTo: ctx.hostEmail,
    kind: 'transactional',
    idempotencyKey: `booking:${booking.id}:guest-cancelled`,
  });
  if (by === 'guest') {
    const host = mailBody(
      [
        `${booking.guest_name} <${booking.guest_email}> cancelled ${page.title} on ${whenText(booking.starts_at, page.timezone)}.`,
      ],
      [],
    );
    await sendSafely(mailer, {
      to: ctx.hostEmail,
      subject: `Cancelled by guest: ${booking.guest_name}`,
      text: host.text,
      html: host.html,
      replyTo: booking.guest_email,
      kind: 'transactional',
      idempotencyKey: `booking:${booking.id}:host-cancelled`,
    });
  }
}

async function hostOf(db: Client, page: PageRow): Promise<{ email: string; name: string }> {
  const user = await queryOne<{ email: string; name: string | null }>(
    db,
    'SELECT email, name FROM users WHERE id = ?',
    [page.user_id],
  );
  return {
    email: user?.email ?? '',
    name: page.host_name || user?.name?.trim() || user?.email?.split('@')[0] || 'your host',
  };
}

function manageLinks(options: CalendarOptions, page: PageRow, bookingId: string, token: string) {
  const base = appBase(options);
  return {
    manageUrl: `${base}/calendar/${page.handle}/booking/${bookingId}?token=${token}`,
    icsUrl: `${base}/api/v1/public/calendar/bookings/${bookingId}/ics?token=${token}`,
  };
}

// ---------------------------------------------------------- calendar (own)

async function busyFor(db: Client, pageId: string): Promise<{ start: string; end: string }[]> {
  const rows = await queryAll<{ starts_at: string; ends_at: string }>(
    db,
    `SELECT starts_at, ends_at FROM bookings
     WHERE page_id = ? AND status = 'confirmed' AND ends_at >= ?`,
    [pageId, new Date(Date.now() - DAY_MS).toISOString()],
  );
  return rows.map((row) => ({ start: row.starts_at, end: row.ends_at }));
}

async function cancelBooking(
  db: Client,
  options: CalendarOptions,
  booking: BookingRow,
  by: 'guest' | 'host',
  actorUserId: string | null,
) {
  if (booking.status !== 'confirmed') throw ApiError.conflict('this booking is already cancelled');
  const stamp = now();
  await db.execute({
    sql: `UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`,
    args: [stamp, booking.id],
  });
  // The "write call notes" reminder is moot for a call that will not happen.
  await db.execute({
    sql: 'DELETE FROM crm_reminders WHERE booking_id = ? AND done_at IS NULL',
    args: [booking.id],
  });
  if (booking.deal_id) {
    await writeActivity(db, {
      workspaceId: booking.workspace_id,
      dealId: booking.deal_id,
      kind: 'meeting',
      body: `Call on ${booking.starts_at} cancelled by the ${by}.`,
      authorUserId: actorUserId,
      bookingId: booking.id,
    });
  }
  const page = await queryOne<PageRow>(db, PAGE_BY_ID, [booking.page_id]);
  if (page) {
    const host = await hostOf(db, page);
    await mailBookingCancelled(
      db,
      options,
      {
        booking,
        page,
        hostEmail: host.email,
        hostName: host.name,
        manageUrl: '',
        icsUrl: '',
      },
      by,
    );
  }
}

export function calendarRoutes(options: CalendarOptions): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/page', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const row = await queryOne<PageRow>(db, PAGE_BY_USER, [actor.userId]);
    const base = appBase(options);
    return c.json({
      page: row ? pageView(row) : null,
      url: row ? `${base}/calendar/${row.handle}` : null,
      defaults: {
        durationMinutes: 30,
        timezone: 'America/Los_Angeles',
        availability: DEFAULT_AVAILABILITY,
        minNoticeMinutes: 240,
        maxDaysAhead: 30,
        bufferMinutes: 0,
      },
    });
  });

  router.put('/page', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const db = c.get('db');
    const body = safeJson(await c.req.raw.text());
    const existing = await queryOne<PageRow>(db, PAGE_BY_USER, [actor.userId]);

    const handle =
      body.handle === undefined ? (existing?.handle ?? null) : normaliseHandle(body.handle);
    if (!handle) {
      throw ApiError.badRequest(
        'handle must be 2-40 characters: lowercase letters, digits, - or _',
      );
    }
    const taken = await queryOne<{ user_id: string }>(
      db,
      'SELECT user_id FROM booking_pages WHERE handle = ?',
      [handle],
    );
    if (taken && taken.user_id !== actor.userId) throw ApiError.conflict('that handle is taken');

    const timezone =
      typeof body.timezone === 'string' ? body.timezone : (existing?.timezone ?? 'UTC');
    if (!isValidTimezone(timezone)) throw ApiError.badRequest('timezone is not an IANA zone');

    const duration =
      body.durationMinutes === undefined
        ? existing
          ? num(existing.duration_minutes)
          : 30
        : Number(body.durationMinutes);
    if (!isBookingDuration(duration)) {
      throw ApiError.badRequest('durationMinutes must be 15, 20, 30, 45, 60 or 90');
    }

    let availability: WeeklyAvailability;
    try {
      availability =
        body.availability === undefined
          ? existing
            ? parseAvailability(existing.availability)
            : DEFAULT_AVAILABILITY
          : normalizeAvailability(body.availability);
    } catch (error) {
      throw ApiError.badRequest(`availability: ${(error as Error).message}`);
    }

    const keep = (key: string, column: number | bigint | undefined, fallback: number) =>
      key in body ? body[key] : column === undefined ? fallback : num(column);
    const buffer = intOrNull(keep('bufferMinutes', existing?.buffer_minutes, 0), 0, 120) ?? 0;
    const notice =
      intOrNull(keep('minNoticeMinutes', existing?.min_notice_minutes, 240), 0, 14 * 24 * 60) ??
      240;
    const ahead =
      intOrNull(keep('maxDaysAhead', existing?.max_days_ahead, 30), 1, BOOKING_MAX_DAYS_AHEAD) ??
      30;
    const active =
      typeof body.active === 'boolean' ? body.active : existing ? num(existing.active) === 1 : true;
    const title =
      ('title' in body ? cleanCrmText(body.title, CRM_LIMITS.bookingTitle) : existing?.title) ??
      `${String(duration)}-minute call`;
    const description =
      ('description' in body
        ? cleanCrmText(body.description, CRM_LIMITS.bookingDescription)
        : existing?.description) ?? '';
    const hostName =
      ('hostName' in body ? cleanCrmText(body.hostName, CRM_LIMITS.name) : existing?.host_name) ??
      '';

    const stamp = now();
    if (existing) {
      await db.execute({
        sql: `UPDATE booking_pages SET handle = ?, title = ?, description = ?, host_name = ?,
                duration_minutes = ?, timezone = ?, availability = ?, buffer_minutes = ?,
                min_notice_minutes = ?, max_days_ahead = ?, active = ?, updated_at = ?
              WHERE id = ?`,
        args: [
          handle,
          title,
          description,
          hostName,
          duration,
          timezone,
          JSON.stringify(availability),
          buffer,
          notice,
          ahead,
          active ? 1 : 0,
          stamp,
          existing.id,
        ],
      });
    } else {
      await db.execute({
        sql: `INSERT INTO booking_pages (id, workspace_id, user_id, handle, title, description,
                host_name, duration_minutes, timezone, availability, buffer_minutes,
                min_notice_minutes, max_days_ahead, active, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId('bookingPage'),
          actor.workspaceId,
          actor.userId,
          handle,
          title,
          description,
          hostName,
          duration,
          timezone,
          JSON.stringify(availability),
          buffer,
          notice,
          ahead,
          active ? 1 : 0,
          stamp,
          stamp,
        ],
      });
    }
    const row = await queryOne<PageRow>(db, PAGE_BY_USER, [actor.userId]);
    if (!row) throw new Error('booking page vanished after save');
    return c.json({ page: pageView(row), url: `${appBase(options)}/calendar/${row.handle}` });
  });

  router.get('/bookings', async (c) => {
    const actor = c.get('actor');
    const scope = c.req.query('scope') ?? 'upcoming';
    const stamp = now();
    const rows = await queryAll<BookingRow>(
      c.get('db'),
      `SELECT id, page_id, workspace_id, deal_id, starts_at, ends_at, guest_name, guest_email,
         guest_note, guest_timezone, meeting_url, status, reminded_at, cancelled_at, created_at
       FROM bookings
       WHERE workspace_id = ?
         AND ((? = 'upcoming' AND ends_at >= ?) OR (? = 'past' AND ends_at < ?) OR ? = 'all')
       ORDER BY CASE WHEN ? = 'past' THEN '' ELSE starts_at END ASC, starts_at DESC LIMIT 200`,
      [actor.workspaceId, scope, stamp, scope, stamp, scope, scope],
    );
    return c.json({ bookings: rows.map(bookingView) });
  });

  router.post('/bookings/:id/cancel', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const db = c.get('db');
    const booking = await queryOne<BookingRow>(
      db,
      `SELECT id, page_id, workspace_id, deal_id, starts_at, ends_at, guest_name,
    guest_email, guest_note, guest_timezone, meeting_url, status, reminded_at, cancelled_at,
    created_at FROM bookings WHERE id = ? AND workspace_id = ?`,
      [c.req.param('id'), actor.workspaceId],
    );
    if (!booking) throw ApiError.notFound('booking');
    await cancelBooking(db, options, booking, 'host', actor.userId);
    return c.json({ cancelled: true });
  });

  return router;
}

// ---------------------------------------------------------- public routes

export interface PublicCalendarOptions extends CalendarOptions {
  readonly db: Client;
  readonly readLimiter?: FixedWindowLimiter;
  readonly bookLimiter?: FixedWindowLimiter;
  readonly clock?: () => Date;
}

function throttle(limiter: FixedWindowLimiter, request: Request): void {
  const verdict = limiter.take(clientKey(request));
  if (!verdict.allowed) {
    throw new ApiError(429, 'rate_limited', 'too many requests; slow down and retry');
  }
}

function publicPage(row: PageRow) {
  const view = pageView(row);
  return {
    handle: view.handle,
    title: view.title,
    description: view.description,
    hostName: view.hostName,
    durationMinutes: view.durationMinutes,
    timezone: view.timezone,
    maxDaysAhead: view.maxDaysAhead,
    meetingProvider: 'pairux',
  };
}

async function activePage(db: Client, handle: string): Promise<PageRow> {
  const clean = normaliseHandle(handle);
  const row = clean ? await queryOne<PageRow>(db, PAGE_BY_HANDLE, [clean]) : undefined;
  if (!row || num(row.active) !== 1) throw ApiError.notFound('booking page');
  return row;
}

async function bookingByToken(db: Client, id: string, token: string | undefined) {
  if (!token) throw ApiError.notFound('booking');
  const row = await queryOne<BookingRow & { manage_token_hash: string }>(
    db,
    `SELECT id, page_id, workspace_id, deal_id, starts_at, ends_at, guest_name,
    guest_email, guest_note, guest_timezone, meeting_url, status, reminded_at, cancelled_at,
    created_at, manage_token_hash FROM bookings WHERE id = ?`,
    [id],
  );
  if (!row || row.manage_token_hash !== hashToken(token)) throw ApiError.notFound('booking');
  return row;
}

export function publicCalendarRoutes(options: PublicCalendarOptions): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const db = options.db;
  const readLimiter = options.readLimiter ?? new FixedWindowLimiter(120, 60_000);
  const bookLimiter = options.bookLimiter ?? new FixedWindowLimiter(10, 3_600_000);
  const clock = options.clock ?? (() => new Date());

  router.get('/bookings/:id', async (c) => {
    throttle(readLimiter, c.req.raw);
    const booking = await bookingByToken(db, c.req.param('id'), c.req.query('token'));
    const page = await queryOne<PageRow>(db, PAGE_BY_ID, [booking.page_id]);
    if (!page) throw ApiError.notFound('booking');
    return c.json({
      page: publicPage(page),
      booking: {
        id: booking.id,
        startsAt: booking.starts_at,
        endsAt: booking.ends_at,
        guestName: booking.guest_name,
        meetingUrl: booking.meeting_url,
        status: booking.status,
      },
    });
  });

  router.get('/bookings/:id/ics', async (c) => {
    throttle(readLimiter, c.req.raw);
    const booking = await bookingByToken(db, c.req.param('id'), c.req.query('token'));
    const page = await queryOne<PageRow>(db, PAGE_BY_ID, [booking.page_id]);
    if (!page) throw ApiError.notFound('booking');
    const host = await hostOf(db, page);
    const ics = buildIcs({
      uid: booking.id,
      start: booking.starts_at,
      end: booking.ends_at,
      summary: `${page.title}: ${host.name} and ${booking.guest_name}`,
      description: `PairUX call: ${booking.meeting_url}`,
      url: booking.meeting_url,
      organizerEmail: host.email,
      organizerName: host.name,
      attendeeEmail: booking.guest_email,
      attendeeName: booking.guest_name,
      cancelled: booking.status !== 'confirmed',
      sequence: booking.status === 'confirmed' ? 0 : 1,
    });
    c.header('content-type', 'text/calendar; charset=utf-8');
    c.header('content-disposition', `attachment; filename="${booking.id}.ics"`);
    return c.body(ics);
  });

  router.post('/bookings/:id/cancel', async (c) => {
    throttle(bookLimiter, c.req.raw);
    const booking = await bookingByToken(db, c.req.param('id'), c.req.query('token'));
    await cancelBooking(db, options, booking, 'guest', null);
    return c.json({ cancelled: true });
  });

  router.get('/:handle', async (c) => {
    throttle(readLimiter, c.req.raw);
    const page = await activePage(db, c.req.param('handle'));
    c.header('cache-control', 'public, max-age=60');
    return c.json({ page: publicPage(page) });
  });

  router.get('/:handle/slots', async (c) => {
    throttle(readLimiter, c.req.raw);
    const page = await activePage(db, c.req.param('handle'));
    const view = pageView(page);
    const from = c.req.query('from');
    const days = intOrNull(c.req.query('days'), 1, 31) ?? 7;
    let slots;
    try {
      slots = computeSlots({
        availability: view.availability,
        timezone: view.timezone,
        durationMinutes: view.durationMinutes,
        bufferMinutes: view.bufferMinutes,
        minNoticeMinutes: view.minNoticeMinutes,
        maxDaysAhead: view.maxDaysAhead,
        ...(from ? { fromDate: from } : {}),
        days,
        busy: await busyFor(db, page.id),
        now: clock(),
      });
    } catch (error) {
      throw ApiError.badRequest((error as Error).message);
    }
    return c.json({ timezone: view.timezone, durationMinutes: view.durationMinutes, slots });
  });

  router.post('/:handle/book', async (c) => {
    throttle(bookLimiter, c.req.raw);
    const page = await activePage(db, c.req.param('handle'));
    const view = pageView(page);
    const body = safeJson(await c.req.raw.text());

    const name = cleanCrmText(body.name, CRM_LIMITS.name);
    const email = cleanEmail(body.email);
    const note = cleanCrmText(body.note, CRM_LIMITS.guestNote);
    const start = isoOrNull(body.start);
    const guestZone =
      typeof body.timezone === 'string' && isValidTimezone(body.timezone) ? body.timezone : null;
    if (!name) throw ApiError.badRequest('name is required');
    if (!email) throw ApiError.badRequest('a valid email is required');
    if (!start) throw ApiError.badRequest('start must be an ISO date-time from the slots list');

    const slotOptions = {
      availability: view.availability,
      timezone: view.timezone,
      durationMinutes: view.durationMinutes,
      bufferMinutes: view.bufferMinutes,
      minNoticeMinutes: view.minNoticeMinutes,
      maxDaysAhead: view.maxDaysAhead,
      busy: await busyFor(db, page.id),
      now: clock(),
    };
    if (!isSlotAvailable(start, slotOptions)) {
      throw ApiError.conflict('that time is no longer available; pick another');
    }

    const end = new Date(Date.parse(start) + view.durationMinutes * MINUTE_MS).toISOString();
    const id = newId('booking');
    const token = randomBytes(24).toString('base64url');
    const meetingUrl = newPairuxRoomUrl();
    const stamp = now();

    // The deal: the guest's existing one in this workspace, else a new one.
    const existingDeal = await queryOne<DealRow>(
      db,
      `SELECT id, workspace_id, title, contact_name, contact_email, company, person_id, stage,
         value_cents, next_step, owner_user_id, source, last_activity_at, closed_at,
         created_at, updated_at
       FROM crm_deals WHERE workspace_id = ? AND contact_email = ?
       ORDER BY (stage IN ('won', 'lost')), updated_at DESC LIMIT 1`,
      [page.workspace_id, email],
    );

    try {
      await db.execute({
        sql: `INSERT INTO bookings (id, page_id, workspace_id, deal_id, starts_at, ends_at,
                guest_name, guest_email, guest_note, guest_timezone, meeting_url, status,
                manage_token_hash, reminded_at, cancelled_at, created_at)
              VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, NULL, NULL, ?)`,
        args: [
          id,
          page.id,
          page.workspace_id,
          start,
          end,
          name,
          email,
          note,
          guestZone,
          meetingUrl,
          hashToken(token),
          stamp,
        ],
      });
    } catch {
      // The partial unique index: someone took this exact slot a moment ago.
      throw ApiError.conflict('that time was just taken; pick another');
    }

    let deal: DealRow;
    if (existingDeal) {
      const openStage = isCrmStage(existingDeal.stage) ? existingDeal.stage : 'lead';
      const advance =
        ['lead', 'contacted', 'replied'].includes(openStage) || isClosedStage(openStage);
      deal = advance
        ? await updateDeal(db, page.workspace_id, existingDeal.id, { stage: 'meeting' }, null)
        : existingDeal;
    } else {
      deal = await createDeal(
        db,
        page.workspace_id,
        {
          title: name,
          contactName: name,
          contactEmail: email,
          stage: 'meeting',
          nextStep: `Call on ${start}`,
          source: 'booking',
        },
        page.user_id,
      );
    }
    await db.execute({
      sql: 'UPDATE bookings SET deal_id = ? WHERE id = ?',
      args: [deal.id, id],
    });
    await writeActivity(db, {
      workspaceId: page.workspace_id,
      dealId: deal.id,
      kind: 'meeting',
      body:
        `Booked ${page.title} for ${start} via /calendar/${page.handle}. PairUX: ${meetingUrl}` +
        (note ? `\nGuest note: ${note}` : ''),
      occurredAt: stamp,
      durationMinutes: view.durationMinutes,
      bookingId: id,
    });
    await createReminder(db, {
      workspaceId: page.workspace_id,
      dealId: deal.id,
      title: `Write call notes for ${name}`,
      dueAt: end,
      assigneeUserId: page.user_id,
      bookingId: id,
    });

    const booking = await queryOne<BookingRow>(
      db,
      `SELECT id, page_id, workspace_id, deal_id, starts_at, ends_at, guest_name,
    guest_email, guest_note, guest_timezone, meeting_url, status, reminded_at, cancelled_at,
    created_at FROM bookings WHERE id = ?`,
      [id],
    );
    if (!booking) throw new Error('booking vanished after insert');
    const host = await hostOf(db, page);
    const links = manageLinks(options, page, id, token);
    if (host.email) {
      await mailBookingConfirmed(db, options, {
        booking,
        page,
        hostEmail: host.email,
        hostName: host.name,
        ...links,
      });
    }
    await repo.audit(db, {
      workspaceId: page.workspace_id,
      actorKind: 'system',
      eventType: 'calendar.booked',
      entityKind: 'booking',
      entityId: id,
      detail: { page: page.handle, dealId: deal.id },
    });

    return c.json(
      {
        booking: {
          id,
          startsAt: start,
          endsAt: end,
          meetingUrl,
          manageUrl: links.manageUrl,
          icsUrl: links.icsUrl,
        },
      },
      201,
    );
  });

  return router;
}

// ------------------------------------------------------------ worker sweep

/**
 * Mails what is due, once each: CRM reminders to their assignee when due, and
 * booked calls to both sides an hour before they start. Called from the
 * worker loop; safe to run every tick.
 */
export async function sendDueCrmMail(
  db: Client,
  options: CalendarOptions & { readonly now?: Date; readonly limit?: number },
): Promise<{ reminders: number; bookings: number }> {
  const at = options.now ?? new Date();
  const stamp = at.toISOString();
  const limit = options.limit ?? 100;
  let reminders = 0;
  let bookings = 0;

  const due = await queryAll<
    ReminderRow & { workspace_id: string; email: string | null; deal_title: string | null }
  >(
    db,
    `SELECT r.id, r.workspace_id, r.deal_id, r.title, r.due_at, r.done_at, r.assignee_user_id, r.notified_at,
       r.booking_id, r.created_at, d.title AS deal_title, u.email
     FROM crm_reminders r
       LEFT JOIN crm_deals d ON d.id = r.deal_id
       LEFT JOIN users u ON u.id = r.assignee_user_id
     WHERE r.done_at IS NULL AND r.notified_at IS NULL AND r.due_at <= ?
     ORDER BY r.due_at ASC LIMIT ?`,
    [stamp, limit],
  );
  for (const row of due) {
    // Claim first so a crash between claim and send loses one email rather
    // than sending it every tick.
    const claimed = await db.execute({
      sql: 'UPDATE crm_reminders SET notified_at = ? WHERE id = ? AND notified_at IS NULL',
      args: [stamp, row.id],
    });
    if (claimed.rowsAffected === 0 || !row.email) continue;
    const link = `${appBase(options)}/crm${row.deal_id ? `?deal=${row.deal_id}` : ''}`;
    const mail = mailBody(
      [`Reminder: ${row.title}`, row.deal_title ? `Deal: ${row.deal_title}` : null],
      [['Open in OutreachGraph', link]],
    );
    if (
      await sendSafely(
        { db, options, workspaceId: row.workspace_id },
        {
          to: row.email,
          subject: `Reminder: ${row.title}`,
          text: mail.text,
          html: mail.html,
          kind: 'transactional',
          idempotencyKey: `crm-reminder:${row.id}`,
        },
      )
    ) {
      reminders += 1;
    }
  }

  const soon = new Date(at.getTime() + BOOKING_REMINDER_LEAD_MINUTES * MINUTE_MS).toISOString();
  const calls = await queryAll<BookingRow>(
    db,
    `SELECT id, page_id, workspace_id, deal_id, starts_at, ends_at, guest_name,
    guest_email, guest_note, guest_timezone, meeting_url, status, reminded_at, cancelled_at,
    created_at FROM bookings
     WHERE status = 'confirmed' AND reminded_at IS NULL AND starts_at <= ? AND starts_at > ?
     ORDER BY starts_at ASC LIMIT ?`,
    [soon, stamp, limit],
  );
  for (const booking of calls) {
    const claimed = await db.execute({
      sql: 'UPDATE bookings SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL',
      args: [stamp, booking.id],
    });
    if (claimed.rowsAffected === 0) continue;
    const page = await queryOne<PageRow>(db, PAGE_BY_ID, [booking.page_id]);
    if (!page) continue;
    const host = await hostOf(db, page);
    const mailer: MailScope = { db, options, workspaceId: booking.workspace_id };
    const guestMail = mailBody(
      [
        `Your call with ${host.name} starts ${whenText(booking.starts_at, booking.guest_timezone ?? page.timezone)}.`,
        'Open the link at the time; it runs in your browser.',
      ],
      [['Join the call', booking.meeting_url]],
    );
    await sendSafely(mailer, {
      to: booking.guest_email,
      subject: `Starting soon: ${page.title} with ${host.name}`,
      text: guestMail.text,
      html: guestMail.html,
      ...(host.email ? { replyTo: host.email } : {}),
      kind: 'transactional',
      idempotencyKey: `booking:${booking.id}:guest-soon`,
    });
    if (host.email) {
      const hostMail = mailBody(
        [`${booking.guest_name} at ${whenText(booking.starts_at, page.timezone)}.`],
        [
          ['Join the call', booking.meeting_url],
          [
            'Their deal',
            `${appBase(options)}/crm${booking.deal_id ? `?deal=${booking.deal_id}` : ''}`,
          ],
        ],
      );
      await sendSafely(mailer, {
        to: host.email,
        subject: `Starting soon: call with ${booking.guest_name}`,
        text: hostMail.text,
        html: hostMail.html,
        replyTo: booking.guest_email,
        kind: 'transactional',
        idempotencyKey: `booking:${booking.id}:host-soon`,
      });
    }
    bookings += 1;
  }

  return { reminders, bookings };
}
