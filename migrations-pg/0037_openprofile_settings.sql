-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

create table openprofile_settings (
  person_id text PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  public bigint NOT NULL DEFAULT 0,
  handle text,
  overrides_json text NOT NULL DEFAULT '{}',
  owner_user_id text,
  claimed_at text,
  claim_method text,
  published_at text,
  updated_at text NOT NULL
);

CREATE INDEX idx_openprofile_settings_public ON openprofile_settings(public, updated_at);

CREATE UNIQUE INDEX idx_openprofile_settings_handle
  ON openprofile_settings(handle) WHERE handle IS NOT NULL;
