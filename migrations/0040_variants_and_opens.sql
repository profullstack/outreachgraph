-- A/B angles on cadence steps, the step's guidance reaching the composer, and
-- opt-in open tracking.

-- ------------------------------------------------------------ step variants
--
-- Alternates to a step's `intent`, as a JSON array of strings. The step's own
-- `intent` is variant A and these are B, C and D. What varies is the *angle*
-- the composer is asked to take, never a template: each message is still
-- written per prospect and grounded in that prospect's evidence, so an A/B
-- test here compares two reasons for writing rather than two strings.
ALTER TABLE cadence_steps ADD COLUMN variants_json TEXT;

-- What the composer is asked to do with this card, and which variant asked.
--
-- Until now a cadence step's intent was written into `reason` and read by the
-- reviewer only — the composer never saw it, so "reference their talk" and
-- "ask for an intro" produced the same draft. `guidance` is the composer's
-- copy; `reason` stays the human-readable label it always was.
ALTER TABLE recommendations ADD COLUMN guidance TEXT;
ALTER TABLE recommendations ADD COLUMN variant TEXT;

-- The variant a step run used, so a report can group outcomes by it without
-- joining through a recommendation that may since have been deleted.
ALTER TABLE cadence_step_runs ADD COLUMN variant TEXT;

-- ------------------------------------------------------------------ opens
--
-- Off by default, for the same reason link tracking is: outreach here is
-- plain text, and a pixel needs an HTML part the approved message never had.
-- A workspace that switches this on sends a multipart message whose HTML half
-- is the plain text, escaped and paragraphed, plus one image.
ALTER TABLE workspace_settings ADD COLUMN track_opens INTEGER NOT NULL DEFAULT 0;

-- One pixel per message. The id is the token in the image URL, so it is
-- public by construction and unguessable for the same reason a tracked link's
-- is.
CREATE TABLE open_pixels (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id      TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  campaign_id    TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  action_id      TEXT REFERENCES actions(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_open_pixels_action ON open_pixels(action_id);
CREATE INDEX idx_open_pixels_ws ON open_pixels(workspace_id, created_at DESC);

-- Every fetch of a pixel, believed or not. `automated` is 'bot' or 'prefetch'
-- when the fetch was not counted as a person. Apple Mail Privacy Protection
-- fetches every image on delivery from a proxy that looks like a person, so
-- even a believed open is weak evidence — which is why opens are reported and
-- never fed into scoring or used as a cadence condition.
CREATE TABLE email_opens (
  id             TEXT PRIMARY KEY,
  pixel_id       TEXT NOT NULL REFERENCES open_pixels(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id      TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  automated      TEXT,
  user_agent     TEXT,
  occurred_at    TEXT NOT NULL
);

CREATE INDEX idx_email_opens_pixel ON email_opens(pixel_id);
CREATE INDEX idx_email_opens_ws ON email_opens(workspace_id, occurred_at DESC);
