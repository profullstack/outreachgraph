-- 0071_lead_sources.sql: the lead base grows from open lists, one source at a time.
--
-- A company row keyed by its domain is the cheap unit of a lead: a name, a
-- site, a country and where it came from cost nothing to store, while people
-- and addresses are the expensive enrichment step that runs only for rows a
-- campaign picks. Importers (packages/pipeline/src/lead-sources) read open
-- lists (Wikidata, the Majestic Million, nichedb.dev collections) into
-- `companies`, each on its own daily cap and cursor, recorded here so a run
-- resumes where the last one stopped and the status view can say how far
-- each source has got.
--
-- `lead_source` is null for every row the crawler, an import or a job post
-- made; only bulk importers set it, which is how the find-email name match
-- keeps to companies something actually read.
ALTER TABLE companies ADD COLUMN lead_source TEXT;
ALTER TABLE companies ADD COLUMN lead_ref TEXT;
ALTER TABLE companies ADD COLUMN country TEXT;
ALTER TABLE companies ADD COLUMN lead_rank INTEGER;

CREATE INDEX IF NOT EXISTS idx_companies_lead_source ON companies (lead_source)
  WHERE lead_source IS NOT NULL;
-- The public directory pages companies by (updated_at, id).
CREATE INDEX IF NOT EXISTS idx_companies_updated ON companies (updated_at, id);
-- find-email matches a person's employer by name, among companies that were read.
CREATE INDEX IF NOT EXISTS idx_companies_name_read ON companies (lower(trim(name)))
  WHERE lead_source IS NULL;

-- Picking imported companies for a campaign skips those it already crawled.
CREATE INDEX IF NOT EXISTS idx_jobs_dedupe_any ON jobs (workspace_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS lead_sources (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  daily_cap INTEGER NOT NULL DEFAULT 0,
  cursor TEXT,
  day TEXT,
  added_today INTEGER NOT NULL DEFAULT 0,
  seen_total INTEGER NOT NULL DEFAULT 0,
  added_total INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_added INTEGER,
  last_error TEXT,
  next_run_at TEXT,
  exhausted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
