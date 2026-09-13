-- 0035_openprofiles.sql
--
-- One OpenProfile.md per person, generated from what their public profiles
-- say about them.
--
-- OpenProfile (logicsrc.com/openprofile) is one Markdown file that ties a
-- name to its accounts, its topics and its home page. A person who publishes
-- their own is the authority; for everyone else this table holds the version
-- OutreachGraph assembled from the profile page it was handed, the network's
-- public API, and the OpenGraph tags and rel=me links on the site that profile
-- points at.
--
-- Keyed by person rather than by an id of its own because there is exactly one
-- current profile per person: a later run replaces it. `sources_json` records
-- every URL that contributed, so a reader can tell a claim from a corroborated
-- fact, and `published_url` is set only when the person serves an
-- OpenProfile.md themselves, in which case that file is what the markdown holds.

CREATE TABLE openprofiles (
  person_id     TEXT PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  markdown      TEXT NOT NULL,
  sources_json  TEXT NOT NULL DEFAULT '[]',
  published_url TEXT,
  generated_at  TEXT NOT NULL
);
