-- 0013_inbound_dedupe.sql
-- Give an interaction the sender's own id for the message, so polling a
-- mailbox twice does not record the same reply twice.
--
-- Reading replies means asking the mailbox "what arrived since X" on a timer,
-- and that window necessarily overlaps: clocks differ, IMAP `SINCE` has
-- day granularity on some servers, and a poll that failed halfway must be
-- safe to repeat. Without a stable key from the message itself, every one of
-- those turns into a duplicate row — and duplicates here are not cosmetic,
-- because `conversation_open` counts them.
--
-- `Message-ID` is that key. It is assigned by the sending server, required by
-- RFC 5322, and stable across refetches. A message without one is still
-- recorded; it simply cannot be deduplicated, which is the honest trade.
--
-- The unique index is partial so it constrains only rows that have a value.
-- Every outbound row written before this migration has NULL here, and SQLite
-- treats NULLs as distinct, but being explicit costs nothing and says what is
-- meant.

ALTER TABLE interactions ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX idx_interactions_external_id
  ON interactions(workspace_id, external_id)
  WHERE external_id IS NOT NULL;
