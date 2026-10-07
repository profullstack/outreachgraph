-- 0056_mailbox_blacklists.sql
--
-- The deliverability check, daily, by the worker: is a mailbox's sending
-- domain (or its self-hosted SMTP server's IP) on a public blocklist?
-- One row per mailbox, the latest check. listed_on is a JSON array of list
-- names, empty when clean; results_json keeps every answer, including the
-- lists that refused to answer, so "clean" and "could not check" differ.

CREATE TABLE IF NOT EXISTS mailbox_blacklist_checks (
  account_id    TEXT PRIMARY KEY REFERENCES integration_accounts(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  listed_on     TEXT NOT NULL DEFAULT '[]',
  results_json  TEXT NOT NULL DEFAULT '[]',
  checked_at    TEXT NOT NULL
);
