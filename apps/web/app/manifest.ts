import type { MetadataRoute } from 'next';

/**
 * Installable web app manifest (PRD §1.1 PWA requirements).
 *
 * `display: standalone` plus `start_url: /` means an installed launch opens
 * straight into Today, which is the prospecting inbox the PRD describes.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'OutreachGraph',
    short_name: 'OutreachGraph',
    description: 'Turn public intent signals into warm conversations.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0b0f17',
    theme_color: '#0b0f17',
    categories: ['business', 'productivity'],
    /*
     * The SVGs stay first for the browsers that take them, but Android's
     * installer and most splash-screen generators still want a raster icon with
     * a declared pixel size, so `favicon.png` is listed alongside them.
     *
     * It is not offered as `maskable`: the mark runs edge to edge on its canvas,
     * and a maskable icon gets cropped to whatever shape the launcher uses. The
     * padded SVG keeps that job.
     */
    icons: [
      {
        src: '/icons/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/favicon.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-maskable.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      { name: 'Approvals', url: '/approvals', description: 'Review pending outreach' },
      { name: 'Signals', url: '/signals', description: 'Latest high-intent activity' },
    ],
  };
}
