-- 0047_ideas.sql: the Idea Generator.
--
-- People on Reddit ask for tools: "is there an app that tracks X and warns me",
-- "I wish someone made Y". One ask is an anecdote; five different people asking
-- for the same thing inside a couple of months is a product. This stores the
-- asks a workspace's scans found, groups them into ideas, and remembers what
-- was handed to chovy.com to build.
--
-- Reddit itself blocks servers, so posts are read from RSS Amplifier's mirror
-- and the Arctic Shift archive (see @outreachgraph/ideas).

-- One row per workspace: which subreddits to read and when it last did.
CREATE TABLE IF NOT EXISTS idea_scans (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  -- JSON array of subreddit names.
  subs_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Minutes between scheduled scans.
  every_minutes INTEGER NOT NULL DEFAULT 360,
  -- Distinct people asking before an idea is flagged 'build'.
  build_at INTEGER NOT NULL DEFAULT 5,
  -- Asks older than this are not counted.
  window_days INTEGER NOT NULL DEFAULT 60,
  last_scanned_at TEXT,
  last_error TEXT,
  -- JSON summary of the last scan: posts read, asks found, rejected, sources.
  last_result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  -- 1 when the judge named it, so a differently named ask is not merged in.
  named INTEGER NOT NULL DEFAULT 0,
  -- JSON array of the words its asks share, most shared first.
  terms_json TEXT NOT NULL DEFAULT '[]',
  -- 'watching' | 'build' | 'building' | 'dismissed'.
  status TEXT NOT NULL DEFAULT 'watching',
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  flagged_at TEXT,
  -- The chovy.com hand-off, once someone pressed Build it.
  handoff_url TEXT,
  handoff_at TEXT,
  handoff_by TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ideas_workspace ON ideas(workspace_id, status, last_at);

-- One Reddit post that asked for something, filed under an idea.
CREATE TABLE IF NOT EXISTS idea_asks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  -- The Reddit post id (t3_ stripped).
  post_id TEXT NOT NULL,
  sub TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT NOT NULL,
  author TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  -- How sure the patterns were (0-1), and which pattern.
  confidence REAL NOT NULL,
  kind TEXT NOT NULL,
  -- JSON array: what they want it to do, in their words.
  wants_json TEXT NOT NULL DEFAULT '[]',
  label TEXT,
  judged INTEGER NOT NULL DEFAULT 0,
  post_score INTEGER,
  comments INTEGER,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_idea_asks_post ON idea_asks(workspace_id, post_id);
CREATE INDEX IF NOT EXISTS idx_idea_asks_idea ON idea_asks(idea_id);

-- Every post a scan has read, ask or not, so nothing is judged twice.
CREATE TABLE IF NOT EXISTS idea_seen (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, post_id)
);
