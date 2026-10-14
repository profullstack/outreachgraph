-- 0068_idea_feed_links.sql (Postgres). See migrations/0068_idea_feed_links.sql for the reasoning.
UPDATE idea_asks
   SET url = 'https://rssamplifier.com/' || sub || '/read?p=' || substr(post_id, length('feed:' || sub || ':') + 1)
 WHERE url NOT LIKE 'http%'
   AND post_id LIKE 'feed:%';
