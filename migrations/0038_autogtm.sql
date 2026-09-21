-- 0038_autogtm.sql
--
-- The AutoGTM surface: a public API shaped like the one agents already know
-- how to drive, backed by the campaigns, policy engine and credits that were
-- already here.
--
-- Four additions, each the smallest thing that makes one part of that surface
-- honest rather than pretend:
--
--   - `api_keys`: a credential that belongs to a workspace, so a customer can
--     hand an agent a key without handing it the process-wide service token
--     and two scope headers. Stored hashed, shown once, revocable.
--   - Project budget and autopilot on `offerings`: a "project" is a product,
--     and Explee-style control is a daily dollar ceiling per project that the
--     allocator splits across its campaigns. `NULL` means no ceiling, which is
--     what every existing product has and must keep.
--   - `campaign_people.note`: the one place a human or an agent leaves a
--     sentence about a lead in the context of one campaign.
--   - Named suppress lists: `suppression_entries` grows a name and a kind, so
--     "the competitors list" is one row whose keys can be read back and
--     deleted together. The match-key vocabulary grows two spellings,
--     `email:<address>` and `domain:<host>`, which the suppression checks now
--     read alongside `person:` and `platform:`.

CREATE TABLE api_keys (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Whose authority the key carries. Role is read from their membership at
  -- request time, so removing someone from the organization kills their keys.
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  -- SHA-256 of the secret. The secret itself is returned once and never stored.
  key_hash         TEXT NOT NULL UNIQUE,
  -- The first characters of the secret, so a list can say which key is which.
  key_prefix       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  last_used_at     TEXT,
  revoked_at       TEXT
);

CREATE INDEX idx_api_keys_ws ON api_keys(workspace_id, created_at DESC);

ALTER TABLE offerings ADD COLUMN daily_budget_usd REAL;
ALTER TABLE offerings ADD COLUMN autopilot INTEGER NOT NULL DEFAULT 0;

ALTER TABLE campaign_people ADD COLUMN note TEXT;

ALTER TABLE suppression_entries ADD COLUMN name TEXT;
-- person | company. Null for entries written before lists existed.
ALTER TABLE suppression_entries ADD COLUMN kind TEXT;

CREATE INDEX idx_suppression_entries_list
  ON suppression_entries(workspace_id, kind, name);
