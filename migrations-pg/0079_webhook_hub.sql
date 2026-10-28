-- 0079_webhook_hub.sql
--
-- Outbound webhooks move onto @profullstack/webhooks (the fleet's webhook hub).
-- The hub keeps its outbox in these same two tables through an adapter
-- (packages/pipeline/src/webhook-store.ts), so every endpoint keeps its id,
-- its encrypted URL and its encrypted signing secret, and no customer has to
-- do anything.
--
-- What the hub needs that the tables lacked:
--   - endpoints count consecutive failures and say why they were switched off;
--   - deliveries carry their own due time (unix ms) instead of a job row.
--
-- Deliveries still in flight on the old job queue ('pending' or 'retrying')
-- become due at once on the hub; the old deliver_webhook jobs do nothing now.

ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS failures bigint NOT NULL DEFAULT 0;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS disabled_reason text;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS next_at bigint NOT NULL DEFAULT 0;

UPDATE webhook_deliveries SET status = 'pending' WHERE status = 'retrying';

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_at);
