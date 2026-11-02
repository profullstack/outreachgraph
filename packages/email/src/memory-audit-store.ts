/**
 * An in-memory `EmailAuditStore` for tests.
 *
 * Production uses `PostgresEmailAuditStore`; the suite runs on SQLite, so the
 * queue tests keep the audit in a map with the same semantics (insert-once by
 * id, provider-agnostic suppression keyed by the normalized address).
 */

import {
  normalizeRecipient,
  type EmailAuditEvent,
  type EmailAuditRecord,
  type EmailAuditStore,
  type SuppressionEntry,
  type SuppressionRecord,
} from '@profullstack/email-queue';

export class MemoryEmailAuditStore implements EmailAuditStore {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly suppressions = new Map<string, SuppressionRecord>();

  async migrate(): Promise<void> {}

  async create(record: EmailAuditRecord): Promise<void> {
    if (this.rows.has(record.id)) return;
    this.rows.set(record.id, {
      id: record.id,
      status: record.status,
      recipient: record.recipient,
      idempotency_key: record.idempotencyKey ?? null,
      tenant_id: record.tenantId ?? null,
      error: record.error ?? null,
      provider_message_id: record.providerMessageId ?? null,
    });
  }

  async transition(
    id: string,
    status: EmailAuditRecord['status'],
    details: { providerMessageId?: string; rfcMessageId?: string; error?: string } = {},
  ): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.status = status;
    row.error = details.error ?? null;
    if (details.providerMessageId) row.provider_message_id = details.providerMessageId;
  }

  async get(id: string): Promise<Record<string, unknown> | undefined> {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }

  async ingestProviderEvent(_event: EmailAuditEvent): Promise<boolean> {
    return true;
  }

  async suppress(entry: SuppressionEntry): Promise<void> {
    const key = normalizeRecipient(entry.recipient);
    if (!this.suppressions.has(key)) {
      this.suppressions.set(key, { recipient: key, reason: entry.reason, source: entry.source });
    }
  }

  async getSuppression(recipient: string): Promise<SuppressionRecord | undefined> {
    return this.suppressions.get(normalizeRecipient(recipient));
  }
}
