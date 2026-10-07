-- 0056_mailbox_blacklists.sql (Postgres). See migrations/0056_mailbox_blacklists.sql for the reasoning.
-- One new, empty table. Nothing existing is altered.

create table if not exists mailbox_blacklist_checks (
  account_id text PRIMARY KEY REFERENCES integration_accounts(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listed_on text NOT NULL DEFAULT '[]',
  results_json text NOT NULL DEFAULT '[]',
  checked_at text NOT NULL
);
