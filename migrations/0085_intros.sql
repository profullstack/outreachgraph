-- 0085_intros: introductions between two account holders who both asked (PRD §38).
--
-- `intro_cards` is what one person chose to show other members: a name, a line
-- about themselves, who they want to meet and what they can offer. It is keyed
-- by its own id rather than the user's so a match never carries a user id, and
-- `is_open` is off until the person switches it on. Nothing in a card is copied
-- from a prospect record, a provider or a signal: the person typed all of it.
--
-- `intro_requests` is one member asking to be introduced to another. The asker
-- consents by asking; the other side consents by accepting, and only an
-- accepted row lets either read the other's address. A pending row past
-- `expires_at` reads as expired without a sweep, and is written as `expired`
-- the next time the pair is looked at.
--
-- `intro_blocks` is what a decline leaves behind: the pair may not be asked
-- again, in either direction. It is its own table rather than a status scan so
-- the rule survives the request rows being cleaned up.
--
-- All three drop with the user. A deleted account leaves no card in the pool
-- and no request anybody could still accept.

CREATE TABLE IF NOT EXISTS intro_cards (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  is_open       INTEGER NOT NULL DEFAULT 0,
  display_name  TEXT NOT NULL DEFAULT '',
  headline      TEXT NOT NULL DEFAULT '',
  looking_for   TEXT NOT NULL DEFAULT '',
  can_offer     TEXT NOT NULL DEFAULT '',
  topics        TEXT NOT NULL DEFAULT '[]',
  opened_at     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intro_cards_open ON intro_cards(is_open, updated_at);

CREATE TABLE IF NOT EXISTS intro_requests (
  id                 TEXT PRIMARY KEY,
  requester_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note               TEXT NOT NULL,
  -- pending | accepted | declined | withdrawn | expired
  status             TEXT NOT NULL DEFAULT 'pending',
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  decided_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_intro_requests_requester
  ON intro_requests(requester_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_intro_requests_target
  ON intro_requests(target_user_id, status, created_at);
-- One live ask per direction. The check in the app reads first and writes
-- second, so two requests racing would otherwise both land.
CREATE UNIQUE INDEX IF NOT EXISTS idx_intro_requests_one_pending
  ON intro_requests(requester_user_id, target_user_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS intro_blocks (
  blocker_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);
CREATE INDEX IF NOT EXISTS idx_intro_blocks_blocked ON intro_blocks(blocked_user_id);
