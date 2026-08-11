-- 0004_compliance_billing.sql
-- Suppression, privacy, policy, usage and audit (PRD §17, §18, §21, §30, §36).

-- Tombstones that outlive the person record. A suppression entry must survive
-- deletion of the prospect profile so a later provider lookup cannot silently
-- re-ingest someone who opted out (PRD §6.6, §17.3).
CREATE TABLE suppression_entries (
  id                TEXT PRIMARY KEY,
  reason            TEXT NOT NULL,
  -- global | organization | workspace
  scope             TEXT NOT NULL DEFAULT 'global',
  workspace_id      TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  organization_id   TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  source            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT
);

-- One row per match key so lookup is an index hit, not a JSON scan. This table
-- deliberately holds no personal data beyond the minimal identifier needed to
-- recognise a suppressed subject (PRD §17.3).
CREATE TABLE suppression_keys (
  match_key       TEXT NOT NULL,
  suppression_id  TEXT NOT NULL REFERENCES suppression_entries(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,
  workspace_id    TEXT,
  PRIMARY KEY (match_key, suppression_id)
);

CREATE INDEX idx_suppression_keys_lookup ON suppression_keys(match_key, scope);

CREATE TABLE privacy_requests (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'received',
  -- drop | web_form | email | admin. 'drop' is California's Delete Request and
  -- Opt-out Platform, polled at least every 45 days (PRD §17.2).
  source_channel       TEXT NOT NULL,
  subject_match_keys   TEXT NOT NULL DEFAULT '[]',
  received_at          TEXT NOT NULL,
  due_at               TEXT,
  completed_at         TEXT,
  note                 TEXT
);

CREATE INDEX idx_privacy_requests_open ON privacy_requests(status, due_at);

-- Tracks the work of honouring a request, so processing status is provable.
CREATE TABLE deletion_jobs (
  id                   TEXT PRIMARY KEY,
  privacy_request_id   TEXT REFERENCES privacy_requests(id) ON DELETE SET NULL,
  person_id            TEXT,
  status               TEXT NOT NULL DEFAULT 'pending',
  -- Counts of what was removed, retained as evidence of processing.
  deleted_counts_json  TEXT NOT NULL DEFAULT '{}',
  error                TEXT,
  created_at           TEXT NOT NULL,
  started_at           TEXT,
  completed_at         TEXT
);

CREATE INDEX idx_deletion_jobs_status ON deletion_jobs(status, created_at);

-- Versioned, deterministic platform rules. The engine resolves a decision
-- against one version so a recommendation records which rules produced it
-- (PRD §16.1, §20.8).
CREATE TABLE policy_versions (
  id            TEXT PRIMARY KEY,
  version       TEXT NOT NULL UNIQUE,
  notes         TEXT,
  active        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  activated_at  TEXT
);

CREATE TABLE policy_rules (
  id                TEXT PRIMARY KEY,
  policy_version_id TEXT NOT NULL REFERENCES policy_versions(id) ON DELETE CASCADE,
  network           TEXT NOT NULL,
  capability        TEXT NOT NULL,
  -- disabled | research_only | draft_only | manual_only | official_api |
  -- approved_partner | customer_managed (PRD §16.2)
  mode              TEXT NOT NULL,
  reason            TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'platform_policy',
  reviewed_at       TEXT NOT NULL,
  next_review_at    TEXT,
  UNIQUE (policy_version_id, network, capability)
);

CREATE INDEX idx_policy_rules_lookup ON policy_rules(policy_version_id, network, capability);

-- Remote kill switches for platform capabilities (PRD §37).
CREATE TABLE feature_flags (
  key           TEXT NOT NULL,
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled       INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (key, workspace_id)
);

-- Metered consumption, priced per PRD §30.1.
CREATE TABLE usage_events (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id    TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  person_id      TEXT,
  -- resolution | research | ai | action | discovery
  unit           TEXT NOT NULL,
  quantity       REAL NOT NULL DEFAULT 1,
  -- Provider cost, for the COGS-per-prospect dashboard (PRD §31).
  cost_usd       REAL NOT NULL DEFAULT 0,
  provider       TEXT,
  occurred_at    TEXT NOT NULL
);

CREATE INDEX idx_usage_events_ws ON usage_events(workspace_id, occurred_at DESC);
CREATE INDEX idx_usage_events_unit ON usage_events(workspace_id, unit, occurred_at DESC);

CREATE TABLE billing_accounts (
  id                  TEXT PRIMARY KEY,
  organization_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan                TEXT NOT NULL DEFAULT 'free',
  status              TEXT NOT NULL DEFAULT 'active',
  external_customer_id TEXT,
  included_credits    INTEGER NOT NULL DEFAULT 100,
  credits_used        INTEGER NOT NULL DEFAULT 0,
  period_started_at   TEXT,
  period_ends_at      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_billing_accounts_org ON billing_accounts(organization_id);

-- Append-only. Every policy decision, execution and privacy action lands here
-- (PRD §18, §20.9, §34).
CREATE TABLE audit_events (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT,
  actor_kind     TEXT NOT NULL,
  actor_id       TEXT,
  event_type     TEXT NOT NULL,
  entity_kind    TEXT,
  entity_id      TEXT,
  detail_json    TEXT NOT NULL DEFAULT '{}',
  occurred_at    TEXT NOT NULL
);

CREATE INDEX idx_audit_events_ws ON audit_events(workspace_id, occurred_at DESC);
CREATE INDEX idx_audit_events_entity ON audit_events(entity_kind, entity_id);
CREATE INDEX idx_audit_events_type ON audit_events(event_type, occurred_at DESC);
