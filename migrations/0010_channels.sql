-- 0010_channels.sql
-- Posting by hand, and being able to watch the pipeline work.
--
-- Two gaps this closes:
--
--   1. Nothing recorded that a human posted somewhere by hand. The networks the
--      capability matrix marks `manual_only` are not a gap in the product, they
--      are the product working correctly, but the human's work still has to
--      land in the same funnel as an automated send or the numbers lie.
--   2. The pipeline reported itself only through container logs. A campaign
--      that is quietly working and a campaign that is quietly stuck look
--      identical from the outside, which is the single most common way this
--      product feels broken.
--
-- Sending as yourself is deliberately *not* here. A workspace's own mail server
-- is stored on `integrations` + `integration_accounts` (migration 0000), which
-- is the pair `packages/policy` reads for `hasConnectedAccount` — a second
-- table holding the same fact would answer that question differently depending
-- on which one a caller happened to read, and the policy engine is the one
-- place that must never be ambiguous about whether a mailbox exists.

-- ------------------------------------------------------------ manual posts
--
-- A composed social post, from the moment the link is opened.
--
-- Recorded at compose time rather than on a callback because there is no
-- callback: these are `manual_only` networks, the human posts in the network's
-- own interface, and nothing reports back. What is honestly knowable is that
-- the product handed someone a prefilled composer and they took it, so that is
-- what this stores — `opened_at` is a fact, and `confirmed_at` is the human
-- saying they went through with it.
CREATE TABLE social_posts (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id    TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id      TEXT REFERENCES people(id) ON DELETE CASCADE,
  recommendation_id TEXT REFERENCES recommendations(id) ON DELETE SET NULL,
  -- No `actions` row is written for a post. `actions.kind` and `.network` are
  -- the vocabulary the policy engine reasons over, and neither `post` nor
  -- `nextdoor` belongs to it — the engine's fail-closed rule depends on an
  -- unknown pair meaning "never automate this", not "a human once did it".
  -- `actions` is also what the autopilot daily cap counts, and work someone did
  -- by hand must not spend the budget for automated email.
  network        TEXT NOT NULL,
  body           TEXT NOT NULL,
  url            TEXT,
  -- The compose URL handed to the browser, kept so a post can be reopened
  -- without regenerating it from a draft that may since have changed.
  share_url      TEXT NOT NULL,
  opened_at      TEXT NOT NULL,
  confirmed_at   TEXT
);

CREATE INDEX idx_social_posts_ws ON social_posts(workspace_id, opened_at DESC);
CREATE INDEX idx_social_posts_person ON social_posts(person_id, opened_at DESC);

-- --------------------------------------------------------------- telemetry
--
-- What the workflow is doing, as it does it.
--
-- `seq` is the point of the table. SQLite hands out INTEGER PRIMARY KEY values
-- monotonically, so a client can hold "I have seen up to 4812" and resume from
-- exactly there after a dropped connection — which a timestamp cannot do,
-- because two events in the same millisecond are indistinguishable and clocks
-- are not guaranteed to advance between writes.
--
-- Deliberately separate from `audit_events`. That table is a compliance record
-- with a retention policy and a legal meaning; this one is a progress bar.
-- Mixing them would mean either pruning the audit log or keeping the progress
-- bar forever, and both are wrong.
CREATE TABLE workflow_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id    TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id      TEXT REFERENCES people(id) ON DELETE CASCADE,
  -- Which part of the workflow spoke: intake | discover | crawl | identity |
  -- research | score | draft | send | social | notify | system
  phase          TEXT NOT NULL,
  -- info | success | warn | error
  level          TEXT NOT NULL DEFAULT 'info',
  -- One human-readable line. This is what the user actually reads, so it is
  -- stored rendered rather than assembled from a template id and arguments at
  -- display time.
  message        TEXT NOT NULL,
  detail_json    TEXT NOT NULL DEFAULT '{}',
  occurred_at    TEXT NOT NULL
);

CREATE INDEX idx_workflow_events_ws ON workflow_events(workspace_id, seq DESC);
CREATE INDEX idx_workflow_events_campaign ON workflow_events(campaign_id, seq DESC);
