-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

INSERT INTO signals (
  id, workspace_id, person_id, network, signal_type, subtype,
  summary, evidence, source_url, source_timestamp, observed_at,
  confidence, relevance, sentiment
)
SELECT
  -- 20 hex characters of randomness without requiring pgcrypto.
  'sig_bf' || substr(upper(md5(random()::text || clock_timestamp()::text)), 1, 20),
  si.workspace_id,
  p.id,
  'website',
  'content_topic',
  'site_role',
  'Named on the company website' ||
    COALESCE(' (' || co.name || ')', '') || '.',
  
  
  p.display_name,
  si.profile_url,
  p.created_at,
  p.created_at,
  0.9,
  0.35,
  'neutral'
FROM people p
JOIN (
  
  
  
  SELECT person_id, workspace_id, profile_url
    FROM (
      SELECT s.person_id,
             r.workspace_id,
             s.profile_url,
             ROW_NUMBER() OVER (PARTITION BY s.person_id ORDER BY s.id) AS rn
        FROM social_identities s
        JOIN recommendations r ON r.person_id = s.person_id
       WHERE s.network = 'website'
         AND s.profile_url IS NOT NULL
         AND trim(s.profile_url) <> ''
    )
   WHERE rn = 1
) si ON si.person_id = p.id
LEFT JOIN companies co ON co.id = p.current_company_id
WHERE (p.current_title IS NULL OR trim(p.current_title) = '')
  AND p.status NOT IN ('deleted', 'suppressed')
  
  
  AND NOT EXISTS (SELECT 1 FROM signals x WHERE x.person_id = p.id);
