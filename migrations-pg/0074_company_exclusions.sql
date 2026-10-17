-- 0074_company_exclusions.sql (Postgres). See migrations/0074_company_exclusions.sql for the reasoning.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS excluded_at text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS excluded_reason text;

CREATE INDEX IF NOT EXISTS idx_companies_excluded ON companies (excluded_reason)
  WHERE excluded_at IS NOT NULL;
