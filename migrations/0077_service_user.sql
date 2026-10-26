-- 0077_service_user.sql
--
-- A users row for the service token's principal.
--
-- A service-token request with no `x-user-id` acts as `usr_service`, and every
-- decision it records names that id: `approvals.decided_by` is
-- `NOT NULL REFERENCES users(id)`. No such row existed, so approving, skipping
-- or snoozing with the service token failed the foreign key and came back as a
-- 500. The workaround was to send a real person's id, which credits them with
-- decisions they never made.
--
-- Same shape as `usr_auto_approve` (0025): an unroutable `.invalid` address and
-- no organization, so it is in no member list and no seat count.
INSERT INTO users (id, email, name, status, created_at, updated_at)
SELECT 'usr_service', 'service@outreachgraph.invalid',
       'OutreachGraph service token', 'active', datetime('now'), datetime('now')
 WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 'usr_service');
