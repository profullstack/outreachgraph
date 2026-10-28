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
 * a delivery row on the fleet's webhook hub (`@profullstack/webhooks`), and
 * each connected CRM gets a sync job when the type is one a CRM cares about.
 *
 *   - **Nothing is sent inline.** Emitting writes delivery rows and returns.
 *     The hub's drainer (started once in apps/server) sends them, retries a
 *     failure with backoff (30 s, 2 min, 10 min, 1 h, 6 h, 24 h, 48 h) and
 *     switches an endpoint off after 20 failures in a row. The outbox lives
 *     in `webhook_deliveries`, so a restart loses nothing.
 *   - **Emitting never throws.** It is called from inside the happy paths of
 *     sending, replying and approving. A customer's broken Zapier hook must
 *     not be able to fail a send that already went out.
 *   - **The payload is frozen at emit time.** The delivery row stores the
 *     exact body, so the fifth retry sends the same bytes as the first, with
 *     the same event id, and a receiver can drop the duplicate.
 *
 * Every delivery carries the Standard Webhooks headers (`webhook-id`,
 * `webhook-timestamp`, `webhook-signature`) and, so that no existing receiver
 * has to change, the original `X-OutreachGraph-Signature: t=<unix>,v1=<hex>`
 * over `${t}.${body}` keyed with the secret's UTF-8 bytes, plus
 * `X-OutreachGraph-Event` and `X-OutreachGraph-Delivery`.
 */

import {
  newId,
  CRM_PROVIDERS,
  CRM_TRIGGER_EVENTS,
  WEBHOOK_EVENT_TYPES,
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
  signWebhook,
  SIGNATURE_HEADER,
  UnsafeUrlError,
  WEBHOOK_USER_AGENT,
  type FetchLike,
  type HostLookup,
} from '@outreachgraph/providers';
import { decryptSecret, encryptSecret } from '@outreachgraph/secrets';
import {
  Webhooks,
  WebhookError as HubError,
  TEST_EVENT,
  type GuardOptions,
} from '@profullstack/webhooks';
import { enqueue } from './queue';
import { outreachGraphWebhookStore, SLACK_HOSTS } from './webhook-store';

export { urlHint } from './webhook-store';

/** Attempts per CRM sync. A CRM that is down for longer is recorded as an error. */
export const CRM_SYNC_MAX_ATTEMPTS = 5;

/** Endpoints a workspace may register. A ceiling, not a product tier. */
export const MAX_WEBHOOK_ENDPOINTS = 20;

/** The CloudEvents `source` of every event. */
export const WEBHOOK_SOURCE = 'https://outreachgraph.com';

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
  /** Consecutive failed deliveries; the hub switches the endpoint off at 20. */
  readonly failures?: number;
  /** Why the endpoint was switched off, when it was. */
  readonly disabledReason?: string;
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

// ----------------------------------------------------------------------- hub

export interface WebhookHubOptions extends UrlCheckOptions {
  readonly encryptionKey?: Buffer | undefined;
  readonly fetchImpl?: FetchLike;
  /** Seconds since the epoch, for the legacy signature. Injected by tests. */
  readonly clock?: () => number;
  readonly log?: (message: string) => void;
}

/**
 * The legacy headers, exactly as the old sender wrote them.
 *
 * Not the package's `tV1Header`: that keys the HMAC with a `whsec_` secret's
 * base64-decoded bytes (the Standard Webhooks rule), and OutreachGraph always
 * keyed it with the secret string's UTF-8 bytes. Receivers verify against the
 * latter, so `signWebhook` (the original function) signs it.
 */
export function legacyHeaders(clock: () => number = () => Math.floor(Date.now() / 1000)) {
  return ({ body, secret, eventType }: { body: string; secret: string; eventType: string }) => {
    let eventId = '';
    try {
      const parsed = JSON.parse(body) as { id?: unknown };
      if (typeof parsed.id === 'string') eventId = parsed.id;
    } catch {
      // A body that is not JSON still gets signed.
    }
    return {
      // The old sender said application/json, and express.json() and friends
      // parse nothing else; the CloudEvents media type is in the body's shape.
      'content-type': 'application/json',
      'user-agent': WEBHOOK_USER_AGENT,
      [SIGNATURE_HEADER]: signWebhook(secret, body, clock()),
      'X-OutreachGraph-Event': eventType,
      ...(eventId ? { 'X-OutreachGraph-Delivery': eventId } : {}),
    };
  };
}

/**
 * The transport under the hub: OutreachGraph's own SSRF rule on every
 * attempt, redirects refused rather than followed (a 302 to a metadata
 * address would otherwise walk past the address check), and a Slack
 * incoming-webhook URL given a one-line message instead of the envelope,
 * because Slack takes a message and cannot check a signature anyway.
 */
export function webhookTransport(
  options: UrlCheckOptions & { fetchImpl?: FetchLike },
): typeof fetch {
  const base = options.fetchImpl ?? fetch;
  const transport = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    try {
      await assertPublicUrl(url, options);
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw new Error(`refused: ${error.message}`);
      throw error;
    }
    let body = init?.body;
    let headers = init?.headers;
    if (SLACK_HOSTS.has(new URL(url).hostname) && typeof body === 'string') {
      body = JSON.stringify(formatSlackMessage(slackEvent(body)));
      headers = { 'content-type': 'application/json', 'user-agent': WEBHOOK_USER_AGENT };
    }
    return base(url, {
      ...init,
      ...(body !== undefined ? { body } : {}),
      ...(headers !== undefined ? { headers } : {}),
      redirect: 'manual',
    });
  };
  return transport as typeof fetch;
}

/** An outbound envelope from a stored body, old shape or CloudEvent. */
function slackEvent(body: string): OutboundEvent {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const type = parsed.type === TEST_EVENT ? 'ping' : parsed.type;
  return {
    id: String(parsed.id ?? ''),
    type: type as OutboundEvent['type'],
    createdAt: String(parsed.createdAt ?? parsed.time ?? ''),
    workspaceId: String(parsed.workspaceId ?? ''),
    data: (parsed.data ?? {}) as OutboundEvent['data'],
  };
}

/** A hub over `db`. Cheap to build: the constructor only stores its options. */
export function createWebhookHub(db: Client, options: WebhookHubOptions = {}): Webhooks {
  const key = options.encryptionKey;
  const store = outreachGraphWebhookStore(db, key);
  const guard: GuardOptions = {
    ...(options.lookup
      ? { lookup: async (host: string) => [...(await options.lookup!(host))] }
      : {}),
    ...(options.allowHttp ? { allowHttp: true } : {}),
    ...(options.allowPrivate ? { allowPrivate: true } : {}),
  };
  return new Webhooks({
    store,
    source: WEBHOOK_SOURCE,
    eventTypes: [...WEBHOOK_EVENT_TYPES],
    maxEndpoints: MAX_WEBHOOK_ENDPOINTS,
    guard,
    fetchImpl: webhookTransport({ ...options }),
    extraHeaders: legacyHeaders(options.clock),
    ...(key
      ? {
          secretBox: {
            seal: (secret: string) => encryptSecret(secret, key),
            open: (sealed: string) => decryptSecret(sealed, key),
          },
        }
      : {
          secretBox: {
            seal: () => {
              throw new Error('SECRET_ENCRYPTION_KEY is not set');
            },
            open: () => {
              throw new Error('SECRET_ENCRYPTION_KEY is not set');
            },
          },
        }),
    // 410 Gone is a receiver saying "stop", and Slack answers it for a
    // deleted hook. Honouring it beats retrying a URL that will never return.
    onDelivery: async ({ delivery, endpoint }) => {
      if (delivery.last_status !== 410) return;
      const at = Date.now();
      await store.updateEndpoint(endpoint.id, {
        enabled: false,
        disabledReason: 'the endpoint answered 410 Gone',
        updatedAt: at,
      });
      await store.updateDelivery(delivery.id, { status: 'failed', updatedAt: at });
    },
    ...(options.log ? { log: options.log } : {}),
  });
}

/**
 * The started hub, per database. apps/server registers the one it starts so
 * an emit wakes its drainer at once; anything else (tests, the CLI) gets an
 * unstarted hub whose rows the drainer picks up on its next tick.
 */
const hubs = new WeakMap<Client, Webhooks>();

export function registerWebhookHub(db: Client, hub: Webhooks): Webhooks {
  hubs.set(db, hub);
  return hub;
}

function hubFor(db: Client): Webhooks {
  let hub = hubs.get(db);
  if (!hub) {
    hub = createWebhookHub(db);
    hubs.set(db, hub);
  }
  return hub;
}

function translate(error: unknown): never {
  if (error instanceof HubError) {
    if (error.status === 404) throw new WebhookError('not_found', error.message);
    if (error.status === 409) throw new WebhookError('too_many', error.message);
    throw new WebhookError('invalid_url', error.message.replace(/^url: /, ''));
  }
  throw error;
}

// ----------------------------------------------------------------- endpoints

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

  const hub = createWebhookHub(db, input);
  let created: Awaited<ReturnType<Webhooks['createEndpoint']>>;
  try {
    created = await hub.createEndpoint(input.workspaceId, {
      url: url.toString(),
      events: input.events.length ? [...input.events] : ['*'],
      description: input.description?.trim().slice(0, 200) ?? '',
    });
  } catch (error) {
    translate(error);
  }

  if (input.createdBy) {
    await db.execute({
      sql: 'UPDATE webhook_endpoints SET created_by = ? WHERE id = ?',
      args: [input.createdBy, created.endpoint.id],
    });
  }

  const [summary] = (await listWebhookEndpoints(db, input.workspaceId)).filter(
    (e) => e.id === created.endpoint.id,
  );
  if (!summary) throw new WebhookError('not_found', 'the new endpoint was not stored');
  return { endpoint: summary, secret: created.secret };
}

/** A new signing secret, returned once; the old one stops working at once. */
export async function rotateWebhookSecret(
  db: Client,
  workspaceId: string,
  endpointId: string,
  options: WebhookHubOptions,
): Promise<{ secret: string }> {
  if (!options.encryptionKey) {
    throw new WebhookError('not_configured', 'SECRET_ENCRYPTION_KEY is not set');
  }
  try {
    return await createWebhookHub(db, options).rotateSecret(workspaceId, endpointId);
  } catch (error) {
    translate(error);
  }
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
    failures: number | null;
    disabled_reason: string | null;
    created_at: string;
    last_status: string | null;
    last_code: number | null;
    last_at: string | null;
  }>(
    db,
    `SELECT e.id, e.kind, e.url_hint, e.events_json, e.description, e.active, e.created_at,
            e.failures, e.disabled_reason,
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
    active: Number(row.active) === 1,
    createdAt: row.created_at,
    failures: Number(row.failures ?? 0),
    ...(row.disabled_reason ? { disabledReason: row.disabled_reason } : {}),
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
 * were told to stop holding. Its delivery log goes with it.
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
  await db.execute({
    sql: 'DELETE FROM webhook_deliveries WHERE endpoint_id = ? AND workspace_id = ?',
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
    const hub = hubFor(db);
    const listening = await queryOne<{ n: number }>(
      db,
      'SELECT count(*) AS n FROM webhook_endpoints WHERE workspace_id = ? AND active = 1',
      [workspaceId],
    );

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
    if (Number(listening?.n ?? 0) === 0 && crms.length === 0) {
      return { deliveries: 0, crmSyncs: 0 };
    }

    const event = await buildEvent(db, workspaceId, type, data);
    const personId = typeof data.personId === 'string' ? data.personId : undefined;
    const emitted = await hub.emit(workspaceId, type, event.data, {
      id: event.id,
      ...(personId ? { subject: `person:${personId}` } : {}),
    });

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

    return { eventId: event.id, deliveries: emitted.queued, crmSyncs: crms.length };
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

/**
 * Sends a `webhook.test` event to one endpoint now and says how it went.
 *
 * Sent inline, through the same transport and signing as real deliveries, so
 * a passing test proves the real path works. It is logged but never retried.
 */
export async function sendTestEvent(
  db: Client,
  workspaceId: string,
  endpointId: string,
  options: WebhookHubOptions = {},
): Promise<
  | {
      deliveryId: string;
      eventId: string;
      ok: boolean;
      statusCode: number | null;
      error: string | null;
    }
  | undefined
> {
  const endpoint = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM webhook_endpoints WHERE id = ? AND workspace_id = ?',
    [endpointId, workspaceId],
  );
  if (!endpoint) return undefined;
  if (!options.encryptionKey) {
    throw new WebhookError('not_configured', 'SECRET_ENCRYPTION_KEY is not set');
  }

  const hub = createWebhookHub(db, options);
  const result = await hub.test(workspaceId, endpointId);
  const row = await queryOne<{ event_id: string }>(
    db,
    'SELECT event_id FROM webhook_deliveries WHERE id = ?',
    [result.delivery_id],
  );
  return {
    deliveryId: result.delivery_id,
    eventId: row?.event_id ?? '',
    ok: result.ok,
    statusCode: result.status,
    error: result.error,
  };
}
