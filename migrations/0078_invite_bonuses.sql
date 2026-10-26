-- 0078_invite_bonuses.sql
--
-- One row per accepted invite: whether the bonus was paid, and if not, why.
--
-- Credit codes and invites come from two house packages
-- (@profullstack/redeem-credits, @profullstack/affiliates), which keep their
-- own tables under the `redeem_` and `aff_` prefixes and create them on first
-- use. The credit itself is never kept there: a redeemed code or a paid invite
-- is a `grant` row in `credit_ledger`, the same ledger CoinPay purchases write,
-- keyed by `payment_id` so a retry cannot pay twice.
--
-- This table is the claim that makes the bonus exactly-once: the row is
-- inserted before either grant, and the invitee is its primary key, so a second
-- verification of the same account finds it and pays nothing.
CREATE TABLE IF NOT EXISTS invite_bonuses (
  invitee_user_id TEXT PRIMARY KEY,
  inviter_user_id TEXT NOT NULL,
  invite_id       TEXT NOT NULL,
  -- granted | disabled | disposable_domain | same_mailbox | inviter_too_new
  -- | inviter_cap | no_organization
  status          TEXT NOT NULL,
  prospects       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_bonuses_inviter
  ON invite_bonuses(inviter_user_id, created_at);
