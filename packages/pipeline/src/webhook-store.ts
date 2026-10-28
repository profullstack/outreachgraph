/**
 * The webhook hub's store, on OutreachGraph's own two tables.
 *
 * `@profullstack/webhooks` ships stores for bun:sqlite and for a pg pool, and
 * this app has neither: it speaks the libsql client surface on both SQLite
 * (tests, local) and Postgres (`@profullstack/libsql-pg`, production). So the
 * hub's `WebhookStore` interface is implemented here, over the tables that
 * already held every endpoint and delivery (0041, extended by 0079), which is
 * what lets existing endpoints keep working with no copy and no customer step:
 *
 *   - `url_enc` stays encrypted. The hub sees a plaintext URL; this adapter
 *     decrypts it on read and encrypts it (and refreshes `url_hint`) on write.
 *   - `secret_enc` is passed through as it is. The hub seals and opens it
 *     itself, through the `secretBox` built on the same key (webhooks.ts).
 *   - `events_json` keeps the old convention: `[]` means every event. The hub
 *     says `["*"]`, so the two are translated at the edge.
 *   - Times: the tables keep ISO text, the hub counts unix milliseconds;
 *     `next_at` is the one column that is milliseconds already.
 *   - `kind` follows the URL: an incoming-webhook URL on hooks.slack.com is a
 *     Slack endpoint, anything else is generic.
 *
 * One addition on the way in: a delivery's payload is a CloudEvent, and the
 * envelope receivers were promised (docs/webhooks.md) also had `createdAt` and
 * `workspaceId`. Both are added to the payload before it is stored, so the
 * bytes signed and sent carry every field an existing receiver reads.
 */

import type { Delivery, Endpoint, WebhookStore } from '@profullstack/webhooks';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import { decryptSecret, encryptSecret } from '@outreachgraph/secrets';

export const SLACK_HOSTS: ReadonlySet<string> = new Set(['hooks.slack.com', 'hooks.slack-gov.com']);

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

export function endpointKind(url: string): 'generic' | 'slack' {
  try {
    return SLACK_HOSTS.has(new URL(url).hostname) ? 'slack' : 'generic';
  } catch {
    return 'generic';
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (value: unknown): number => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number' || typeof value === 'bigint') return Number(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
};
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

interface EndpointRow {
  id: string;
  workspace_id: string;
  url_enc: string;
  secret_enc: string;
  events_json: string | null;
  description: string | null;
  active: number;
  failures: number | null;
  disabled_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  workspace_id: string;
  event_id: string;
  event_type: string;
  payload_json: string;
  status: string;
  attempt: number;
  next_at: number | null;
  status_code: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const ENDPOINT_COLS = `id, workspace_id, url_enc, secret_enc, events_json, description, active,
  failures, disabled_reason, created_at, updated_at`;
const DELIVERY_COLS = `id, endpoint_id, workspace_id, event_id, event_type, payload_json, status,
  attempt, next_at, status_code, error, created_at, updated_at`;

function eventsFrom(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    const list = Array.isArray(parsed) ? parsed.map(String) : [];
    return list.length === 0 ? ['*'] : list;
  } catch {
    return ['*'];
  }
}

function eventsTo(events: readonly string[]): string {
  return JSON.stringify(events.includes('*') ? [] : events);
}

function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    owner: row.workspace_id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload_json,
    status: row.status as Delivery['status'],
    attempts: Number(row.attempt ?? 0),
    nextAt: Number(row.next_at ?? 0),
    lastStatus: numOrNull(row.status_code),
    lastError: row.error ?? null,
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
  };
}

/** The legacy envelope fields, added next to the CloudEvent ones. */
export function withLegacyEnvelope(payload: string, workspaceId: string): string {
  try {
    const event = JSON.parse(payload) as Record<string, unknown>;
    if (!event || typeof event !== 'object' || !('specversion' in event)) return payload;
    return JSON.stringify({
      ...event,
      createdAt: typeof event.time === 'string' ? event.time : new Date().toISOString(),
      workspaceId,
    });
  } catch {
    return payload;
  }
}

/**
 * `key` decrypts and encrypts URLs. Without it (an emit from a process that
 * holds no key) endpoints read with an empty URL, which is all emitting needs:
 * it only matches events, and the sender always runs with the key.
 */
export function outreachGraphWebhookStore(db: Client, key: Buffer | undefined): WebhookStore {
  const toEndpoint = (row: EndpointRow | undefined): Endpoint | null => {
    if (!row) return null;
    let url = '';
    if (key) {
      try {
        url = decryptSecret(row.url_enc, key);
      } catch {
        url = '';
      }
    }
    return {
      id: row.id,
      owner: row.workspace_id,
      url,
      secret: row.secret_enc,
      events: eventsFrom(row.events_json),
      description: row.description ?? '',
      enabled: Number(row.active) === 1,
      failures: Number(row.failures ?? 0),
      disabledReason: row.disabled_reason ?? null,
      createdAt: ms(row.created_at),
      updatedAt: ms(row.updated_at),
    };
  };

  const needKey = (): Buffer => {
    if (!key)
      throw new Error('SECRET_ENCRYPTION_KEY is not set, so a webhook URL cannot be stored');
    return key;
  };

  return {
    async insertEndpoint(e) {
      const url = new URL(e.url);
      await db.execute({
        sql: `INSERT INTO webhook_endpoints (id, workspace_id, kind, url_enc, url_hint, secret_enc,
              events_json, description, active, failures, disabled_reason, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          e.id,
          e.owner,
          endpointKind(e.url),
          encryptSecret(url.toString(), needKey()),
          urlHint(url),
          e.secret,
          eventsTo(e.events),
          e.description.trim() || null,
          e.enabled ? 1 : 0,
          e.failures,
          e.disabledReason,
          iso(e.createdAt),
          iso(e.updatedAt),
        ],
      });
    },

    async getEndpoint(id) {
      return toEndpoint(
        await queryOne<EndpointRow>(
          db,
          `SELECT ${ENDPOINT_COLS} FROM webhook_endpoints WHERE id = ?`,
          [id],
        ),
      );
    },

    async listEndpoints(owner) {
      const rows = await queryAll<EndpointRow>(
        db,
        `SELECT ${ENDPOINT_COLS} FROM webhook_endpoints WHERE workspace_id = ? ORDER BY created_at`,
        [owner],
      );
      return rows.map((row) => toEndpoint(row)).filter((e): e is Endpoint => e !== null);
    },

    async updateEndpoint(id, patch) {
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      const set = (column: string, value: string | number | null): void => {
        sets.push(`${column} = ?`);
        args.push(value);
      };
      if (patch.url !== undefined) {
        const url = new URL(patch.url);
        set('url_enc', encryptSecret(url.toString(), needKey()));
        set('url_hint', urlHint(url));
        set('kind', endpointKind(patch.url));
      }
      if (patch.secret !== undefined) set('secret_enc', patch.secret);
      if (patch.events !== undefined) set('events_json', eventsTo(patch.events));
      if (patch.description !== undefined) set('description', patch.description.trim() || null);
      if (patch.enabled !== undefined) set('active', patch.enabled ? 1 : 0);
      if (patch.failures !== undefined) set('failures', patch.failures);
      if (patch.disabledReason !== undefined) set('disabled_reason', patch.disabledReason);
      if (patch.updatedAt !== undefined) set('updated_at', iso(patch.updatedAt));
      if (sets.length === 0) return;
      await db.execute({
        sql: `UPDATE webhook_endpoints SET ${sets.join(', ')} WHERE id = ?`,
        args: [...args, id],
      });
    },

    async deleteEndpoint(id) {
      await db.execute({ sql: 'DELETE FROM webhook_deliveries WHERE endpoint_id = ?', args: [id] });
      await db.execute({ sql: 'DELETE FROM webhook_endpoints WHERE id = ?', args: [id] });
    },

    async insertDeliveries(rows) {
      for (const d of rows) {
        await db.execute({
          sql: `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type,
                payload_json, status, attempt, next_at, status_code, error, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            d.id,
            d.endpointId,
            d.owner,
            d.eventId,
            d.eventType,
            withLegacyEnvelope(d.payload, d.owner),
            d.status,
            d.attempts,
            d.nextAt,
            d.lastStatus,
            d.lastError,
            iso(d.createdAt),
            iso(d.updatedAt),
          ],
        });
      }
    },

    async getDelivery(id) {
      const row = await queryOne<DeliveryRow>(
        db,
        `SELECT ${DELIVERY_COLS} FROM webhook_deliveries WHERE id = ?`,
        [id],
      );
      return row ? toDelivery(row) : null;
    },

    async listDeliveries({ owner, endpointId, limit = 50 }) {
      const rows = await queryAll<DeliveryRow>(
        db,
        `SELECT ${DELIVERY_COLS} FROM webhook_deliveries
          WHERE workspace_id = ? ${endpointId ? 'AND endpoint_id = ?' : ''}
          ORDER BY created_at DESC LIMIT ?`,
        endpointId ? [owner, endpointId, limit] : [owner, limit],
      );
      return rows.map(toDelivery);
    },

    async updateDelivery(id, patch) {
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      const set = (column: string, value: string | number | null): void => {
        sets.push(`${column} = ?`);
        args.push(value);
      };
      if (patch.status !== undefined) {
        set('status', patch.status);
        if (patch.status === 'delivered') set('delivered_at', iso(patch.updatedAt ?? Date.now()));
      }
      if (patch.attempts !== undefined) set('attempt', patch.attempts);
      if (patch.nextAt !== undefined) set('next_at', patch.nextAt);
      if (patch.lastStatus !== undefined) set('status_code', patch.lastStatus);
      if (patch.lastError !== undefined) set('error', patch.lastError);
      if (patch.updatedAt !== undefined) set('updated_at', iso(patch.updatedAt));
      if (sets.length === 0) return;
      await db.execute({
        sql: `UPDATE webhook_deliveries SET ${sets.join(', ')} WHERE id = ?`,
        args: [...args, id],
      });
    },

    /**
     * Takes due rows by pushing their due time out by the lease. One container
     * runs the drainer (see apps/server), so a compare-and-set on `next_at`
     * is enough to keep a second drain from taking a row the first one holds.
     */
    async claimDue(now, limit, leaseMs) {
      const due = await queryAll<DeliveryRow>(
        db,
        `SELECT ${DELIVERY_COLS} FROM webhook_deliveries
          WHERE status = 'pending' AND next_at <= ?
          ORDER BY next_at LIMIT ?`,
        [now, limit],
      );
      const claimed: Delivery[] = [];
      for (const row of due) {
        const result = await db.execute({
          sql: 'UPDATE webhook_deliveries SET next_at = ? WHERE id = ? AND next_at = ?',
          args: [now + leaseMs, row.id, Number(row.next_at ?? 0)],
        });
        if (Number(result.rowsAffected ?? 0) > 0) claimed.push(toDelivery(row));
      }
      return claimed;
    },

    async prune(before) {
      await db.execute({
        sql: `DELETE FROM webhook_deliveries WHERE status <> 'pending' AND updated_at < ?`,
        args: [iso(before)],
      });
    },
  };
}
