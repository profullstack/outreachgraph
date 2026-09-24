/**
 * Telling the rest of a customer's stack what happened (PRD §28).
 *
 * Everything a team does after OutreachGraph finds someone happens somewhere
 * else — a CRM, a Slack channel, a Zapier zap that opens a deal. Until this
 * existed the only way to learn that a prospect replied was to open the
 * product and look, which is exactly the habit an unattended product is meant
 * to break.
 *
 * One function, `emitWebhookEvent`, is the whole outbound bus. Every place in
 * the pipeline where something worth announcing happens calls it with a type
 * and a few ids, and it decides who hears: each matching webhook endpoint gets
 * a delivery row and a queued job, and each connected CRM gets a sync job when
 * the type is one a CRM cares about. Three design points carry the weight:
 *
 *   - **Nothing is sent inline.** Emitting writes rows and returns. The HTTP
 *     call happens later, on the worker, as a `deliver_webhook` job — so a
 *     receiver that takes ten seconds to answer cannot make approving a card
 *     take ten seconds, and a receiver that is down gets retried with the
 *     queue's backoff instead of being lost.
 *   - **Emitting never throws.** It is called from inside the happy paths of
 *     sending, replying and approving. A customer's broken Zapier hook must
 *     not be able to fail a send that already went out, so every failure here
 *     is logged and swallowed, the same contract `emitEvent` keeps for the
 *     progress feed.
 *   - **The payload is frozen at emit time.** The delivery row stores the
 *     exact envelope, so the fifth retry sends the same bytes as the first,
 *     with the same event id, and a receiver can drop the duplicate.
 */

import {
  endpointWants,
  newId,
  CRM_PROVIDERS,
  CRM_TRIGGER_EVENTS,
  type DeliverableEventType,
  type EventPerson,
  type OutboundEvent,
  type WebhookEndpointKind,
  type WebhookEventType,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  assertPublicUrl,
  formatSlackMessage,
  newWebhookSecret,
  postWebhook,
  signWebhook,
  SIGNATURE_HEADER,
  UnsafeUrlError,
  type FetchLike,
  type HostLookup,
} from '@outreachgraph/providers';
import { decryptSecret, encryptSecret } from '@outreachgraph/secrets';
import { enqueue, type QueuedJob } from './queue';

/**
 * Attempts per delivery. With the queue's doubling backoff from 30 seconds
 * this spans a little over an hour, which covers a receiver's deploy or a
 * short outage without retrying a dead endpoint all day.
 */
export const WEBHOOK_MAX_ATTEMPTS = 8;

/** Attempts per CRM sync. A CRM that is down for longer is recorded as an error. */
export const CRM_SYNC_MAX_ATTEMPTS = 5;

/** Endpoints a workspace may register. A ceiling, not a product tier. */
export const MAX_WEBHOOK_ENDPOINTS = 20;

export class WebhookError extends Error {
  readonly code: 'not_configured' | 'invalid_url' | 'too_many' | 'not_found';
  constructor(code: WebhookError['code'], message: string) {
    super(message);
    this.name = 'WebhookError';
    this.code = code;
  }
}

/** What a settings page may see about an endpoint. Never the URL or the secret. */
export interface WebhookEndpointSummary {
  readonly id: string;
  readonly kind: WebhookEndpointKind;
  readonly urlHint: string;
  readonly events: readonly WebhookEventType[];
  readonly description: string | null;
  readonly active: boolean;
  readonly createdAt: string;
  /** The most recent attempt, so a broken endpoint is visible on the list. */
  readonly lastDelivery?: { status: string; statusCode: number | null; at: string };
}

export interface WebhookDeliverySummary {
  readonly id: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly status: string;
  readonly attempt: number;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

/** Options that exist for tests: where the network and DNS come from. */
export interface UrlCheckOptions {
  readonly lookup?: HostLookup;
  readonly allowHttp?: boolean;
  readonly allowPrivate?: boolean;
}

// ----------------------------------------------------------------- endpoints

/**
 * The part of a URL that is safe to show back.
 *
 * Not the path: a Slack hook's path is its credential, and a Zapier catch
 * hook's is too. The origin plus the last four characters is enough to tell
 * two endpoints apart and to recognise the one you pasted.
 */
export function urlHint(url: URL): string {
  const path = url.pathname.replace(/\/$/, '');
  return path.length > 1 ? `${url.origin}/…${path.slice(-4)}` : url.origin;
}

const SLACK_HOSTS = new Set(['hooks.slack.com', 'hooks.slack-gov.com']);

export async function createWebhookEndpoint(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly url: string;
    readonly kind: WebhookEndpointKind;
    readonly events: readonly WebhookEventType[];
    readonly description?: string | undefined;
    readonly createdBy?: string | undefined;
    readonly encryptionKey: Buffer | undefined;
  } & UrlCheckOptions,
): Promise<{ endpoint: WebhookEndpointSummary; secret: string }> {
  if (!input.encryptionKey) {
    throw new WebhookError(
      'not_configured',
      'SECRET_ENCRYPTION_KEY is not set, so a webhook URL and secret cannot be stored safely.',
    );
  }

  // Checked here for an immediate, legible refusal, and again on every
  // delivery because DNS answers change after the form is submitted.
  let url: URL;
  try {
    url = await assertPublicUrl(input.url, input);
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new WebhookError('invalid_url', error.message);
    throw error;
  }

  if (input.kind === 'slack' && !SLACK_HOSTS.has(url.hostname)) {
    throw new WebhookError(
      'invalid_url',
      'a Slack endpoint must be an incoming-webhook URL on hooks.slack.com',
    );
  }

  const count = await queryOne<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM webhook_endpoints WHERE workspace_id = ?',
    [input.workspaceId],
  );
  if (Number(count?.n ?? 0) >= MAX_WEBHOOK_ENDPOINTS) {
    throw new WebhookError('too_many', `a workspace may have ${MAX_WEBHOOK_ENDPOINTS} endpoints`);
  }

  const id = newId('webhookEndpoint');
  const secret = newWebhookSecret();
  const stamp = now();
  const hint = urlHint(url);

  await db.execute({
    sql: `INSERT INTO webhook_endpoints (id, workspace_id, kind, url_enc, url_hint, secret_enc,
          events_json, description, active, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    args: [
      id,
      input.workspaceId,
      input.kind,
      encryptSecret(url.toString(), input.encryptionKey),
      hint,
      encryptSecret(secret, input.encryptionKey),
      JSON.stringify(input.events),
      input.description?.trim().slice(0, 200) || null,
      input.createdBy ?? null,
      stamp,
      stamp,
    ],
  });

  return {
    endpoint: {
      id,
      kind: input.kind,
      urlHint: hint,
      events: [...input.events],
      description: input.description?.trim().slice(0, 200) || null,
      active: true,
      createdAt: stamp,
    },
    secret,
  };
}

function parseEvents(raw: string | null | undefined): WebhookEventType[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? (parsed.map(String) as WebhookEventType[]) : [];
  } catch {
    return [];
  }
}

export async function listWebhookEndpoints(
  db: Client,
  workspaceId: string,
): Promise<WebhookEndpointSummary[]> {
  const rows = await queryAll<{
    id: string;
    kind: string;
    url_hint: string;
    events_json: string;
    description: string | null;
    active: number;
    created_at: string;
    last_status: string | null;
    last_code: number | null;
    last_at: string | null;
  }>(
    db,
    `SELECT e.id, e.kind, e.url_hint, e.events_json, e.description, e.active, e.created_at,
            d.status AS last_status, d.status_code AS last_code, d.updated_at AS last_at
       FROM webhook_endpoints e
       LEFT JOIN webhook_deliveries d ON d.id = (
         SELECT id FROM webhook_deliveries WHERE endpoint_id = e.id
          ORDER BY updated_at DESC LIMIT 1)
      WHERE e.workspace_id = ?
      ORDER BY e.created_at`,
    [workspaceId],
  );

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as WebhookEndpointKind,
    urlHint: row.url_hint,
    events: parseEvents(row.events_json),
    description: row.description,
    active: row.active === 1,
    createdAt: row.created_at,
    ...(row.last_status && row.last_at
      ? {
          lastDelivery: {
            status: row.last_status,
            statusCode: row.last_code === null ? null : Number(row.last_code),
            at: row.last_at,
          },
        }
      : {}),
  }));
}

/**
 * Removes an endpoint and its log.
 *
 * Deleting rather than deactivating: the URL is a credential, and a row that
 * keeps its ciphertext after the customer said "remove it" is a credential we
 * were told to stop holding. Deliveries still queued find no endpoint and
 * cancel themselves.
 */
export async function deleteWebhookEndpoint(
  db: Client,
  workspaceId: string,
  endpointId: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: 'DELETE FROM webhook_endpoints WHERE id = ? AND workspace_id = ?',
    args: [endpointId, workspaceId],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}

export async function listWebhookDeliveries(
  db: Client,
  workspaceId: string,
  query: { readonly endpointId?: string | undefined; readonly limit?: number } = {},
): Promise<WebhookDeliverySummary[]> {
  const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
  const rows = await queryAll<{
    id: string;
    endpoint_id: string;
    event_id: string;
    event_type: string;
    status: string;
    attempt: number;
    status_code: number | null;
    error: string | null;
    created_at: string;
    delivered_at: string | null;
  }>(
    db,
    `SELECT id, endpoint_id, event_id, event_type, status, attempt, status_code, error,
            created_at, delivered_at
       FROM webhook_deliveries
      WHERE workspace_id = ? ${query.endpointId ? 'AND endpoint_id = ?' : ''}
      ORDER BY created_at DESC LIMIT ?`,
    query.endpointId ? [workspaceId, query.endpointId, limit] : [workspaceId, limit],
  );

  return rows.map((row) => ({
    id: row.id,
    endpointId: row.endpoint_id,
    eventId: row.event_id,
    eventType: row.event_type,
    status: row.status,
    attempt: Number(row.attempt),
    statusCode: row.status_code === null ? null : Number(row.status_code),
    error: row.error,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  }));
}

// ---------------------------------------------------------------------- emit

/**
 * Who a person is, in the shape an event carries.
 *
 * The email is a personal address we hold, never the company's shared inbox:
 * a CRM keyed on `hello@acme.com` would merge every prospect at Acme into one
 * contact.
 */
export async function eventPerson(
  db: Client,
  personId: string,
): Promise<(EventPerson & { firstName?: string; lastName?: string }) | undefined> {
  const row = await queryOne<{
    id: string;
    display_name: string;
    first_name: string | null;
    last_name: string | null;
    current_title: string | null;
    company_name: string | null;
    company_domain: string | null;
    email: string | null;
  }>(
    db,
    `SELECT p.id, p.display_name, p.first_name, p.last_name, p.current_title,
            co.name AS company_name, co.domain AS company_domain,
            (SELECT si.handle FROM social_identities si
              WHERE si.person_id = p.id AND si.network = 'email'
              ORDER BY si.confidence DESC LIMIT 1) AS email
       FROM people p
       LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE p.id = ?`,
    [personId],
  );
  if (!row) return undefined;

  return {
    id: row.id,
    name: row.display_name,
    ...(row.first_name ? { firstName: row.first_name } : {}),
    ...(row.last_name ? { lastName: row.last_name } : {}),
    ...(row.current_title ? { title: row.current_title } : {}),
    ...(row.company_name ? { company: row.company_name } : {}),
    ...(row.company_domain ? { companyDomain: row.company_domain } : {}),
    ...(row.email ? { email: row.email.trim().toLowerCase() } : {}),
  };
}

export interface EmitResult {
  readonly eventId?: string;
  readonly deliveries: number;
  readonly crmSyncs: number;
}

/**
 * Announces one thing that happened. Never throws; never sends.
 *
 * `data` carries ids and the handful of facts a receiver needs. When it has a
 * `personId`, the person is looked up once and attached as `data.person`, so
 * a Slack line can say a name and a Zap can match on an email without calling
 * back into our API.
 */
export async function emitWebhookEvent(
  db: Client,
  workspaceId: string,
  type: WebhookEventType,
  data: Record<string, unknown> = {},
): Promise<EmitResult> {
  try {
    const endpoints = await queryAll<{ id: string; events_json: string }>(
      db,
      `SELECT id, events_json FROM webhook_endpoints WHERE workspace_id = ? AND active = 1`,
      [workspaceId],
    );
    const targets = endpoints.filter((e) => endpointWants(parseEvents(e.events_json), type));

    const crms = CRM_TRIGGER_EVENTS.includes(type)
      ? await queryAll<{ network: string }>(
          db,
          `SELECT DISTINCT ia.network FROM integration_accounts ia
             JOIN integrations i ON i.id = ia.integration_id
            WHERE ia.workspace_id = ? AND i.kind = 'crm' AND ia.status = 'active'`,
          [workspaceId],
        )
      : [];

    // The common case, by far: nobody is listening. One indexed read and out.
    if (targets.length === 0 && crms.length === 0) return { deliveries: 0, crmSyncs: 0 };

    const event = await buildEvent(db, workspaceId, type, data);

    for (const target of targets) {
      await queueDelivery(db, workspaceId, target.id, event);
    }

    for (const crm of crms) {
      if (!(CRM_PROVIDERS as readonly string[]).includes(crm.network)) continue;
      await enqueue(db, {
        workspaceId,
        kind: 'sync_crm',
        payload: { provider: crm.network, event },
        maxAttempts: CRM_SYNC_MAX_ATTEMPTS,
        dedupeKey: `crm:${crm.network}:${event.id}`,
      });
    }

    return { eventId: event.id, deliveries: targets.length, crmSyncs: crms.length };
  } catch (error) {
    // Deliberately swallowed. See the note at the top of this file.
    console.warn(`webhook emit ${type} failed in ${workspaceId}:`, error);
    return { deliveries: 0, crmSyncs: 0 };
  }
}

async function buildEvent(
  db: Client,
  workspaceId: string,
  type: DeliverableEventType,
  data: Record<string, unknown>,
): Promise<OutboundEvent> {
  const personId = typeof data.personId === 'string' ? data.personId : undefined;
  const person = personId ? await eventPerson(db, personId) : undefined;

  // First and last name are for the CRM adapters; a receiver has `name`.
  const published: EventPerson | undefined = person
    ? {
        id: person.id,
        name: person.name,
        ...(person.title ? { title: person.title } : {}),
        ...(person.company ? { company: person.company } : {}),
        ...(person.companyDomain ? { companyDomain: person.companyDomain } : {}),
        ...(person.email ? { email: person.email } : {}),
      }
    : undefined;

  return {
    id: newId('webhookEvent'),
    type,
    createdAt: now(),
    workspaceId,
    data: { ...data, ...(published ? { person: published } : {}) },
  };
}

async function queueDelivery(
  db: Client,
  workspaceId: string,
  endpointId: string,
  event: OutboundEvent,
): Promise<string> {
  const id = newId('webhookDelivery');
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type,
          payload_json, status, attempt, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    args: [id, endpointId, workspaceId, event.id, event.type, JSON.stringify(event), stamp, stamp],
  });

  await enqueue(db, {
    workspaceId,
    kind: 'deliver_webhook',
    payload: { deliveryId: id },
    maxAttempts: WEBHOOK_MAX_ATTEMPTS,
    dedupeKey: `webhook:${id}`,
  });

  return id;
}

/**
 * Fires a `ping` at one endpoint, through the same queue as everything else.
 *
 * Through the queue rather than inline for the same reason as real events:
 * "test" must exercise the path real deliveries take, or it tests nothing.
 */
export async function sendTestEvent(
  db: Client,
  workspaceId: string,
  endpointId: string,
): Promise<{ deliveryId: string; eventId: string } | undefined> {
  const endpoint = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM webhook_endpoints WHERE id = ? AND workspace_id = ?',
    [endpointId, workspaceId],
  );
  if (!endpoint) return undefined;

  const event = await buildEvent(db, workspaceId, 'ping', {
    message: 'This is a test event from OutreachGraph.',
  });
  const deliveryId = await queueDelivery(db, workspaceId, endpointId, event);
  return { deliveryId, eventId: event.id };
}

// ------------------------------------------------------------------- deliver

export interface WebhookDeliveryDeps extends UrlCheckOptions {
  readonly db: Client;
  readonly encryptionKey?: Buffer | undefined;
  readonly fetchImpl?: FetchLike;
  /** Seconds since the epoch, for the signature. Injected by tests. */
  readonly clock?: () => number;
}

export interface WebhookDeliveryResult {
  readonly status: 'delivered' | 'retrying' | 'failed' | 'cancelled';
  readonly statusCode?: number;
  readonly error?: string;
}

/** Thrown to make the queue retry. The delivery row already says why. */
export class WebhookRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookRetryError';
  }
}

/** The request body an endpoint of `kind` expects for `event`. */
export function webhookBody(kind: WebhookEndpointKind, event: OutboundEvent): string {
  return JSON.stringify(kind === 'slack' ? formatSlackMessage(event) : event);
}

/**
 * Runs one `deliver_webhook` job.
 *
 * Throws `WebhookRetryError` when another attempt could succeed, which is how
 * a job asks the queue for backoff. Returns normally for every outcome that a
 * retry cannot change: delivered, the endpoint is gone, or its URL is now one
 * we refuse to call.
 */
export async function runWebhookDelivery(
  deps: WebhookDeliveryDeps,
  job: Pick<QueuedJob, 'payload' | 'attempts' | 'maxAttempts' | 'workspaceId'>,
): Promise<WebhookDeliveryResult> {
  const { db } = deps;
  const deliveryId = typeof job.payload.deliveryId === 'string' ? job.payload.deliveryId : '';

  const row = await queryOne<{
    id: string;
    status: string;
    payload_json: string;
    event_type: string;
    endpoint_id: string;
    kind: string | null;
    url_enc: string | null;
    secret_enc: string | null;
    active: number | null;
  }>(
    db,
    `SELECT d.id, d.status, d.payload_json, d.event_type, d.endpoint_id,
            e.kind, e.url_enc, e.secret_enc, e.active
       FROM webhook_deliveries d
       LEFT JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.id = ? AND d.workspace_id = ?`,
    [deliveryId, job.workspaceId],
  );

  // The endpoint was deleted, and its deliveries with it.
  if (!row) return { status: 'cancelled', error: 'the delivery no longer exists' };
  if (row.status === 'delivered') return { status: 'delivered' };

  const stamp = now();
  const record = async (
    status: WebhookDeliveryResult['status'],
    statusCode: number | undefined,
    error: string | undefined,
  ): Promise<void> => {
    await db.execute({
      sql: `UPDATE webhook_deliveries
               SET status = ?, attempt = ?, status_code = ?, error = ?, updated_at = ?,
                   delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
             WHERE id = ?`,
      args: [
        status,
        job.attempts,
        statusCode ?? null,
        error?.slice(0, 1000) ?? null,
        stamp,
        status,
        stamp,
        row.id,
      ],
    });
  };

  if (!row.url_enc || !row.secret_enc || row.active !== 1) {
    await record('cancelled', undefined, 'the endpoint was removed or disabled');
    return { status: 'cancelled', error: 'the endpoint was removed or disabled' };
  }

  const finalAttempt = job.attempts >= job.maxAttempts;

  if (!deps.encryptionKey) {
    const error = 'SECRET_ENCRYPTION_KEY is not set on the worker';
    await record(finalAttempt ? 'failed' : 'retrying', undefined, error);
    throw new WebhookRetryError(error);
  }

  const url = decryptSecret(row.url_enc, deps.encryptionKey);
  const secret = decryptSecret(row.secret_enc, deps.encryptionKey);
  const event = JSON.parse(row.payload_json) as OutboundEvent;
  const body = webhookBody((row.kind ?? 'generic') as WebhookEndpointKind, event);
  const timestamp = deps.clock?.() ?? Math.floor(Date.now() / 1000);

  const outcome = await postWebhook({
    url,
    body,
    headers: {
      [SIGNATURE_HEADER]: signWebhook(secret, body, timestamp),
      'X-OutreachGraph-Event': event.type,
      'X-OutreachGraph-Delivery': row.id,
    },
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.lookup ? { lookup: deps.lookup } : {}),
    ...(deps.allowHttp ? { allowHttp: true } : {}),
    ...(deps.allowPrivate ? { allowPrivate: true } : {}),
  });

  if (outcome.ok) {
    await record('delivered', outcome.status, undefined);
    return { status: 'delivered', statusCode: outcome.status };
  }

  // 410 Gone is a receiver saying "stop", and Slack answers it for a deleted
  // hook. Honouring it beats retrying a URL that will never come back.
  if (outcome.status === 410) {
    await db.execute({
      sql: 'UPDATE webhook_endpoints SET active = 0, updated_at = ? WHERE id = ?',
      args: [stamp, row.endpoint_id],
    });
    await record('failed', 410, 'the endpoint answered 410 Gone and has been disabled');
    return { status: 'failed', statusCode: 410, error: 'gone' };
  }

  if (!outcome.retryable) {
    await record('failed', outcome.status, outcome.error);
    return {
      status: 'failed',
      error: outcome.error,
      ...(outcome.status ? { statusCode: outcome.status } : {}),
    };
  }

  await record(finalAttempt ? 'failed' : 'retrying', outcome.status, outcome.error);
  throw new WebhookRetryError(outcome.error);
}

/** Old delivery rows are a log, not a record; a month is plenty to debug with. */
export async function pruneWebhookDeliveries(db: Client, keepDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
  const result = await db.execute({
    sql: `DELETE FROM webhook_deliveries
           WHERE created_at < ? AND status IN ('delivered', 'failed', 'cancelled')`,
    args: [cutoff],
  });
  return Number(result.rowsAffected ?? 0);
}
