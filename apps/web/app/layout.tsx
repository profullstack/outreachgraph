import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { ServiceWorkerRegistrar } from '../components/service-worker-registrar';
import './globals.css';

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

export const metadata: Metadata = {
  title: 'OutreachGraph',
  description: 'Turn public intent signals into warm conversations.',
  applicationName: 'OutreachGraph',
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
      </body>
    </html>
  );
}
