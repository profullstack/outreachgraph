-- 0046_job_posts.sql
-- Job postings as an intake source.
--
-- A company advertising a senior engineering role has said in public that it
-- needs engineering done and has budget for it, which is the best opening
-- there is for offering agentic work. A posting names a company and almost
-- never a person, so each one carries the people a search found behind it,
-- with the search result kept as the evidence.
--
-- Two tables and no new columns anywhere else. A contact the operator wants to
-- write to joins a campaign through `intakeSocialPeople`, so identity
-- confidence, the policy engine and human approval all apply unchanged.

CREATE TABLE IF NOT EXISTS job_posts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Where a promoted contact goes. Optional: a posting can be kept just to
  -- see who is behind it.
  campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,

  -- Canonical, from `parseJobUrl`: the same posting pasted twice is one row.
  url TEXT NOT NULL,
  -- 'workable' | 'greenhouse' | 'lever' | 'ashby' | 'other'.
  source TEXT NOT NULL,
  account TEXT,
  board_job_id TEXT,

  -- What the posting says, in its own words.
  title TEXT,
  company TEXT,
  company_domain TEXT,
  location TEXT,
  remote INTEGER,
  salary TEXT,
  posted_at TEXT,
  description TEXT,
  -- Placed by a recruiter on behalf of an unnamed client.
  agency INTEGER NOT NULL DEFAULT 0,
  -- JSON array of addresses at the company domain, published on its own site.
  published_emails_json TEXT NOT NULL DEFAULT '[]',

  -- The keyword search that found it, or null when a human pasted it.
  keyword TEXT,
  -- packages/domain/src/job-posts.ts JOB_POST_STATUSES.
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  last_error TEXT,
  resolved_at TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_posts_url ON job_posts(workspace_id, url);
CREATE INDEX IF NOT EXISTS idx_job_posts_status ON job_posts(workspace_id, status, created_at);

-- A person a search found behind one posting.
CREATE TABLE IF NOT EXISTS job_post_contacts (
  id TEXT PRIMARY KEY,
  job_post_id TEXT NOT NULL REFERENCES job_posts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  -- 'linkedin' today; the network the profile lives on.
  network TEXT NOT NULL,
  handle TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  -- The search result, verbatim: the evidence that they work there.
  headline TEXT,
  snippet TEXT,

  -- From `rankContact`: who they are to this posting, and how useful, 0–1.
  role TEXT NOT NULL,
  score REAL NOT NULL,

  -- An address the company published that belongs to this person.
  email TEXT,
  email_source TEXT,

  -- 1 when the company's own site names them: the company vouching, not just
  -- a search result. Two companies can share a name; their team pages cannot.
  on_company_site INTEGER NOT NULL DEFAULT 0,

  -- Set once the operator puts them in a campaign.
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,

  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_post_contacts_handle
  ON job_post_contacts(job_post_id, network, handle);
