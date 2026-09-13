-- 0037_openprofile_settings.sql
--
-- What the person, or the operator on their behalf, decided about the
-- OpenProfile.md OutreachGraph assembled for them.
--
-- `openprofiles` holds the generated document and is rewritten by every run
-- of the openprofile job. This table holds what a run must never touch: the
-- owner's corrections (`overrides_json`, the overlay @profullstack/openprofile
-- applies over the generated file), whether the profile is public at all
-- (`public`, off until somebody switches it on), the handle they chose, and
-- who claimed it and how. A public profile is what /api/v1/openprofiles lists
-- for directories such as nichedb.dev; a private one is served only to the
-- workspace that holds the person, exactly as before.
--
-- Keyed by person like `openprofiles`, and dropped with the person, because a
-- deleted person leaves a suppression tombstone and nothing else.

CREATE TABLE openprofile_settings (
  person_id      TEXT PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  public         INTEGER NOT NULL DEFAULT 0,
  handle         TEXT,
  overrides_json TEXT NOT NULL DEFAULT '{}',
  owner_user_id  TEXT,
  claimed_at     TEXT,
  -- email | profile | operator
  claim_method   TEXT,
  published_at   TEXT,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_openprofile_settings_public ON openprofile_settings(public, updated_at);
CREATE UNIQUE INDEX idx_openprofile_settings_handle
  ON openprofile_settings(handle) WHERE handle IS NOT NULL;
