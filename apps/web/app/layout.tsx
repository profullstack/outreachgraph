import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Schibsted_Grotesk } from 'next/font/google';
import { ServiceWorkerRegistrar } from '../components/service-worker-registrar';
import './globals.css';

/**
 * Self-hosted by `next/font` at build time, so there is no render-blocking
 * request to Google and no layout shift when the face arrives.
 */
/*
 * The variable names must differ from Tailwind's `--font-sans` / `--font-mono`.
 * next/font sets its variable on <html>, which is also `:root`, so reusing the
 * theme's own name makes `--font-sans: var(--font-sans), …` a self-reference on
 * one element — an invalid cycle that silently drops the font.
 */
const sans = Schibsted_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-schibsted',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
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
