-- 0047_mailbox_reply_check.sql (Postgres). See migrations/0047_mailbox_reply_check.sql for the reasoning.

ALTER TABLE integration_accounts ADD COLUMN IF NOT EXISTS replies_checked_at text;
ALTER TABLE integration_accounts ADD COLUMN IF NOT EXISTS replies_error text;
