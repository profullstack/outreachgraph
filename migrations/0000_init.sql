-- 0000_init.sql
-- Accounts, workspaces and the campaign wizard's output (PRD §21, §7).
--
-- Conventions used throughout every migration in this directory:
--   * ids are TEXT prefixed ids from @outreachgraph/domain (per_, sig_, ...)
--   * timestamps are TEXT ISO-8601 UTC, so SQLite string ordering is time ordering
--   * booleans are INTEGER 0/1
--   * JSON-shaped columns are TEXT holding a JSON document
--   * every workspace-scoped table carries workspace_id for row-level isolation

CREATE TABLE organizations (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT,
  password_hash   TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member',
  created_at      TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);

-- Agencies run many client workspaces under one organization (PRD §5.1).
CREATE TABLE workspaces (
  id                       TEXT PRIMARY KEY,
  organization_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  slug                     TEXT NOT NULL,
  -- Workspace override of the identity merge thresholds (PRD §9.4).
  auto_merge_threshold     REAL NOT NULL DEFAULT 0.90,
  candidate_threshold      REAL NOT NULL DEFAULT 0.70,
  -- Identities below this may not be used for outreach (PRD §9.4).
  min_outreach_confidence  REAL NOT NULL DEFAULT 0.85,
  status                   TEXT NOT NULL DEFAULT 'active',
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  UNIQUE (organization_id, slug)
);

CREATE INDEX idx_workspaces_org ON workspaces(organization_id);

-- Connected accounts and provider credentials. Secrets are stored encrypted and
-- are never passed to model prompts (PRD §34).
CREATE TABLE integrations (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  network        TEXT,
  status         TEXT NOT NULL DEFAULT 'disconnected',
  config_json    TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (workspace_id, kind, network)
);

CREATE TABLE integration_accounts (
  id                    TEXT PRIMARY KEY,
  integration_id        TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  network               TEXT NOT NULL,
  external_account_id   TEXT,
  handle                TEXT,
  -- Encrypted at rest; the column never leaves the API process in plaintext.
  access_token_enc      TEXT,
  refresh_token_enc     TEXT,
  scopes                TEXT NOT NULL DEFAULT '[]',
  expires_at            TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX idx_integration_accounts_ws ON integration_accounts(workspace_id, network);

CREATE TABLE offerings (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  category             TEXT NOT NULL,
  url                  TEXT,
  description          TEXT,
  value_propositions   TEXT NOT NULL DEFAULT '[]',
  likely_pains         TEXT NOT NULL DEFAULT '[]',
  competitors          TEXT NOT NULL DEFAULT '[]',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX idx_offerings_ws ON offerings(workspace_id);

CREATE TABLE voice_profiles (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  style               TEXT NOT NULL,
  instructions        TEXT,
  samples             TEXT NOT NULL DEFAULT '[]',
  max_words           INTEGER,
  prohibited_claims   TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_voice_profiles_ws ON voice_profiles(workspace_id);

CREATE TABLE campaigns (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  offering_id        TEXT NOT NULL REFERENCES offerings(id),
  voice_profile_id   TEXT REFERENCES voice_profiles(id),
  brief              TEXT,
  networks           TEXT NOT NULL DEFAULT '[]',
  -- research_only | draft_and_approve | trusted_automation (PRD §7.6)
  approval_mode      TEXT NOT NULL DEFAULT 'draft_and_approve',
  budget_json        TEXT NOT NULL DEFAULT '{}',
  score_weights_json TEXT,
  status             TEXT NOT NULL DEFAULT 'draft',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  started_at         TEXT
);

CREATE INDEX idx_campaigns_ws_status ON campaigns(workspace_id, status);

-- Kept as its own row rather than a JSON blob on campaigns so the generated
-- filters stay inspectable and editable (PRD §26: never silently hide filters).
CREATE TABLE campaign_filters (
  campaign_id         TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  titles              TEXT NOT NULL DEFAULT '[]',
  seniorities         TEXT NOT NULL DEFAULT '[]',
  industries          TEXT NOT NULL DEFAULT '[]',
  countries           TEXT NOT NULL DEFAULT '[]',
  technologies        TEXT NOT NULL DEFAULT '[]',
  keywords            TEXT NOT NULL DEFAULT '[]',
  exclusions          TEXT NOT NULL DEFAULT '[]',
  funding_stages      TEXT NOT NULL DEFAULT '[]',
  employee_count_min  INTEGER,
  employee_count_max  INTEGER,
  hiring              INTEGER,
  updated_at          TEXT NOT NULL
);

CREATE TABLE campaign_signal_rules (
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  signal_type   TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  weight        REAL NOT NULL DEFAULT 1.0,
  keywords      TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (campaign_id, signal_type)
);
