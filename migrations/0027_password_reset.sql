-- Password reset (PRD §34 account security).
--
-- Without this, a forgotten password is an account lost: there is no other
-- credential on the user row and no admin path back in. The reset link is the
-- one place where possession of the mailbox stands in for knowing the secret,
-- so the token is treated with the same care as a session.

-- Digest-at-rest, for the same reason sessions and verification tokens are:
-- a leaked database must not hand over a working reset link.
CREATE TABLE password_reset_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  -- The address the token was minted for. A token issued before an email
  -- change must not reset the password of the new address's owner.
  email       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id);
