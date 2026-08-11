-- 0002_signals.sql
-- Source documents, signals, campaign membership and scores
-- (PRD §11, §12, §21, §22).

-- A retained source artifact. Retention is minimised by default (PRD §35);
-- `availability` flips to 'unavailable' when the upstream source disappears so
-- derived claims stop citing it (PRD §17.6).
CREATE TABLE source_documents (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  network        TEXT NOT NULL,
  url            TEXT,
  title          TEXT,
  excerpt        TEXT,
  content_hash   TEXT,
  published_at   TEXT,
  fetched_at     TEXT NOT NULL,
  -- available | unavailable | expired
  availability   TEXT NOT NULL DEFAULT 'available',
  license_class  TEXT NOT NULL,
  expires_at     TEXT
);

CREATE INDEX idx_source_documents_ws ON source_documents(workspace_id, fetched_at DESC);
CREATE UNIQUE INDEX idx_source_documents_hash
  ON source_documents(workspace_id, content_hash)
  WHERE content_hash IS NOT NULL;

CREATE TABLE signals (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id            TEXT REFERENCES people(id) ON DELETE CASCADE,
  company_id           TEXT REFERENCES companies(id) ON DELETE CASCADE,
  network              TEXT NOT NULL,
  signal_type          TEXT NOT NULL,
  subtype              TEXT,
  summary              TEXT NOT NULL,
  -- Verbatim excerpt backing the summary. Without it the composer may not
  -- reference this signal in a personalised claim (PRD §14.1).
  evidence             TEXT,
  source_document_id   TEXT REFERENCES source_documents(id) ON DELETE SET NULL,
  source_url           TEXT,
  source_timestamp     TEXT,
  observed_at          TEXT NOT NULL,
  confidence           REAL NOT NULL,
  relevance            REAL NOT NULL,
  sentiment            TEXT NOT NULL DEFAULT 'neutral',
  expires_at           TEXT
);

-- The signal feed reads "recent, relevant, for this workspace" constantly.
CREATE INDEX idx_signals_feed
  ON signals(workspace_id, source_timestamp DESC);
CREATE INDEX idx_signals_person ON signals(person_id, source_timestamp DESC);
CREATE INDEX idx_signals_type ON signals(workspace_id, signal_type);

-- Membership of a person in a campaign, carrying the pipeline state machine
-- (PRD §8). A person may sit in several campaigns at different stages.
CREATE TABLE campaign_people (
  campaign_id        TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id          TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'discovered',
  interaction_state  TEXT NOT NULL DEFAULT 'never_contacted',
  status_reason      TEXT,
  discovered_at      TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  last_researched_at TEXT,
  last_actioned_at   TEXT,
  PRIMARY KEY (campaign_id, person_id)
);

CREATE INDEX idx_campaign_people_status ON campaign_people(campaign_id, status);
CREATE INDEX idx_campaign_people_person ON campaign_people(person_id);

-- Score snapshots. Stored per (campaign, person) because ICP fit and intent are
-- relative to a specific offering — the same person scores differently in two
-- campaigns (PRD §12).
CREATE TABLE scores (
  id                   TEXT PRIMARY KEY,
  campaign_id          TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id            TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  icp_fit              REAL NOT NULL DEFAULT 0,
  identity_confidence  REAL NOT NULL DEFAULT 0,
  intent               REAL NOT NULL DEFAULT 0,
  reachability         REAL NOT NULL DEFAULT 0,
  relationship         REAL NOT NULL DEFAULT 0,
  opportunity          REAL NOT NULL DEFAULT 0,
  -- The weights used, so a historical score stays explainable after a change.
  weights_json         TEXT NOT NULL DEFAULT '{}',
  computed_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_scores_current ON scores(campaign_id, person_id);
CREATE INDEX idx_scores_ranking ON scores(campaign_id, opportunity DESC);
