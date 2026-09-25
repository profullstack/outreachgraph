-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

alter table interactions add column if not exists contact_address text;

alter table interactions add column if not exists shared_inbox bigint NOT NULL DEFAULT 0;

CREATE INDEX idx_interactions_address
  ON interactions(workspace_id, contact_address, occurred_at DESC);

UPDATE interactions
   SET contact_address = (
         SELECT lower(trim(si.handle))
           FROM social_identities si
          WHERE si.person_id = interactions.person_id
            AND si.network = 'email'
          ORDER BY si.confidence DESC
          LIMIT 1
       )
 WHERE network = 'email'
   AND contact_address IS NULL;

UPDATE interactions
   SET contact_address = (
         SELECT lower(trim(co.contact_email))
           FROM people p
           JOIN companies co ON co.id = p.current_company_id
          WHERE p.id = interactions.person_id
            AND co.contact_email IS NOT NULL
            AND trim(co.contact_email) <> ''
       ),
       shared_inbox = 1
 WHERE network = 'email'
   AND contact_address IS NULL
   
   
   AND EXISTS (
         SELECT 1
           FROM people p
           JOIN companies co ON co.id = p.current_company_id
          WHERE p.id = interactions.person_id
            AND co.contact_email IS NOT NULL
            AND trim(co.contact_email) <> ''
       );
