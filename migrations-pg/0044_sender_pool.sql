-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table integration_accounts add column if not exists label text;

alter table integration_accounts add column if not exists daily_cap bigint;

alter table integration_accounts add column if not exists warmup_enabled bigint NOT NULL DEFAULT 0;

alter table integration_accounts add column if not exists warmup_started_at text;

alter table integration_accounts add column if not exists status_reason text;

alter table integration_accounts add column if not exists health_reset_at text;

alter table integration_accounts add column if not exists config_json text;

UPDATE integration_accounts
   SET config_json = (
     SELECT i.config_json FROM integrations i WHERE i.id = integration_accounts.integration_id
   )
 WHERE network = 'email' AND config_json IS NULL;

UPDATE integration_accounts
   SET daily_cap = greatest(COALESCE((SELECT ws.autopilot_daily_cap FROM workspace_settings ws
                WHERE ws.workspace_id = integration_accounts.workspace_id), 0), COALESCE((SELECT MAX(CAST(((c.budget_json)::jsonb #>> '{maxActionsPerDay}') as bigint))
                 FROM campaigns c
                WHERE c.workspace_id = integration_accounts.workspace_id
                  AND c.budget_json LIKE '{%'), 0))
 WHERE network = 'email'
   AND daily_cap IS NULL
   AND greatest(COALESCE((SELECT ws.autopilot_daily_cap FROM workspace_settings ws
                WHERE ws.workspace_id = integration_accounts.workspace_id), 0), COALESCE((SELECT MAX(CAST(((c.budget_json)::jsonb #>> '{maxActionsPerDay}') as bigint))
                 FROM campaigns c
                WHERE c.workspace_id = integration_accounts.workspace_id
                  AND c.budget_json LIKE '{%'), 0)) > 50;

alter table actions add column if not exists sender_account_id text;

CREATE INDEX idx_actions_sender_day ON actions(sender_account_id, created_at);

CREATE INDEX idx_actions_sender_person ON actions(workspace_id, person_id, network, created_at);

create table sender_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  external_id text,
  detail text,
  occurred_at text NOT NULL
);

CREATE INDEX idx_sender_events_account ON sender_events(account_id, kind, occurred_at);

CREATE UNIQUE INDEX idx_sender_events_once
  ON sender_events(account_id, external_id)
  WHERE external_id IS NOT NULL;
