-- 0023_credit_packs.sql
--
-- Prepaid prospect credits, and the CoinPay payments that buy them.
--
-- Two things this deliberately does not do.
--
-- It does not increment a balance column. `billing_accounts` has carried
-- `included_credits` and `credits_used` since 0004 and nothing has ever read
-- them, which is the good outcome: a counter incremented on every send is a
-- number that drifts the first time a job crashes mid-write, and nothing ever
-- notices because there is nothing to compare it against. The balance here is
-- `sum(delta)` over an append-only ledger, so a recount is a query and the
-- ledger doubles as the audit trail of why the balance is what it is.
--
-- It does not meter research. Grid cells stay on the plan's own allowance,
-- for the reason `plans.ts` already gives for metering them separately: one
-- click on a two-hundred-cell grid would otherwise eat the sending allowance
-- somebody actually paid for.

CREATE TABLE credit_ledger (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Which workspace spent it. Null on a grant: credits are bought by the
  -- organization and shared, the same way the plan's allowance is, so that
  -- creating a workspace cannot conjure a second balance.
  workspace_id    TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('grant', 'spend', 'refund', 'expiry')),
  unit            TEXT NOT NULL DEFAULT 'prospect',
  -- Signed: positive adds allowance, negative consumes it. Storing the sign
  -- rather than a kind-dependent magnitude means the balance is one sum with
  -- no case analysis, and a wrong sign is visible in the row rather than in
  -- the code that reads it.
  delta           INTEGER NOT NULL,
  -- What this row is about, and the half of its identity that makes it
  -- exactly-once: the CoinPay payment for a grant, the person contacted for a
  -- spend.
  payment_id      TEXT,
  person_id       TEXT,
  -- The calendar month a spend belongs to, as YYYY-MM. Null on a grant, which
  -- belongs to no month — bought credits do not expire at the month boundary.
  period          TEXT,
  reason          TEXT,
  occurred_at     TEXT NOT NULL
);

-- A webhook that arrives twice must credit once. CoinPayPortal retries on any
-- non-2xx and can deliver `payment.confirmed` more than once, so this index is
-- the actual idempotency mechanism rather than the handler being careful.
CREATE UNIQUE INDEX idx_credit_ledger_payment
  ON credit_ledger(payment_id) WHERE payment_id IS NOT NULL;

-- One credit per person per month, matching the meter above it: the monthly
-- allowance counts distinct prospects, so an overage credit has to be charged
-- the same way or a cadence's follow-ups would each cost one.
CREATE UNIQUE INDEX idx_credit_ledger_spend
  ON credit_ledger(organization_id, unit, person_id, period) WHERE kind = 'spend';

CREATE INDEX idx_credit_ledger_org ON credit_ledger(organization_id, unit);

-- A payment we started, so a customer who closes the tab mid-checkout can be
-- shown what happened, and so a webhook can be matched to an organization
-- without trusting the metadata it arrived with.
CREATE TABLE credit_purchases (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    TEXT,
  user_id         TEXT,
  pack_id         TEXT NOT NULL,
  credits         INTEGER NOT NULL,
  amount_usd      REAL NOT NULL,
  blockchain      TEXT NOT NULL,
  -- CoinPayPortal's own payment id. Unique because it is the join key the
  -- webhook arrives with.
  payment_id      TEXT NOT NULL UNIQUE,
  payment_url     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_credit_purchases_org ON credit_purchases(organization_id, created_at DESC);
