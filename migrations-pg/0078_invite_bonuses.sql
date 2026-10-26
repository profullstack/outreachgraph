-- 0078_invite_bonuses.sql (Postgres). See migrations/0078_invite_bonuses.sql for the reasoning.
CREATE TABLE IF NOT EXISTS invite_bonuses (
  invitee_user_id text PRIMARY KEY,
  inviter_user_id text NOT NULL,
  invite_id       text NOT NULL,
  status          text NOT NULL,
  prospects       bigint NOT NULL DEFAULT 0,
  created_at      text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_bonuses_inviter
  ON invite_bonuses(inviter_user_id, created_at);
