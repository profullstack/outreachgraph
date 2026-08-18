-- 0015_rules.sql
-- If this happens, do that — without a way to say "do that regardless".
--
-- Both companies this product competes with arrived at the same primitive from
-- opposite ends of the market: trigger, condition, action, running over a
-- stream of signals. That convergence is a strong argument that the shape is
-- right. What is not right is what they let the action be.
--
-- ---------------------------------------------------------------------------
-- The one design decision that matters
--
-- A rule here **cannot send anything**. The permitted actions are:
--
--   enroll_cadence  put the person on a plan, whose steps are then resolved by
--                   the capability matrix when each falls due
--   notify          tell a human
--   suppress        never contact them again
--   set_status      move them in the funnel
--
-- There is deliberately no `send_email` and no `post_to`. Not because sending
-- from a rule would be hard, but because an action that reaches the wire
-- directly is an action that has its own opinion about whether it is allowed —
-- and then there are two policy engines, one of them written by whoever added
-- the feature, and the quiet one wins.
--
-- Routing every rule through `enroll_cadence` means a rule can only ever
-- *queue* work. Whether that work happens, and whether it happens
-- automatically or as a one-tap human step, stays the deterministic engine's
-- decision. A rule cannot automate LinkedIn by being written carelessly,
-- because a rule has no way to express it.
--
-- `suppress` is the exception that proves it: it only ever restricts, so it
-- needs no gate.

CREATE TABLE automation_rules (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- NULL applies the rule across every campaign in the workspace.
  campaign_id    TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  -- signal_received | score_crossed | reply_received | stage_changed
  trigger        TEXT NOT NULL,
  -- Trigger-specific matching, e.g. {"signalType":"pain_point","minRelevance":0.6}
  condition_json TEXT NOT NULL DEFAULT '{}',
  -- enroll_cadence | notify | suppress | set_status
  action         TEXT NOT NULL,
  action_json    TEXT NOT NULL DEFAULT '{}',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_rules_ws ON automation_rules(workspace_id, enabled);
CREATE INDEX idx_rules_trigger ON automation_rules(workspace_id, trigger, enabled);

-- Every time a rule fired, and what came of it.
--
-- The `outcome` column carries its weight here: a rule that fires constantly
-- and is refused every time looks identical to a working rule from a counter,
-- and is the most common way an automation quietly does nothing.
CREATE TABLE rule_runs (
  id             TEXT PRIMARY KEY,
  rule_id        TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id      TEXT REFERENCES people(id) ON DELETE CASCADE,
  -- applied | skipped | failed
  outcome        TEXT NOT NULL,
  detail         TEXT,
  occurred_at    TEXT NOT NULL,
  -- One firing per rule per person per trigger occurrence. Without this a
  -- re-run of the signal sweep re-enrols everybody it already enrolled, and a
  -- rule that was meant to add somebody to a plan once instead adds them on
  -- every tick for as long as the signal stays fresh.
  dedupe_key     TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_rule_runs_once ON rule_runs(rule_id, dedupe_key);
CREATE INDEX idx_rule_runs_ws ON rule_runs(workspace_id, occurred_at DESC);
