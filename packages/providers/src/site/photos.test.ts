import { describe, expect, test } from 'bun:test';
import { publicPhotoUrl } from '../photo';
import { extractNamedPhotos } from './photos';
import { SiteProvider } from './provider';

const PAGE = 'https://acme.example/team/';
const NAMES = ['Jane Smith', 'Martín Gómez'];
const structured = (value: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

describe('public portraits', () => {
  test('reads nested Person image objects and arrays, resolving against the source page', () => {
    const photos = extractNamedPhotos(
      structured({
        '@graph': [
          {
            '@type': 'Organization',
            employee: [
              {
                '@type': 'Person',
                name: 'Jane Smith',
                image: { '@type': 'ImageObject', contentUrl: '../jane.jpg' },
              },
              {
                '@type': ['Person'],
                name: 'Martín Gómez',
                image: [null, { url: '//cdn.example/martin.jpg' }],
              },
            ],
          },
        ],
      }),
      PAGE,
      NAMES,
    );
    expect(photos.get('Jane Smith')).toEqual({
      url: 'https://acme.example/jane.jpg',
      pageUrl: PAGE,
    });
    expect(photos.get('Martín Gómez')?.url).toBe('https://cdn.example/martin.jpg');
  });

  test('matches explicit portrait labels, not a nearby name or a partial match', () => {
    const photos = extractNamedPhotos(
      `
      <h3>Jane Smith</h3><img src="/wrong.jpg" alt="Mary Jane Smith">
      <img src="/logo.jpg"><img alt="Jane Smith headshot" data-src="/jane.jpg?x=1&amp;y=2" src="data:image/gif;base64,AAAA">
      <img src=/martin.jpg alt="Portrait of MARTÍN GÓMEZ">
      <img alt="Jane Smith" src="/pixel.gif" width="1" height="1">
    `,
      PAGE,
      NAMES,
    );
    expect(photos.get('Jane Smith')?.url).toBe('https://acme.example/jane.jpg?x=1&y=2');
    expect(photos.get('Martín Gómez')?.url).toBe('https://acme.example/martin.jpg');
  });

  test('structured portraits win over named markup, and a malformed block does not hide images', () => {
    const html =
      structured({ '@type': 'Person', name: 'Jane Smith', image: '/official.jpg' }) +
      '<script type="application/ld+json">not json</script><img alt="Jane Smith" src="/jane.jpg">';
    expect(extractNamedPhotos(html, PAGE, NAMES).get('Jane Smith')?.url).toBe(
      'https://acme.example/official.jpg',
    );
  });

  test('ignores generic share cards, unlabelled images, script strings and comments', () => {
    const photos = extractNamedPhotos(
      `
      <meta property="og:image" content="/share.jpg"><h1>Jane Smith</h1><img src="/team.jpg">
      <!-- <img alt="Jane Smith" src="/comment.jpg"> -->
      <script>const x = '<img alt="Jane Smith" src="/script.jpg">';</script>
    `,
      PAGE,
      NAMES,
    );
    expect(photos.size).toBe(0);
  });

  test('rejects an image claimed by multiple people, including an unextracted name', () => {
    const photos = extractNamedPhotos(
      '<img alt="Jane Smith" src="/shared.jpg"><img alt="Somebody Else" src="/shared.jpg">',
      PAGE,
      NAMES,
    );
    expect(photos.size).toBe(0);
  });

  test.each([
    'javascript:alert(1)',
    'data:image/svg+xml,x',
    'file:///tmp/me.jpg',
    '#portrait',
    'http://127.0.0.1/me.jpg',
    'http://2130706433/me.jpg',
    'http://10.1.2.3/me.jpg',
    'http://169.254.169.254/latest',
    'http://[::1]/me.jpg',
    'https://user:secret@cdn.example/me.jpg',
  ])('rejects an unsafe photo URL: %s', (url) => {
    expect(publicPhotoUrl(url, PAGE)).toBeUndefined();
    expect(extractNamedPhotos(`<img alt="Jane Smith" src="${url}">`, PAGE, NAMES).size).toBe(0);
  });

  test('the crawl retains portraits from followed team pages without extra requests', async () => {
    const requested: string[] = [];
    const site = new SiteProvider({
      fetchImpl: async (input) => {
        const url = input.toString();
        requested.push(url);
        if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nAllow: /');
        const html =
          url === 'https://acme.example/'
            ? structured({ '@type': 'Person', name: 'Jane Smith' }) + '<a href="/team">Our team</a>'
            : '<img src="/jane.jpg" alt="Jane Smith">';
        return new Response(html, { headers: { 'content-type': 'text/html' } });
      },
    });
    const result = await site.crawl('https://acme.example/');
    expect(result.people[0]?.photo).toEqual({
      url: 'https://acme.example/jane.jpg',
      pageUrl: 'https://acme.example/team',
    });
    expect(result.usedSignals).toContain('photo');
    expect(requested.filter((url) => !url.endsWith('/robots.txt'))).toEqual([
      'https://acme.example/',
      'https://acme.example/team',
    ]);
  });

  test('a robots-denied team page cannot contribute a portrait', async () => {
    const requested: string[] = [];
    const site = new SiteProvider({
      fetchImpl: async (input) => {
        const url = input.toString();
        requested.push(url);
        if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /team');
        return new Response(
          structured({ '@type': 'Person', name: 'Jane Smith' }) + '<a href="/team">Team</a>',
        );
      },
    });
    expect((await site.crawl('https://acme.example/')).people[0]?.photo).toBeUndefined();
    expect(requested).not.toContain('https://acme.example/team');
  });

  test('rejects a shared image when another page names a different owner', async () => {
    const site = new SiteProvider({
      fetchImpl: async (input) => {
        const url = input.toString();
        if (url.endsWith('/robots.txt')) return new Response('');
        const html =
          url === 'https://acme.example/'
            ? structured({ '@type': 'Person', name: 'Jane Smith', image: '/shared.jpg' }) +
              '<a href="/team">Team</a>'
            : '<img alt="Somebody Else" src="/shared.jpg">';
        return new Response(html);
      },
    });
    expect((await site.crawl('https://acme.example/')).people[0]?.photo).toBeUndefined();
  });
});
