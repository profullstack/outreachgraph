-- 0043_inbox_auto_reply.sql
--
-- A unified inbox, a label on every reply, and a drafted answer for the ones
-- worth answering.
--
-- Replies were recorded as one undifferentiated fact — "this address wrote
-- back" — with the subject line standing in for the message. That was enough
-- to stop cold outreach and nothing else: nobody could see what was said, an
-- out-of-office and an "interested, send pricing" looked the same, and the
-- only way to answer was to open a mail client.
--
-- Four additions, each the smallest thing that makes one part of that honest:
--
--   - On `interactions`: the message's own subject and text, the threading
--     headers an answer needs (`references_header`; the Message-ID is already
--     `external_id`), and the label triage gave it — which label, how sure,
--     and whether a rule or a model said so. A rule's label can act on its own
--     (an unsubscribe phrase suppresses); a model's only proposes.
--   - Out-of-office notices and bounces are now recorded, as
--     `direction = 'automated'`, so the thread shows them. A new direction and
--     not a new state on `'inbound'`, because a dozen readers count
--     `direction = 'inbound'` as "they replied" — the policy gate, the funnel,
--     the reply rate — and every one of them would otherwise have to learn to
--     exclude a robot. The safe reading is the default one.
--   - On `campaigns`: how replies are answered. `copilot` drafts a reply card
--     for a human (the default, matching the approval default everywhere
--     else); `autonomous` may send without one, and only when every gate in
--     `@outreachgraph/policy`'s `decideAutoReply` holds; `off` drafts nothing.
--   - On `recommendations`: which inbound message a reply card answers, so the
--     send can thread (In-Reply-To, References, "Re:") and go back to the
--     address that actually wrote, and so one message is answered once.

ALTER TABLE interactions ADD COLUMN subject TEXT;
ALTER TABLE interactions ADD COLUMN references_header TEXT;
-- interested | not_interested | question | out_of_office | unsubscribe_request
-- | referral | bounce | other. NULL until triage has run.
ALTER TABLE interactions ADD COLUMN reply_label TEXT;
ALTER TABLE interactions ADD COLUMN reply_confidence REAL;
-- rule | model | unclassified
ALTER TABLE interactions ADD COLUMN reply_label_source TEXT;
ALTER TABLE interactions ADD COLUMN reply_label_reason TEXT;
ALTER TABLE interactions ADD COLUMN labelled_at TEXT;

CREATE INDEX idx_interactions_thread
  ON interactions(workspace_id, person_id, occurred_at);

ALTER TABLE campaigns ADD COLUMN auto_reply_mode TEXT NOT NULL DEFAULT 'copilot';
ALTER TABLE campaigns ADD COLUMN auto_reply_threshold REAL NOT NULL DEFAULT 0.85;

ALTER TABLE recommendations ADD COLUMN reply_to_interaction_id TEXT;

CREATE INDEX idx_recommendations_reply_to
  ON recommendations(reply_to_interaction_id);
