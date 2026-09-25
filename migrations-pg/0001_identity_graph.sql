-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table companies (
  id text PRIMARY KEY,
  name text NOT NULL,
  domain text,
  employee_count bigint,
  industry text,
  location text,
  technologies text NOT NULL DEFAULT '[]',
  funding_stage text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX idx_companies_domain ON companies(domain) WHERE domain IS NOT NULL;

create table people (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  first_name text,
  last_name text,
  current_company_id text REFERENCES companies(id),
  current_title text,
  location text,
  identity_confidence double precision NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  outreach_eligible bigint NOT NULL DEFAULT 1,
  believed_minor bigint NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  last_resolved_at text
);

CREATE INDEX idx_people_company ON people(current_company_id);

CREATE INDEX idx_people_status ON people(status);

create table person_employment (
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title text,
  started_at text,
  ended_at text,
  is_current bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (person_id, company_id, title)
);

CREATE INDEX idx_person_employment_current ON person_employment(person_id, is_current);

create table social_identities (
  id text PRIMARY KEY,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  network text NOT NULL,
  handle text,
  platform_user_id text,
  profile_url text,
  confidence double precision NOT NULL,
  source_type text NOT NULL,
  verified_by text NOT NULL DEFAULT '[]',
  first_seen_at text NOT NULL,
  last_verified_at text
);

CREATE UNIQUE INDEX idx_social_identities_platform
  ON social_identities(network, platform_user_id)
  WHERE platform_user_id IS NOT NULL;

CREATE INDEX idx_social_identities_person ON social_identities(person_id);

CREATE INDEX idx_social_identities_handle ON social_identities(network, handle);

create table identity_evidence (
  id text PRIMARY KEY,
  identity_id text REFERENCES social_identities(id) ON DELETE CASCADE,
  candidate_id text,
  kind text NOT NULL,
  detail text NOT NULL,
  strength double precision NOT NULL,
  source_type text NOT NULL,
  source_url text,
  observed_at text NOT NULL,
  created_at text NOT NULL
);

CREATE INDEX idx_identity_evidence_identity ON identity_evidence(identity_id);

CREATE INDEX idx_identity_evidence_candidate ON identity_evidence(candidate_id);

create table identity_candidates (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  network text NOT NULL,
  handle text,
  platform_user_id text,
  profile_url text,
  score double precision NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at text NOT NULL,
  decided_at text,
  decided_by text REFERENCES users(id)
);

CREATE INDEX idx_identity_candidates_pending
  ON identity_candidates(workspace_id, status, score DESC);

create table provider_records (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  person_id text REFERENCES people(id) ON DELETE SET NULL,
  company_id text REFERENCES companies(id) ON DELETE SET NULL,
  source_record_id text,
  license_class text NOT NULL,
  retention_policy text,
  cost_usd double precision NOT NULL DEFAULT 0,
  succeeded bigint NOT NULL DEFAULT 1,
  observed_at text NOT NULL,
  expires_at text
);

CREATE UNIQUE INDEX idx_provider_records_dedupe
  ON provider_records(workspace_id, provider, operation, request_hash);

CREATE INDEX idx_provider_records_person ON provider_records(person_id);

create table field_provenance (
  id text PRIMARY KEY,
  entity_kind text NOT NULL,
  entity_id text NOT NULL,
  field text NOT NULL,
  value text NOT NULL,
  source_type text NOT NULL,
  provider text,
  source_record_id text,
  source_url text,
  license_class text NOT NULL,
  retention_policy text,
  confidence double precision NOT NULL DEFAULT 1.0,
  observed_at text NOT NULL,
  created_at text NOT NULL
);

CREATE INDEX idx_field_provenance_entity ON field_provenance(entity_kind, entity_id, field);

CREATE INDEX idx_field_provenance_provider ON field_provenance(provider);
