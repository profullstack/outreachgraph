-- Converted from SQLite by @profullstack/libsql-pg. Review every TODO before applying.
-- Types: INTEGER -> bigint, REAL -> double precision, BLOB -> bytea, BOOLEAN -> boolean,
-- DATETIME/TIMESTAMP -> timestamptz, TEXT -> text; INTEGER PRIMARY KEY -> identity.

UPDATE people
   SET status = 'suppressed',
       outreach_eligible = 0,
       updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 WHERE status = 'active'
   AND lower(trim(display_name)) IN (
     'webmaster', 'admin', 'administrator', 'postmaster', 'hostmaster',
     'support', 'info', 'information', 'contact', 'contact us', 'sales',
     'hello', 'team', 'staff', 'office', 'help', 'helpdesk',
     'enquiries', 'inquiries', 'marketing', 'press', 'media',
     'careers', 'jobs', 'recruiting', 'billing', 'accounts', 'accounting',
     'legal', 'privacy', 'security', 'abuse', 'noreply', 'no-reply',
     'donotreply', 'newsletter', 'subscribe', 'unsubscribe',
     'user', 'guest', 'customer', 'customer service', 'anonymous',
     'unknown', 'null', 'undefined', 'none', 'test', 'bot', 'moderator'
   );

UPDATE recommendations
   SET status = 'cancelled'
 WHERE status = 'pending'
   AND person_id IN (SELECT id FROM people WHERE status = 'suppressed');
