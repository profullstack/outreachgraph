-- 0045_audience_watches.sql
-- The workspace's own audience as an intake source.
--
-- Every intake before this one starts from a stranger: a keyword names
-- companies, a crawl names people, a feed search finds somebody complaining
-- about a category. A watch starts from people who already put a hand up —
-- they followed the workspace's account, liked its post, reposted it or
-- replied to it. The engagement is public, it names both parties, and nothing
-- about it was inferred, which makes it the cheapest grounded claim the
-- product can make and the shortest-lived (see `audience_engagement` in
-- packages/domain/src/signal.ts, which decays with the high-intent set).
--
-- Two tables and no new columns anywhere else. People arrive through the same
-- `intakeSocialPeople` path a social client already uses, so identity
-- confidence, campaign membership, the policy engine and human approval all
-- behave exactly as they do for every other stranger. A like does not promote
-- anyone to a send.

-- One watched account, in one campaign.
CREATE TABLE IF NOT EXISTS audience_watches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,

  -- 'bluesky' | 'x' | 'linkedin' (packages/domain/src/audience.ts).
  network TEXT NOT NULL,
  -- Handle or DID, normalised: no '@', no URL, lower-cased.
  account TEXT NOT NULL,

  -- 'poll' reads the network on a schedule; 'handoff' is filled by a human or
  -- a client posting what they saw. LinkedIn is hand-off only, because reading
  -- reactions would mean driving the member's session for something the
  -- LinkedIn opt-in never covered.
  mode TEXT NOT NULL DEFAULT 'poll',

  -- JSON array of 'follow' | 'like' | 'repost' | 'reply' | 'mention'.
  kinds_json TEXT NOT NULL DEFAULT '["follow","like","repost","reply","mention"]',

  poll_minutes INTEGER NOT NULL DEFAULT 30,
  -- How many of the account's recent posts a run reads engagement on.
  lookback_posts INTEGER NOT NULL DEFAULT 10,
  -- Most engagements one run may turn into people, so a post that goes wide
  -- cannot fill a campaign with a thousand strangers in one tick.
  per_run_cap INTEGER NOT NULL DEFAULT 100,

  enabled INTEGER NOT NULL DEFAULT 1,
  last_polled_at TEXT,
  -- Why the last run produced nothing, in the network's own words. A refusal
  -- that cannot be retried (an unpaid X tier, a revoked grant) also clears
  -- `enabled`, so the watch stops rather than spending quota on the same no.
  last_error TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One watch per account per campaign. The same account may be watched into two
-- campaigns — a workspace selling two things to two audiences is normal — but
-- watching it into one campaign twice is a duplicate, not a configuration.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audience_watches_account
  ON audience_watches(workspace_id, campaign_id, network, account);

CREATE INDEX IF NOT EXISTS idx_audience_watches_due
  ON audience_watches(workspace_id, enabled, mode, last_polled_at);

-- The ledger that makes a re-read idempotent.
--
-- A poll looks at the same window every time it runs, so the same like is seen
-- on every tick for as long as it is in the window. Keyed on the act, not on
-- when we saw it: somebody who likes a post, unlikes it and likes it again is
-- one row, because the product cannot tell that apart from a re-read and
-- inventing a second signal would be inventing warmth.
CREATE TABLE IF NOT EXISTS audience_engagements (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES audience_watches(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  signal_id TEXT REFERENCES signals(id) ON DELETE SET NULL,

  network TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor_handle TEXT NOT NULL,
  -- '<kind>:<actor>:<subject>' from `engagementKey`. Unique per watch.
  engagement_key TEXT NOT NULL,

  subject_id TEXT,
  subject_url TEXT,
  -- When the network says it happened, when the network says at all.
  occurred_at TEXT,
  observed_at TEXT NOT NULL,
  -- 'poll' or the client that handed it over, so provenance survives.
  source TEXT NOT NULL,

  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audience_engagements_key
  ON audience_engagements(watch_id, engagement_key);

CREATE INDEX IF NOT EXISTS idx_audience_engagements_person
  ON audience_engagements(workspace_id, person_id, observed_at);
