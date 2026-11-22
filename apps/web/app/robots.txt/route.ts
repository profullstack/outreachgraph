import { gateway, siteUrl } from '../../lib/crawl-gateway';

// Generated from the same crawler lists the gateway enforces: training
// crawlers are refused everywhere but /crawl (where they can buy a pass),
// retrieval crawlers are named as welcome, everyone else gets the rules below.
// The gateway writes `Sitemap: <site>/sitemap.xml`; the blog at /blog is
// bot.seo's on-site blog (served by nginx) and has its own sitemap.
export function GET() {
  const body = `${gateway.robotsTxt({ disallow: ['/api/'] })}Sitemap: ${siteUrl}/blog/sitemap.xml\n`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
