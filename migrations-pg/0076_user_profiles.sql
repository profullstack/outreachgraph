-- 0076_user_profiles.sql (Postgres). See migrations/0076_user_profiles.sql for the reasoning.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id text PRIMARY KEY,
  email text,
  first_name text,
  last_name text,
  company_domain text,
  job_title text,
  linkedin_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_profiles_email ON user_profiles (lower(email));
CREATE INDEX IF NOT EXISTS user_profiles_company_domain ON user_profiles (company_domain);

INSERT INTO user_profiles (user_id, email, first_name, last_name)
SELECT id,
       email,
       split_part(btrim(name), ' ', 1),
       nullif(btrim(substr(btrim(name), strpos(btrim(name), ' ') + 1)), btrim(name))
FROM users
WHERE name IS NOT NULL AND btrim(name) <> '' AND strpos(name, '@') = 0
ON CONFLICT (user_id) DO NOTHING;
