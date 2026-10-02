-- 0046_job_posts.sql (Postgres). See migrations/0046_job_posts.sql for the reasoning.

create table if not exists job_posts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id text REFERENCES campaigns(id) ON DELETE SET NULL,
  url text NOT NULL,
  source text NOT NULL,
  account text,
  board_job_id text,
  title text,
  company text,
  company_domain text,
  location text,
  remote bigint,
  salary text,
  posted_at text,
  description text,
  agency bigint NOT NULL DEFAULT 0,
  published_emails_json text NOT NULL DEFAULT '[]',
  keyword text,
  status text NOT NULL DEFAULT 'new',
  notes text,
  last_error text,
  resolved_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_posts_url ON job_posts(workspace_id, url);
CREATE INDEX IF NOT EXISTS idx_job_posts_status ON job_posts(workspace_id, status, created_at);

create table if not exists job_post_contacts (
  id text PRIMARY KEY,
  job_post_id text NOT NULL REFERENCES job_posts(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  network text NOT NULL,
  handle text NOT NULL,
  profile_url text NOT NULL,
  headline text,
  snippet text,
  role text NOT NULL,
  score double precision NOT NULL,
  email text,
  email_source text,
  on_company_site bigint NOT NULL DEFAULT 0,
  person_id text REFERENCES people(id) ON DELETE SET NULL,
  created_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_post_contacts_handle
  ON job_post_contacts(job_post_id, network, handle);
