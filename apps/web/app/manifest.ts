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
    icons: [
      {
        src: '/icons/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
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
