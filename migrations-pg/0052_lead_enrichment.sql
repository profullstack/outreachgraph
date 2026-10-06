-- 0052_lead_enrichment.sql (Postgres). See migrations/0052_lead_enrichment.sql for the reasoning.
-- Two nullable ADD COLUMNs (no rewrite) and two new, empty tables. No index on an existing table.

ALTER TABLE people ADD COLUMN IF NOT EXISTS linkedin_looked_up_at text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS linkedin_url text;

create table if not exists serp_cache (
  query text PRIMARY KEY,
  results text NOT NULL,
  fetched_at text NOT NULL
);

create table if not exists enrichment_usage (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day text NOT NULL,
  provider text NOT NULL,
  lookups bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, provider)
);
