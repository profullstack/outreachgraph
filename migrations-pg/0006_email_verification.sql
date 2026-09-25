-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table users add column if not exists email_verified_at text;

UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

create table email_verification_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  email text NOT NULL,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  consumed_at text
);

CREATE INDEX idx_email_verification_user ON email_verification_tokens(user_id);
