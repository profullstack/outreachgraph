-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table credit_ledger (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text,
  kind text NOT NULL CHECK (kind IN ('grant', 'spend', 'refund', 'expiry')),
  unit text NOT NULL DEFAULT 'prospect',
  delta bigint NOT NULL,
  payment_id text,
  person_id text,
  period text,
  reason text,
  occurred_at text NOT NULL
);

CREATE UNIQUE INDEX idx_credit_ledger_payment
  ON credit_ledger(payment_id) WHERE payment_id IS NOT NULL;

CREATE UNIQUE INDEX idx_credit_ledger_spend
  ON credit_ledger(organization_id, unit, person_id, period) WHERE kind = 'spend';

CREATE INDEX idx_credit_ledger_org ON credit_ledger(organization_id, unit);

create table credit_purchases (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text,
  user_id text,
  pack_id text NOT NULL,
  credits bigint NOT NULL,
  amount_usd double precision NOT NULL,
  blockchain text NOT NULL,
  payment_id text NOT NULL UNIQUE,
  payment_url text,
  status text NOT NULL DEFAULT 'pending',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX idx_credit_purchases_org ON credit_purchases(organization_id, created_at DESC);
