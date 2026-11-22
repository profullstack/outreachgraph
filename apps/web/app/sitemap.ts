import type { MetadataRoute } from 'next';
import { siteUrl } from '../lib/crawl-gateway';

// Read SITE_URL at request time, not at build time.
export const dynamic = 'force-dynamic';

/**
 * The public pages only: everything under (app) needs a session, and
 * /calendar/<handle> and /schedule/<handle> are per-user booking links. The
 * bot.seo blog at /blog has its own sitemap, named in robots.txt.
 */
const PUBLIC_PATHS = ['/', '/tools/content-checker', '/join', '/login'];

export default function sitemap(): MetadataRoute.Sitemap {
  return PUBLIC_PATHS.map((path) => ({
    url: `${siteUrl}${path}`,
    changeFrequency: path === '/' ? 'weekly' : 'monthly',
    priority: path === '/' ? 1 : 0.5,
  }));
}
