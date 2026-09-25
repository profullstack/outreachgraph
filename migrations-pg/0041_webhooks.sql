-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table if not exists webhook_endpoints (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'generic',
  url_enc text NOT NULL,
  url_hint text NOT NULL,
  secret_enc text NOT NULL,
  events_json text NOT NULL DEFAULT '[]',
  description text,
  active bigint NOT NULL DEFAULT 1,
  created_by text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_ws ON webhook_endpoints(workspace_id, active);

create table if not exists webhook_deliveries (
  id text PRIMARY KEY,
  endpoint_id text NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload_json text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt bigint NOT NULL DEFAULT 0,
  status_code bigint,
  error text,
  created_at text NOT NULL,
  delivered_at text,
  updated_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
  ON webhook_deliveries(endpoint_id, created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_ws
  ON webhook_deliveries(workspace_id, created_at);
