-- 0074_company_exclusions.sql: imported companies retired from the lead base.
--
-- The first importer runs let platforms and megacorps in (google.com,
-- instagram.com, apple.com top the Majestic Million). They are retired, not
-- deleted: `excluded_at` and `excluded_reason` say when and why, the row keeps
-- its domain so a later import cannot add it back, and every reader of the
-- lead base (picks, audits, the directory, the source counts) skips it. A
-- company anyone has worked with (people, signals, a crawl) is never retired.
ALTER TABLE companies ADD COLUMN excluded_at TEXT;
ALTER TABLE companies ADD COLUMN excluded_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_excluded ON companies (excluded_reason)
  WHERE excluded_at IS NOT NULL;
