import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { ServiceWorkerRegistrar } from '../components/service-worker-registrar';
import './globals.css';
import Script from "next/script";

/**
 * Self-hosted by `next/font` at build time, so there is no render-blocking
 * request to Google and no layout shift when the face arrives.
 */
/*
 * Fonts are committed files, not `next/font/google`.
 *
 * The Google loader fetches faces over the network during `next build`, and
 * doing that inside the Docker builder segfaulted Bun — the image job died on
 * SIGILL while the same build passed on the host. Local files make the build
 * hermetic, which it should have been anyway: a release that can fail because
 * fonts.gstatic.com is slow is a release with an avoidable dependency.
 *
 * The variable names must differ from Tailwind's `--font-sans` / `--font-mono`.
 * next/font sets its variable on <html>, which is also `:root`, so reusing the
 * theme's own name makes `--font-sans: var(--font-sans), …` a self-reference on
 * one element — an invalid cycle that silently drops the font.
 */
const sans = localFont({
  src: './fonts/schibsted-grotesk-latin.woff2',
  weight: '400 700',
  display: 'swap',
  variable: '--font-schibsted',
});

const mono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-mono-600.woff2', weight: '600', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-plex-mono',
});

/**
 * Absolute base for the social card URLs below.
 *
 * Indexed with a non-literal key for the same reason `lib/api.ts` does it: Next
 * inlines `process.env.SOME_NAME` at build time, so a variable that only exists
 * on Railway would otherwise be frozen as `undefined` in the image.
 */
function siteUrl(): URL {
  const key = 'PUBLIC_SITE_URL';
  return new URL(process.env[key] ?? 'https://outreachgraph.com');
}

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: 'OutreachGraph',
  description: 'Turn public intent signals into warm conversations.',
  applicationName: 'OutreachGraph',
  /*
   * `favicon.png` is the graph mark on transparency — it is the only asset that
   * reads on a light tab strip and a dark one, which is why it is the icon
   * everywhere rather than `logo.png`. The wordmark is white on the left half
   * and would show as "Graph" alone at 16px on white.
   */
  icons: {
    icon: [{ url: '/favicon.png', type: 'image/png', sizes: '512x512' }],
    shortcut: ['/favicon.png'],
    apple: [{ url: '/favicon.png', sizes: '512x512' }],
  },
  openGraph: {
    type: 'website',
    siteName: 'OutreachGraph',
    title: 'OutreachGraph',
    description: 'Turn public intent signals into warm conversations.',
    url: '/',
    images: [{ url: '/favicon.png', width: 512, height: 512, alt: 'OutreachGraph' }],
  },
  twitter: {
    card: 'summary',
    title: 'OutreachGraph',
    description: 'Turn public intent signals into warm conversations.',
    images: [{ url: '/favicon.png', width: 512, height: 512, alt: 'OutreachGraph' }],
  },
  appleWebApp: {
    capable: true,
    title: 'OutreachGraph',
    statusBarStyle: 'black-translucent',
  },
  formatDetection: { telephone: false },
};

/**
 * `viewportFit: 'cover'` is what lets the layout paint into the notch and home
 * indicator areas; `env(safe-area-inset-*)` in globals.css then keeps content
 * out of them (PRD §1.1 "safe-area support for modern phones").
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0f17' },
  ],
};

/**
 * The root layout holds only what every route needs.
 *
 * The app shell — the narrow column and the bottom nav — lives in `(app)`,
 * because wrapping the public landing page in a mobile app chrome capped at
 * `max-w-2xl` made a marketing page render as a 672px strip under a nav bar
 * for people who were not signed in.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="bg-surface text-ink min-h-dvh antialiased">
        <ServiceWorkerRegistrar />
        {children}
              <Script data-site="1c2f4daf-5388-46af-a167-f8e9f9c74c27" src="https://crawlproof.com/stats.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
