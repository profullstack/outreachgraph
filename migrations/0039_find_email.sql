-- 0039_find_email.sql
-- Finding a sendable address for people we can only reach by hand.
--
-- About ninety people in production are reachable on LinkedIn and nowhere
-- else: no imported address, no published one, no company inbox. LinkedIn is
-- `manual_only` for every action, so each of them holds a card a human has to
-- carry out in another tab, and a list import was meant to need no human at
-- all. The `find_email` job works out an address from their name and their
-- employer's domain and checks it against the domain's mail servers.
--
-- `email_searched_at` is a timestamp for the same reason `contact_enriched_at`
-- and `photo_looked_up_at` are: most searches find nothing sendable, and a
-- boolean would make the sweep retry every miss on every tick. A search older
-- than the retry window is allowed to run again, because what it learns from
-- (colleagues' confirmed addresses) accumulates.
ALTER TABLE people ADD COLUMN email_searched_at TEXT;

-- What the mail servers said about a candidate, kept beside the human-readable
-- `basis` so a reviewer can see *why* one address was promoted and its
-- neighbours were not: MX hosts, whether the domain accepts every recipient,
-- and the RCPT reply when the probe could run at all. JSON, because the shape
-- differs between "probed and accepted" and "port 25 was unreachable".
ALTER TABLE email_candidates ADD COLUMN evidence_json TEXT;
