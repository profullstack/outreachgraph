-- 0084_content_radar: Discover, hooks, follows, saved references and Studio assets
-- (the Content Radar). One radar per product: the terms, subreddits and tags it
-- reads, and whether it drafts on its own. References are public posts ranked by
-- their own engagement, each with the hook the model (or the wording) saw in it.

CREATE TABLE IF NOT EXISTS content_radars (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  offering_id     TEXT NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  terms           TEXT NOT NULL DEFAULT '[]',
  subreddits      TEXT NOT NULL DEFAULT '[]',
  tags            TEXT NOT NULL DEFAULT '[]',
  sources         TEXT NOT NULL DEFAULT '["hackernews","bluesky","devto","mastodon","reddit"]',
  enabled         BIGINT NOT NULL DEFAULT 1,
  auto_draft      BIGINT NOT NULL DEFAULT 1,
  networks        TEXT NOT NULL DEFAULT '["linkedin","bluesky","mastodon","x","reddit"]',
  last_scan_at    TEXT,
  last_draft_at   TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, offering_id)
);

CREATE TABLE IF NOT EXISTS content_follows (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  offering_id     TEXT REFERENCES offerings(id) ON DELETE CASCADE,
  network         TEXT NOT NULL,
  handle          TEXT NOT NULL,
  label           TEXT,
  kind            TEXT NOT NULL DEFAULT 'competitor',
  last_read_at    TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_follows_unique
  ON content_follows(workspace_id, network, handle);

CREATE TABLE IF NOT EXISTS content_references (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  offering_id     TEXT REFERENCES offerings(id) ON DELETE SET NULL,
  source          TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  url             TEXT NOT NULL,
  author_handle   TEXT,
  author_name     TEXT,
  title           TEXT,
  text            TEXT NOT NULL,
  container       TEXT,
  posted_at       TEXT NOT NULL,
  likes           BIGINT NOT NULL DEFAULT 0,
  reposts         BIGINT NOT NULL DEFAULT 0,
  comments        BIGINT NOT NULL DEFAULT 0,
  engagement      BIGINT NOT NULL DEFAULT 0,
  origin          TEXT NOT NULL DEFAULT 'keyword',
  matched         TEXT,
  hook_type       TEXT,
  hook_why        TEXT,
  hook_angle      TEXT,
  hook_judged     BIGINT NOT NULL DEFAULT 0,
  relevant        BIGINT,
  status          TEXT NOT NULL DEFAULT 'new',
  collection      TEXT,
  used_batch_id   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_references_unique
  ON content_references(workspace_id, source, external_id);
CREATE INDEX IF NOT EXISTS idx_content_references_feed
  ON content_references(workspace_id, offering_id, status, engagement);

CREATE TABLE IF NOT EXISTS content_assets (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  offering_id     TEXT REFERENCES offerings(id) ON DELETE SET NULL,
  reference_id    TEXT REFERENCES content_references(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  link_batch_id   TEXT,
  model           TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_assets_ws
  ON content_assets(workspace_id, created_at);
