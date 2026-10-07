-- 0064_link_posts.sql (Postgres). See migrations/0063_link_posts.sql for the reasoning.

create table if not exists link_posts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  batch_id text NOT NULL,
  offering_id text REFERENCES offerings(id) ON DELETE SET NULL,
  url text NOT NULL,
  page_title text,
  page_description text,
  page_text text,
  notes text,
  network text NOT NULL,
  title text,
  body text NOT NULL DEFAULT '',
  subreddit text,
  mastodon_instance text,
  status text NOT NULL DEFAULT 'open',
  posted_url text,
  model text,
  regenerations bigint NOT NULL DEFAULT 0,
  created_by text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  done_at text
);
create index if not exists idx_link_posts_ws on link_posts(workspace_id, status, created_at);
create index if not exists idx_link_posts_batch on link_posts(batch_id);
