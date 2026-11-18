-- 0090_workspace_unattended_keys: workspace keys that unlock themselves.
--
-- Anthony 2026-11-18: "make it 100% automated", choosing fully unattended
-- unlock over the 7-day manual unlock (a deliberate exception to the
-- 2026-10-28 unlock-on-use rule, for OutreachGraph workspace keys only).
--
-- When the owner unlocks with "keep unlocked across restarts", the data key
-- they sent is stored here wrapped (AES-256-GCM, AAD = workspace id) under the
-- server key OG_UNATTENDED_KEY. At boot and on every worker tick a locked
-- workspace with a row here is unlocked again. Lock deletes the row; so does
-- turning the option off. Without OG_UNATTENDED_KEY the rows open nothing.

CREATE TABLE IF NOT EXISTS workspace_unattended_keys (
  workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  wrapped_dek   TEXT NOT NULL,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
