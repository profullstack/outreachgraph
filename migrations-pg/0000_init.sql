-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

create table users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  password_hash text,
  status text NOT NULL DEFAULT 'active',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

create table organization_members (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at text NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

create table workspaces (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  auto_merge_threshold double precision NOT NULL DEFAULT 0.90,
  candidate_threshold double precision NOT NULL DEFAULT 0.70,
  min_outreach_confidence double precision NOT NULL DEFAULT 0.85,
  status text NOT NULL DEFAULT 'active',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (organization_id, slug)
);

CREATE INDEX idx_workspaces_org ON workspaces(organization_id);

create table integrations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  network text,
  status text NOT NULL DEFAULT 'disconnected',
  config_json text NOT NULL DEFAULT '{}',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (workspace_id, kind, network)
);

create table integration_accounts (
  id text PRIMARY KEY,
  integration_id text NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  network text NOT NULL,
  external_account_id text,
  handle text,
  access_token_enc text,
  refresh_token_enc text,
  scopes text NOT NULL DEFAULT '[]',
  expires_at text,
  status text NOT NULL DEFAULT 'active',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX idx_integration_accounts_ws ON integration_accounts(workspace_id, network);

create table offerings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL,
  url text,
  description text,
  value_propositions text NOT NULL DEFAULT '[]',
  likely_pains text NOT NULL DEFAULT '[]',
  competitors text NOT NULL DEFAULT '[]',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX idx_offerings_ws ON offerings(workspace_id);

create table voice_profiles (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  style text NOT NULL,
  instructions text,
  samples text NOT NULL DEFAULT '[]',
  max_words bigint,
  prohibited_claims text NOT NULL DEFAULT '[]',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX idx_voice_profiles_ws ON voice_profiles(workspace_id);

create table campaigns (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  offering_id text NOT NULL REFERENCES offerings(id),
  voice_profile_id text REFERENCES voice_profiles(id),
  brief text,
  networks text NOT NULL DEFAULT '[]',
  approval_mode text NOT NULL DEFAULT 'draft_and_approve',
  budget_json text NOT NULL DEFAULT '{}',
  score_weights_json text,
  status text NOT NULL DEFAULT 'draft',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  started_at text
);

CREATE INDEX idx_campaigns_ws_status ON campaigns(workspace_id, status);

create table campaign_filters (
  campaign_id text PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  titles text NOT NULL DEFAULT '[]',
  seniorities text NOT NULL DEFAULT '[]',
  industries text NOT NULL DEFAULT '[]',
  countries text NOT NULL DEFAULT '[]',
  technologies text NOT NULL DEFAULT '[]',
  keywords text NOT NULL DEFAULT '[]',
  exclusions text NOT NULL DEFAULT '[]',
  funding_stages text NOT NULL DEFAULT '[]',
  employee_count_min bigint,
  employee_count_max bigint,
  hiring bigint,
  updated_at text NOT NULL
);

create table campaign_signal_rules (
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  signal_type text NOT NULL,
  enabled bigint NOT NULL DEFAULT 1,
  weight double precision NOT NULL DEFAULT 1.0,
  keywords text NOT NULL DEFAULT '[]',
  PRIMARY KEY (campaign_id, signal_type)
);
