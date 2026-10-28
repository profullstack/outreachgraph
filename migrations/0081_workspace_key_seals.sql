-- Seal v2: each workspace's credentials are sealed to the workspace's own key,
-- opened only with the owner's passphrase (or one-time recovery key). This row
-- holds ciphertext + salt + KDF params + key check + public key; nothing in it
-- opens anything. integration_accounts values starting with 'v2:' are sealed;
-- anything else is a legacy SECRET_ENCRYPTION_KEY value awaiting migration.
CREATE TABLE IF NOT EXISTS workspace_key_seals (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  seal_json text NOT NULL,
  seal_version integer NOT NULL DEFAULT 2,
  created_by text,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
