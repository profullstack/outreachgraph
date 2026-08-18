-- 0012_engagement.sql
-- Noticing that somebody engaged, so the scoring engine stops guessing.
--
-- `packages/scoring` has implemented `scoreRelationship` since the first
-- migration and it has never once received an input: `jobs.ts` passes a
-- literal `relationship: 0` into every opportunity score, because nothing in
-- the product could answer "have we heard from this person before". The reply
-- reader (migration 0000 + `receive-email.ts`) fixed half of that for the
-- policy engine, but its output never reached the score, so a prospect who
-- replied last week and one who has never heard of us rank identically.
--
-- Two tables here, and the split between them is the point.
--
-- `tracked_links` is what we send. `link_clicks` is every hit that comes back,
-- honestly, including the ones we do not believe. Corporate mail scanners and
-- link-preview bots fetch every URL in an inbound message, often within
-- seconds of delivery, so a table that recorded "clicks" as a single number
-- would report engagement that no human ever performed. Keeping the raw hits
-- lets a suspected-automated fetch be stored as the fact it is and excluded
-- from the fact it is not.
--
-- Nothing here tracks opens. A tracking pixel in 2026 measures Apple Mail
-- Privacy Protection and the Gmail image proxy, not people, and a number that
-- is wrong in a direction nobody can correct is worse than an absent one.

-- --------------------------------------------------------------- what we sent
--
-- One row per link per message. The id is the token that appears in the URL,
-- so a redirect is a primary key lookup and nothing has to be parsed out of a
-- path segment.
--
-- `target_url` is stored rather than derived, and the redirect only ever sends
-- a browser to this exact stored string. A tracking endpoint that accepted a
-- destination from its own query string would be an open redirect wearing our
-- domain, which is a phishing primitive we would be publishing on purpose.
CREATE TABLE tracked_links (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id      TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  campaign_id    TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  action_id      TEXT REFERENCES actions(id) ON DELETE SET NULL,
  target_url     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_tracked_links_person ON tracked_links(person_id, created_at DESC);
CREATE INDEX idx_tracked_links_ws ON tracked_links(workspace_id, created_at DESC);

-- ------------------------------------------------------------ what came back
--
-- Every hit on a tracked link, believed or not.
--
-- `automated` names why a hit was not counted as a person — 'prefetch' for one
-- that arrived implausibly soon after delivery, 'bot' for a self-identifying
-- crawler user agent — and is NULL for a hit we are willing to call a click.
-- Storing the reason rather than dropping the row means a workspace whose mail
-- is scanned can be shown why its click count is lower than its server logs.
--
-- No IP address is stored. It would be the obvious way to deduplicate, and it
-- is personal data about a prospect collected for our convenience rather than
-- theirs, which §17.4 does not permit us to hold casually.
CREATE TABLE link_clicks (
  id              TEXT PRIMARY KEY,
  tracked_link_id TEXT NOT NULL REFERENCES tracked_links(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id       TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  -- NULL means "we believe a human did this".
  automated       TEXT,
  user_agent      TEXT,
  occurred_at     TEXT NOT NULL
);

CREATE INDEX idx_link_clicks_person ON link_clicks(person_id, occurred_at DESC);
CREATE INDEX idx_link_clicks_link ON link_clicks(tracked_link_id, occurred_at DESC);

-- ------------------------------------------------------------------ opt-in
--
-- Off by default, and that default is a product decision rather than caution.
--
-- Outreach here is plain text that reads as though a person typed it, and a
-- rewritten URL is visible in plain text — the recipient sees our host, not
-- the destination. That is a real cost to the one thing the message has going
-- for it, so a workspace has to decide the measurement is worth it. When it is
-- off, `deliverEmailAction` sends the body exactly as approved and no
-- `tracked_links` row is written.
ALTER TABLE workspace_settings ADD COLUMN track_links INTEGER NOT NULL DEFAULT 0;

-- The origin tracked links are built against, e.g. https://app.example.com.
-- NULL falls back to the APP_URL the service is running with; storing it per
-- workspace is what a custom tracking domain will hang off later.
ALTER TABLE workspace_settings ADD COLUMN tracking_origin TEXT;
