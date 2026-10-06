-- 0047_mailbox_reply_check.sql
-- When each mailbox's inbox was last read, and why it could not be.
--
-- The reply poller logged an IMAP failure to the container and moved on, so a
-- mailbox whose inbox would not open looked exactly like one nobody answered.
-- That is how a workspace sent ~280 emails over two weeks and never saw a
-- reply. The Mailboxes page shows these two columns beside each address.
--
-- Columns rather than `sender_events` rows: the poll runs every five minutes
-- per mailbox, and only the latest outcome means anything.

ALTER TABLE integration_accounts ADD COLUMN replies_checked_at TEXT;
ALTER TABLE integration_accounts ADD COLUMN replies_error TEXT;
