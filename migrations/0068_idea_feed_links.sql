-- 0068_idea_feed_links.sql: idea evidence links that pointed at our own origin.
--
-- Podcast feeds in the RSS Amplifier directory (Starter Story above all) carry
-- no link per episode, only a guid such as a bare UUID. The reader fell back to
-- that guid as the url, the ideas board rendered it as an href, and the browser
-- resolved it against outreachgraph.com: a 404 on every Starter Story idea. The
-- reader now sends those to the directory's reader page; this rewrites the rows
-- it already filed. post_id is 'feed:<slug>:<guid>', so the guid is recoverable.
UPDATE idea_asks
   SET url = 'https://rssamplifier.com/' || sub || '/read?p=' || substr(post_id, length('feed:' || sub || ':') + 1)
 WHERE url NOT LIKE 'http%'
   AND post_id LIKE 'feed:%';
