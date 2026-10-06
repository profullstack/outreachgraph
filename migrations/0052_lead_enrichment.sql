-- 0052_lead_enrichment.sql
--
-- Filling in a lead's missing name, job title and LinkedIn from free and
-- cheap sources (the address itself, a Google search of LinkedIn, and People
-- Data Labs when a key is configured).
--
-- people.linkedin_looked_up_at is the "already tried" stamp, like
-- photo_looked_up_at: most searches find nothing, and a sweep that only
-- recorded hits would pay for the same misses forever. Deliberately no index:
-- the sweep reaches people through campaign_people, never by scanning this.
--
-- companies.linkedin_url is the company page, the fallback when no person
-- profile is evidenced.
--
-- serp_cache keeps every search's raw results, keyed by the query, so a rerun
-- (or a tightened matching rule) costs nothing. Public search results, not
-- per workspace.
--
-- enrichment_usage counts paid lookups per workspace per day, so the daily cap
-- survives a restart.

ALTER TABLE people ADD COLUMN linkedin_looked_up_at TEXT;
ALTER TABLE companies ADD COLUMN linkedin_url TEXT;

CREATE TABLE IF NOT EXISTS serp_cache (
  query       TEXT PRIMARY KEY,
  results     TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrichment_usage (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day          TEXT NOT NULL,
  provider     TEXT NOT NULL,
  lookups      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, provider)
);
