-- 0065_saved_links.sql (Postgres). See migrations/0065_saved_links.sql for the reasoning.
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
