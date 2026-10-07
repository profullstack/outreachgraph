-- 0059_community_leads.sql: buyer leads from public communities.
--
-- A monitor watches public communities (Reddit via the Arctic Shift archive,
-- Hacker News via Algolia, Bluesky) for one brand's keywords. Every matching
-- post is scored for buyer intent, and the ones above the monitor's floor are
-- leads: a quoted excerpt, a link, a reason, and a reply a human may draft and
-- post themselves. Nothing here ever posts to a community.

CREATE TABLE IF NOT EXISTS lead_monitors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The product this monitor is for, when it is one of the workspace's products.
  offering_id TEXT REFERENCES offerings(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  url TEXT,
  description TEXT,
  -- JSON arrays.
  keywords_json TEXT NOT NULL DEFAULT '[]',
  subreddits_json TEXT NOT NULL DEFAULT '[]',
  -- Words that drop a post outright (the brand's own name, a namesake).
  exclude_json TEXT NOT NULL DEFAULT '[]',
  sources_json TEXT NOT NULL DEFAULT '["reddit","hackernews","bluesky"]',
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Minutes between scheduled scans. Polling is throttled to at most hourly.
  every_minutes INTEGER NOT NULL DEFAULT 360,
  -- Intent (0-100) a post needs to count as a lead and reach the digest.
  min_intent INTEGER NOT NULL DEFAULT 60,
  -- 1: include this monitor's new leads in the daily lead digest email.
  digest INTEGER NOT NULL DEFAULT 1,
  last_scanned_at TEXT,
  last_error TEXT,
  last_result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_monitors_ws ON lead_monitors(workspace_id);

-- Every post a monitor matched, lead or not, so nothing is scored twice.
CREATE TABLE IF NOT EXISTS community_leads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES lead_monitors(id) ON DELETE CASCADE,
  -- 'reddit' | 'hackernews' | 'bluesky'
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  excerpt TEXT NOT NULL,
  author TEXT NOT NULL,
  author_url TEXT,
  -- Subreddit, "HN comment", ...
  container TEXT,
  posted_at TEXT NOT NULL,
  matched_term TEXT,
  intent INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  -- 1 when the model scored it; 0 when the wording classifier did.
  judged INTEGER NOT NULL DEFAULT 0,
  -- 'new' | 'replied' | 'dismissed'
  status TEXT NOT NULL DEFAULT 'new',
  reply_draft TEXT,
  reply_drafted_at TEXT,
  digested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_leads_post
  ON community_leads(monitor_id, source, external_id);
CREATE INDEX IF NOT EXISTS idx_community_leads_ws
  ON community_leads(workspace_id, status, intent, posted_at);
