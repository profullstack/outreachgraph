-- 0076_user_profiles.sql: the account holder's own profile (@profullstack/profile).
--
-- Email, first/last name, company domain, job title and LinkedIn URL of the
-- person who signed up, keyed by users.id. Not prospects: people found by the
-- pipeline keep their own tables. DDL from `profile schema --dialect sqlite
-- --key user_id --key-type text`.
--
-- Backfill: users.name (optional at registration) split on the first space,
-- first word to first_name and the rest to last_name. Only rows that look like
-- a person's name (no "@"); a row that already exists is left alone.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  company_domain TEXT,
  job_title TEXT,
  linkedin_url TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS user_profiles_email ON user_profiles (lower(email));
CREATE INDEX IF NOT EXISTS user_profiles_company_domain ON user_profiles (company_domain);

INSERT INTO user_profiles (user_id, email, first_name, last_name)
SELECT id,
       email,
       CASE WHEN instr(trim(name), ' ') > 0 THEN substr(trim(name), 1, instr(trim(name), ' ') - 1) ELSE trim(name) END,
       CASE WHEN instr(trim(name), ' ') > 0 THEN trim(substr(trim(name), instr(trim(name), ' ') + 1)) END
FROM users
WHERE name IS NOT NULL AND trim(name) <> '' AND instr(name, '@') = 0
ON CONFLICT (user_id) DO NOTHING;
