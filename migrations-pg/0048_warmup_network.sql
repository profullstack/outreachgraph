-- 0048_warmup_network.sql (Postgres). See migrations/0048_warmup_network.sql for the reasoning.

ALTER TABLE integration_accounts ADD COLUMN IF NOT EXISTS warmup_network integer NOT NULL DEFAULT 0;
ALTER TABLE integration_accounts ADD COLUMN IF NOT EXISTS warmup_tag text;
ALTER TABLE integration_accounts ADD COLUMN IF NOT EXISTS warmup_network_started_at text;

create table if not exists warmup_messages (
  id text PRIMARY KEY,
  sender_account_id text NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
  recipient_account_id text NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  token text NOT NULL,
  thread_token text NOT NULL,
  depth integer NOT NULL DEFAULT 0,
  message_id text,
  subject text NOT NULL,
  sent_at text NOT NULL,
  seen_at text,
  landed text,
  replied_at text
);

create unique index if not exists idx_warmup_messages_token ON warmup_messages(token);
create index if not exists idx_warmup_messages_sender ON warmup_messages(sender_account_id, sent_at);
create index if not exists idx_warmup_messages_recipient ON warmup_messages(recipient_account_id, sent_at);
