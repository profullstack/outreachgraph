-- 0048_warmup_network.sql
-- The warm-up network: mailboxes that opted in send each other short, real
-- conversations, and each recipient rescues them from spam, reads them,
-- answers some, and files them out of the inbox.
--
-- The existing `warmup_enabled` ramp only limits how much outreach a new
-- mailbox may send. It never sent anything, so a mailbox's reputation was
-- built by cold email alone. This is the half that builds it with mail that
-- gets opened and answered.

-- Whether this mailbox sends and receives warm-up mail.
ALTER TABLE integration_accounts ADD COLUMN warmup_network INTEGER NOT NULL DEFAULT 0;

-- A word written into every warm-up message this mailbox RECEIVES, so its
-- owner can filter them out of a forwarded copy (Gmail) with one rule. Per
-- mailbox rather than global, so filters cannot learn one shared fingerprint.
ALTER TABLE integration_accounts ADD COLUMN warmup_tag TEXT;

-- When the mailbox joined the network; the daily warm-up volume ramps from it.
ALTER TABLE integration_accounts ADD COLUMN warmup_network_started_at TEXT;

-- One row per warm-up message, sent or replied. `landed` is what the
-- recipient found: 'inbox' or 'spam', which is the placement rate shown on the
-- Mailboxes page.
CREATE TABLE warmup_messages (
  id                    TEXT PRIMARY KEY,
  sender_account_id     TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
  recipient_account_id  TEXT NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
  token                 TEXT NOT NULL,
  thread_token          TEXT NOT NULL,
  depth                 INTEGER NOT NULL DEFAULT 0,
  message_id            TEXT,
  subject               TEXT NOT NULL,
  sent_at               TEXT NOT NULL,
  seen_at               TEXT,
  landed                TEXT,
  replied_at            TEXT
);

CREATE UNIQUE INDEX idx_warmup_messages_token ON warmup_messages(token);
CREATE INDEX idx_warmup_messages_sender ON warmup_messages(sender_account_id, sent_at);
CREATE INDEX idx_warmup_messages_recipient ON warmup_messages(recipient_account_id, sent_at);
