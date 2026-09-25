-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table suppression_entries (
  id text PRIMARY KEY,
  reason text NOT NULL,
  scope text NOT NULL DEFAULT 'global',
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  source text NOT NULL,
  created_at text NOT NULL,
  expires_at text
);

create table suppression_keys (
  match_key text NOT NULL,
  suppression_id text NOT NULL REFERENCES suppression_entries(id) ON DELETE CASCADE,
  scope text NOT NULL,
  workspace_id text,
  PRIMARY KEY (match_key, suppression_id)
);

CREATE INDEX idx_suppression_keys_lookup ON suppression_keys(match_key, scope);

create table privacy_requests (
  id text PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'received',
  source_channel text NOT NULL,
  subject_match_keys text NOT NULL DEFAULT '[]',
  received_at text NOT NULL,
  due_at text,
  completed_at text,
  note text
);

CREATE INDEX idx_privacy_requests_open ON privacy_requests(status, due_at);

create table deletion_jobs (
  id text PRIMARY KEY,
  privacy_request_id text REFERENCES privacy_requests(id) ON DELETE SET NULL,
  person_id text,
  status text NOT NULL DEFAULT 'pending',
  deleted_counts_json text NOT NULL DEFAULT '{}',
  error text,
  created_at text NOT NULL,
  started_at text,
  completed_at text
);

CREATE INDEX idx_deletion_jobs_status ON deletion_jobs(status, created_at);

create table policy_versions (
  id text PRIMARY KEY,
  version text NOT NULL UNIQUE,
  notes text,
  active bigint NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  activated_at text
);

create table policy_rules (
  id text PRIMARY KEY,
  policy_version_id text NOT NULL REFERENCES policy_versions(id) ON DELETE CASCADE,
  network text NOT NULL,
  capability text NOT NULL,
  mode text NOT NULL,
  reason text NOT NULL,
  source text NOT NULL DEFAULT 'platform_policy',
  reviewed_at text NOT NULL,
  next_review_at text,
  UNIQUE (policy_version_id, network, capability)
);

CREATE INDEX idx_policy_rules_lookup ON policy_rules(policy_version_id, network, capability);

create table feature_flags (
  "key" text NOT NULL,
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled bigint NOT NULL DEFAULT 0,
  note text,
  updated_at text NOT NULL,
  PRIMARY KEY (key, workspace_id)
);

create table usage_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id text REFERENCES campaigns(id) ON DELETE SET NULL,
  person_id text,
  unit text NOT NULL,
  quantity double precision NOT NULL DEFAULT 1,
  cost_usd double precision NOT NULL DEFAULT 0,
  provider text,
  occurred_at text NOT NULL
);

CREATE INDEX idx_usage_events_ws ON usage_events(workspace_id, occurred_at DESC);

CREATE INDEX idx_usage_events_unit ON usage_events(workspace_id, unit, occurred_at DESC);

create table billing_accounts (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free',
  status text NOT NULL DEFAULT 'active',
  external_customer_id text,
  included_credits bigint NOT NULL DEFAULT 100,
  credits_used bigint NOT NULL DEFAULT 0,
  period_started_at text,
  period_ends_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX idx_billing_accounts_org ON billing_accounts(organization_id);

create table audit_events (
  id text PRIMARY KEY,
  workspace_id text,
  actor_kind text NOT NULL,
  actor_id text,
  event_type text NOT NULL,
  entity_kind text,
  entity_id text,
  detail_json text NOT NULL DEFAULT '{}',
  occurred_at text NOT NULL
);

CREATE INDEX idx_audit_events_ws ON audit_events(workspace_id, occurred_at DESC);

CREATE INDEX idx_audit_events_entity ON audit_events(entity_kind, entity_id);

CREATE INDEX idx_audit_events_type ON audit_events(event_type, occurred_at DESC);
