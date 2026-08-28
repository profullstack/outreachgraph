-- 0029_invitations.sql
-- Letting a second person into an organization.
--
-- `organization_members` has existed since 0000 and nothing in the product
-- could write a second row to it. An organization was therefore always exactly
-- one person, and the only way to add a colleague was an INSERT by hand
-- against production — which is not a feature, it is an outage waiting for the
-- wrong id.
--
-- Three decisions worth keeping written down:
--
--   * **The invitation is to the organization, not the workspace.** Billing is
--     already keyed on the organization, workspaces hang off it, and a role
--     that grants access to one workspace but not its siblings would have to be
--     enforced in every one of the ~90 routes that scope by workspace_id. When
--     per-workspace access is genuinely wanted it belongs in its own table
--     rather than in a second meaning for this one.
--
--   * **Only the hash of the token is stored.** Same rule as sessions,
--     password resets and email verification: a database copy must not confer
--     the ability to join anybody's organization.
--
--   * **Accepting is recorded rather than deleted.** "Who let this person in,
--     and when" is an audit question that gets asked exactly once, after
--     something has already gone wrong, and a row that is deleted on acceptance
--     cannot answer it.

CREATE TABLE invitations (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Stored lowercased and trimmed by the API, so the uniqueness index below
  -- actually means "one pending invitation per person".
  email            TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'member',
  token_hash       TEXT NOT NULL UNIQUE,
  invited_by       TEXT NOT NULL REFERENCES users(id),
  expires_at       TEXT NOT NULL,
  accepted_at      TEXT,
  accepted_by      TEXT REFERENCES users(id),
  revoked_at       TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX idx_invitations_org ON invitations(organization_id, created_at);

-- Re-inviting somebody who has not answered yet must replace their invitation
-- rather than mint a second live token. Partial index, so a revoked or
-- accepted invitation never blocks a fresh one to the same address.
CREATE UNIQUE INDEX idx_invitations_pending
  ON invitations(organization_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
