-- 0053_list_quality.sql (Postgres). See migrations/0053_list_quality.sql for the reasoning.
-- Two new, empty tables. Nothing existing is altered.

create table if not exists email_verifications (
  address text PRIMARY KEY,
  status text NOT NULL,
  reason text,
  mx text,
  checked_at text NOT NULL
);

create table if not exists campaign_list_health (
  campaign_id text PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  window_start text NOT NULL,
  paused_at text,
  paused_rate double precision,
  resumed_at text,
  updated_at text NOT NULL
);
