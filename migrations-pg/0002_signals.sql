-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table source_documents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  network text NOT NULL,
  url text,
  title text,
  excerpt text,
  content_hash text,
  published_at text,
  fetched_at text NOT NULL,
  availability text NOT NULL DEFAULT 'available',
  license_class text NOT NULL,
  expires_at text
);

CREATE INDEX idx_source_documents_ws ON source_documents(workspace_id, fetched_at DESC);

CREATE UNIQUE INDEX idx_source_documents_hash
  ON source_documents(workspace_id, content_hash)
  WHERE content_hash IS NOT NULL;

create table signals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text REFERENCES people(id) ON DELETE CASCADE,
  company_id text REFERENCES companies(id) ON DELETE CASCADE,
  network text NOT NULL,
  signal_type text NOT NULL,
  subtype text,
  summary text NOT NULL,
  evidence text,
  source_document_id text REFERENCES source_documents(id) ON DELETE SET NULL,
  source_url text,
  source_timestamp text,
  observed_at text NOT NULL,
  confidence double precision NOT NULL,
  relevance double precision NOT NULL,
  sentiment text NOT NULL DEFAULT 'neutral',
  expires_at text
);

CREATE INDEX idx_signals_feed
  ON signals(workspace_id, source_timestamp DESC);

CREATE INDEX idx_signals_person ON signals(person_id, source_timestamp DESC);

CREATE INDEX idx_signals_type ON signals(workspace_id, signal_type);

create table campaign_people (
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'discovered',
  interaction_state text NOT NULL DEFAULT 'never_contacted',
  status_reason text,
  discovered_at text NOT NULL,
  updated_at text NOT NULL,
  last_researched_at text,
  last_actioned_at text,
  PRIMARY KEY (campaign_id, person_id)
);

CREATE INDEX idx_campaign_people_status ON campaign_people(campaign_id, status);

CREATE INDEX idx_campaign_people_person ON campaign_people(person_id);

create table scores (
  id text PRIMARY KEY,
  campaign_id text NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  icp_fit double precision NOT NULL DEFAULT 0,
  identity_confidence double precision NOT NULL DEFAULT 0,
  intent double precision NOT NULL DEFAULT 0,
  reachability double precision NOT NULL DEFAULT 0,
  relationship double precision NOT NULL DEFAULT 0,
  opportunity double precision NOT NULL DEFAULT 0,
  weights_json text NOT NULL DEFAULT '{}',
  computed_at text NOT NULL
);

CREATE UNIQUE INDEX idx_scores_current ON scores(campaign_id, person_id);

CREATE INDEX idx_scores_ranking ON scores(campaign_id, opportunity DESC);
