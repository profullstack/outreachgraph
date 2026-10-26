-- 0077_service_user.sql (Postgres). See migrations/0077_service_user.sql for the reasoning.
INSERT INTO users (id, email, name, status, created_at, updated_at)
SELECT 'usr_service', 'service@outreachgraph.invalid',
       'OutreachGraph service token', 'active', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
 WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 'usr_service');
