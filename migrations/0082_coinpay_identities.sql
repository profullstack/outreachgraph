-- Sign in with CoinPay. A CoinPay identity (its OIDC `sub`) is bound to one
-- account and that binding is the only thing a CoinPay sign-in trusts. CoinPay
-- never verifies email addresses, so `email` here is contact information and is
-- never matched against users.email. A first CoinPay sign-in provisions an
-- account whose users.email is <sub>@coinpay.outreachgraph.invalid and which
-- has no password; an existing account gets CoinPay only by connecting it from
-- a signed-in session.
CREATE TABLE IF NOT EXISTS coinpay_identities (
  sub           TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email         TEXT,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- The authorize request's state, PKCE verifier and nonce, kept server side for
-- ten minutes and deleted as the callback reads them (single use).
CREATE TABLE IF NOT EXISTS coinpay_oauth_pending (
  id          TEXT PRIMARY KEY,
  state       TEXT NOT NULL,
  verifier    TEXT NOT NULL,
  nonce       TEXT NOT NULL,
  mode        TEXT NOT NULL,
  user_id     TEXT,
  next        TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
