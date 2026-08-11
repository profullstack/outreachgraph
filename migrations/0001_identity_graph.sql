-- 0001_identity_graph.sql
-- Companies, people, social identities, evidence and provenance
-- (PRD §9, §10.3, §21, §22).

CREATE TABLE companies (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  domain          TEXT,
  employee_count  INTEGER,
  industry        TEXT,
  location        TEXT,
  technologies    TEXT NOT NULL DEFAULT '[]',
  funding_stage   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_companies_domain ON companies(domain) WHERE domain IS NOT NULL;

CREATE TABLE people (
  id                   TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  first_name           TEXT,
  last_name            TEXT,
  current_company_id   TEXT REFERENCES companies(id),
  current_title        TEXT,
  location             TEXT,
  identity_confidence  REAL NOT NULL DEFAULT 0,
  -- active | suppressed | deleted
  status               TEXT NOT NULL DEFAULT 'active',
  -- Denormalised gate so the approval queue never has to re-derive it.
  outreach_eligible    INTEGER NOT NULL DEFAULT 1,
  believed_minor       INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  last_resolved_at     TEXT
);

CREATE INDEX idx_people_company ON people(current_company_id);
CREATE INDEX idx_people_status ON people(status);

CREATE TABLE person_employment (
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title        TEXT,
  started_at   TEXT,
  ended_at     TEXT,
  is_current   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person_id, company_id, title)
);

CREATE INDEX idx_person_employment_current ON person_employment(person_id, is_current);

-- A confirmed link between a canonical person and an external account.
-- The (network, platform_user_id) uniqueness is what stops two canonical
-- people from both claiming the same real account (PRD §22).
CREATE TABLE social_identities (
  id                 TEXT PRIMARY KEY,
  person_id          TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  network            TEXT NOT NULL,
  handle             TEXT,
  platform_user_id   TEXT,
  profile_url        TEXT,
  confidence         REAL NOT NULL,
  source_type        TEXT NOT NULL,
  verified_by        TEXT NOT NULL DEFAULT '[]',
  first_seen_at      TEXT NOT NULL,
  last_verified_at   TEXT
);

CREATE UNIQUE INDEX idx_social_identities_platform
  ON social_identities(network, platform_user_id)
  WHERE platform_user_id IS NOT NULL;

CREATE INDEX idx_social_identities_person ON social_identities(person_id);
CREATE INDEX idx_social_identities_handle ON social_identities(network, handle);

-- Individual observations behind a link. Retained so a merge can be explained
-- to a reviewer and recomputed when weights change (PRD §9.3).
CREATE TABLE identity_evidence (
  id             TEXT PRIMARY KEY,
  -- Points at either a confirmed identity or a pending candidate.
  identity_id    TEXT REFERENCES social_identities(id) ON DELETE CASCADE,
  candidate_id   TEXT,
  kind           TEXT NOT NULL,
  detail         TEXT NOT NULL,
  strength       REAL NOT NULL,
  source_type    TEXT NOT NULL,
  source_url     TEXT,
  observed_at    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_identity_evidence_identity ON identity_evidence(identity_id);
CREATE INDEX idx_identity_evidence_candidate ON identity_evidence(candidate_id);

-- Proposed links scoring in the candidate band, awaiting human review.
CREATE TABLE identity_candidates (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id          TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  network            TEXT NOT NULL,
  handle             TEXT,
  platform_user_id   TEXT,
  profile_url        TEXT,
  score              REAL NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  created_at         TEXT NOT NULL,
  decided_at         TEXT,
  decided_by         TEXT REFERENCES users(id)
);

CREATE INDEX idx_identity_candidates_pending
  ON identity_candidates(workspace_id, status, score DESC);

-- One row per paid or fetched provider lookup. Lets the waterfall skip a
-- lookup it already paid for and lets deletion trace upstream (PRD §10.2).
CREATE TABLE provider_records (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  operation           TEXT NOT NULL,
  -- Hash of the normalised request, for dedupe across identical lookups.
  request_hash        TEXT NOT NULL,
  person_id           TEXT REFERENCES people(id) ON DELETE SET NULL,
  company_id          TEXT REFERENCES companies(id) ON DELETE SET NULL,
  source_record_id    TEXT,
  license_class       TEXT NOT NULL,
  retention_policy    TEXT,
  cost_usd            REAL NOT NULL DEFAULT 0,
  succeeded           INTEGER NOT NULL DEFAULT 1,
  observed_at         TEXT NOT NULL,
  expires_at          TEXT
);

CREATE UNIQUE INDEX idx_provider_records_dedupe
  ON provider_records(workspace_id, provider, operation, request_hash);

CREATE INDEX idx_provider_records_person ON provider_records(person_id);

-- Field-level attribution. Every material fact used in scoring or messaging
-- resolves to a row here (PRD §10.3, §48 Decision 3).
CREATE TABLE field_provenance (
  id                  TEXT PRIMARY KEY,
  entity_kind         TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  field               TEXT NOT NULL,
  value               TEXT NOT NULL,
  source_type         TEXT NOT NULL,
  provider            TEXT,
  source_record_id    TEXT,
  source_url          TEXT,
  license_class       TEXT NOT NULL,
  retention_policy    TEXT,
  confidence          REAL NOT NULL DEFAULT 1.0,
  observed_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_field_provenance_entity ON field_provenance(entity_kind, entity_id, field);
CREATE INDEX idx_field_provenance_provider ON field_provenance(provider);
