-- Opt-out, which the product has never had.
--
-- Outbound mail carried no `List-Unsubscribe` header and no opt-out link, so
-- the only route out of a campaign was asking a human to add you to the
-- suppression list. That is not a mechanism a recipient can reach, and both
-- CAN-SPAM and the sending provider's terms require one for commercial mail.
--
-- The token is a stored random id rather than a signed payload, matching
-- `tracked_links`: the same shape, revocable by deletion, and it never needs a
-- key to be rotated or plumbed through the sender.
CREATE TABLE unsubscribe_tokens (
  token           TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id       TEXT NOT NULL,
  campaign_id     TEXT,
  -- The mailbox the message went to. For a shared company inbox this is the
  -- thing being unsubscribed, not the person: whoever reads `support@` speaks
  -- for everyone we would otherwise write to there.
  contact_address TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  -- Set the first time it is used. Kept rather than deleted so a second click
  -- can say "already done" instead of "this link is broken".
  used_at         TEXT
);

CREATE INDEX idx_unsubscribe_tokens_person ON unsubscribe_tokens(person_id);
CREATE INDEX idx_unsubscribe_tokens_address ON unsubscribe_tokens(workspace_id, contact_address);
