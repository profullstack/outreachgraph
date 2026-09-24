-- 0041_webhooks.sql
--
-- Outbound webhooks (PRD §28): where a workspace wants to hear about what
-- happened, and a record of every attempt to tell it.
--
-- Both the URL and the signing secret are stored encrypted with
-- SECRET_ENCRYPTION_KEY, like every other credential. The secret has to be
-- recoverable (an HMAC needs the key itself, not a hash of it), and the URL is
-- frequently a credential in its own right: a Slack incoming-webhook URL or a
-- Zapier catch hook lets anyone who holds it post into that channel or zap.
-- `url_hint` is the part that is safe to show back on a settings page.
--
-- CRM credentials (HubSpot, Pipedrive) need no table of their own: they are
-- `integrations` + `integration_accounts` rows with kind = 'crm', exactly like
-- a mailbox or a Bluesky account.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- generic | slack
  kind          TEXT NOT NULL DEFAULT 'generic',
  url_enc       TEXT NOT NULL,
  url_hint      TEXT NOT NULL,
  secret_enc    TEXT NOT NULL,
  -- JSON array of event types. Empty means every event.
  events_json   TEXT NOT NULL DEFAULT '[]',
  description   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_ws ON webhook_endpoints(workspace_id, active);

-- One row per (endpoint, event), updated on each attempt. The payload is kept
-- so a retry sends byte-for-byte what the first attempt sent, which is what
-- lets a receiver dedupe on the event id.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            TEXT PRIMARY KEY,
  endpoint_id   TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  -- pending | retrying | delivered | failed | cancelled
  status        TEXT NOT NULL DEFAULT 'pending',
  attempt       INTEGER NOT NULL DEFAULT 0,
  status_code   INTEGER,
  error         TEXT,
  created_at    TEXT NOT NULL,
  delivered_at  TEXT,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
  ON webhook_deliveries(endpoint_id, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_ws
  ON webhook_deliveries(workspace_id, created_at);
