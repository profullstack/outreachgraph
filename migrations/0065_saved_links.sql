-- 0065_saved_links.sql: the links a workspace has drafted posts from.
--
-- "Draft a post from a link" forgot every URL once its cards were done. Each
-- link drafted from is kept here and offered back under the URL box, newest
-- first, with an x to drop it. Existing drafts seed the list.
CREATE TABLE IF NOT EXISTS saved_links (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, url)
);

INSERT INTO saved_links (workspace_id, url, title, last_used_at)
SELECT workspace_id, url, MAX(page_title), MAX(created_at)
  FROM link_posts GROUP BY workspace_id, url
ON CONFLICT DO NOTHING;
