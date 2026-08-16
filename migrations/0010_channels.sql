-- 0010_channels.sql
-- Sending as yourself, posting by hand, and being able to watch either happen.
--
-- Three gaps this closes:
--
--   1. Outreach could only leave through one shared Resend key on one verified
--      domain, so every customer's mail said it came from us. Sending as
--      yourself means your own SMTP server, your own envelope, your own
--      reputation — and credentials that live per workspace rather than in the
--      container's environment.
--   2. Nothing recorded that a human posted somewhere by hand. The networks the
--      capability matrix marks `manual_only` are not a gap in the product, they
--      are the product working correctly, but the human's work still has to
--      land in the same funnel as an automated send or the numbers lie.
--   3. The pipeline reported itself only through container logs. A campaign
--      that is quietly working and a campaign that is quietly stuck look
--      identical from the outside, which is the single most common way this
--      product feels broken.

-- ---------------------------------------------------------------- sending
--
-- One sending account per workspace. `UNIQUE` rather than a PK on workspace_id
-- so the row can be replaced without disturbing anything that references it.
--
-- The secret is stored encrypted (AES-256-GCM) and is never read back out to a
-- client — the API returns everything on this row except `secret_encrypted`.
-- A password that can be round-tripped through a settings form is a password
-- that leaks through the settings form.
CREATE TABLE email_accounts (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  -- 'smtp' today. The column exists so adding a hosted provider later is a new
  -- value rather than a new table.
  provider           TEXT NOT NULL DEFAULT 'smtp',
  host               TEXT,
  port               INTEGER,
  -- 1 = implicit TLS from the first byte (465). 0 = plaintext connect then
  -- STARTTLS (587). Both are TLS by the time credentials move; see smtp.ts.
  secure             INTEGER NOT NULL DEFAULT 0,
  username           TEXT,
  secret_encrypted   TEXT,
  -- Two deliberate escape hatches, both off by default and both stored so the
  -- choice is visible rather than buried in an environment variable.
  --
  -- A self-hosted mail server may present a certificate signed by a private CA,
  -- and a relay on loopback may offer no TLS at all. Both are real, legitimate
  -- deployments. Refusing them outright would push people towards putting their
  -- real mailbox password into a server they trust less, which is worse than
  -- letting them say "yes, I know" about this one.
  allow_invalid_cert INTEGER NOT NULL DEFAULT 0,
  allow_insecure     INTEGER NOT NULL DEFAULT 0,
  from_email         TEXT NOT NULL,
  from_name          TEXT,
  -- Envelope reply-to for outreach sent through this account. NULL falls back
  -- to workspace_settings.reply_to_email and then to the owner's address.
  reply_to           TEXT,
  -- unverified | verified | failed
  --
  -- Load-bearing, not decorative: `runAutopilot` only accepts an account that
  -- reached 'verified', which is what makes "test it before it sends" a
  -- property of the system rather than a thing we ask people to remember.
  status             TEXT NOT NULL DEFAULT 'unverified',
  verified_at        TEXT,
  last_test_at       TEXT,
  last_error         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

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
