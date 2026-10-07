-- 0064_link_posts.sql: posts about a link, one per network, posted by a person.
--
-- "Draft a post from a link" on the Hand-offs tab: the API reads a page, the
-- model writes a post for each network asked for, and each one becomes a
-- hand-off card (copy, open the composer, steps, mark done). Nothing here is
-- ever posted by the product. The page is kept on the row so Regenerate can
-- rewrite one network's post without fetching the page again.

CREATE TABLE IF NOT EXISTS link_posts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Every network drafted in one request shares a batch, so cards group.
  batch_id TEXT NOT NULL,
  -- The product whose voice wrote it, when the workspace has one.
  offering_id TEXT REFERENCES offerings(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  page_title TEXT,
  page_description TEXT,
  page_text TEXT,
  notes TEXT,
  -- 'linkedin' | 'x' | 'reddit' | 'hackernews' | 'facebook' | 'bluesky' | 'mastodon' | 'threads'
  network TEXT NOT NULL,
  -- Reddit and HN: the title is the post, body is the first comment.
  title TEXT,
  body TEXT NOT NULL DEFAULT '',
  subreddit TEXT,
  mastodon_instance TEXT,
  -- 'open' | 'done' | 'skipped'
  status TEXT NOT NULL DEFAULT 'open',
  -- Where it was posted, when the person said.
  posted_url TEXT,
  model TEXT,
  regenerations INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_link_posts_ws ON link_posts(workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_link_posts_batch ON link_posts(batch_id);
