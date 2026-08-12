-- Email verification (PRD §34 account security).
--
-- An unverified address is not just a typo risk: it is how someone signs up
-- as a person who never consented, and how a bounced address quietly costs
-- sender reputation. Outbound actions are gated on it, so verification is a
-- product control rather than a formality.

ALTER TABLE users ADD COLUMN email_verified_at TEXT;

-- Accounts that existed before verification shipped are grandfathered. They
-- were created by a human who was already using the product, and locking
-- them out of their own workspace to prove an address they already receive
-- mail at would be a regression, not a security gain.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- Tokens are stored as a SHA-256 digest for the same reason sessions are: a
-- leaked database must not hand over a working verification link.
CREATE TABLE email_verification_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  -- The address the token was minted for. Kept so a token issued before an
  -- email change cannot verify the new address.
  email       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX idx_email_verification_user ON email_verification_tokens(user_id);
