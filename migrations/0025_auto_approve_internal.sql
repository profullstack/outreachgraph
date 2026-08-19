-- 0025_auto_approve_internal.sql
--
-- Stop asking a human to approve work that reaches nobody.
--
-- The approval queue exists so that a person decides before a prospect is
-- contacted. `refresh_research`, `observe` and `wait` contact nobody: they
-- re-read a company's own website, record something already observed, or do
-- nothing at all. The policy engine has always known this — `isInternalAction`
-- exempts them from every rate limit and from the budget — and the queue asked
-- for a click anyway.
--
-- The cost of that was not theoretical. Production held 179 `refresh_research`
-- cards against 25 that a person could actually act on, so the queue was 75%
-- filler and the real decisions were buried in it. A review surface that has
-- to be waded through is one that stops being read, which is the failure this
-- product cannot afford.
--
-- Defaults to on. The alternative — shipping it off and waiting to be asked —
-- means every existing workspace keeps the behaviour that was already wrong.
-- It is a column rather than a constant because a workspace that wants to
-- watch its own research pass by should be able to, and because turning it off
-- is how somebody debugs it.

ALTER TABLE workspaces ADD COLUMN auto_approve_internal INTEGER NOT NULL DEFAULT 1;

-- The principal an unattended approval is credited to.
--
-- `approvals.decided_by` is `NOT NULL REFERENCES users(id)`, so an automated
-- decision needs a real row or the insert fails. The alternative — crediting
-- the workspace owner — would put a person's name against decisions they never
-- made, which is worse than useless in an audit trail: it is misleading in the
-- exact place someone would go to establish who decided what.
--
-- The address is at `.invalid`, reserved by RFC 2606 and unroutable by
-- construction, so this account can never receive mail and can never be
-- mistaken for a person. It belongs to no organization, so it appears in no
-- member list and no seat count.
INSERT INTO users (id, email, name, status, created_at, updated_at)
SELECT 'usr_auto_approve', 'automation@outreachgraph.invalid',
       'OutreachGraph automation', 'active', datetime('now'), datetime('now')
 WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 'usr_auto_approve');
