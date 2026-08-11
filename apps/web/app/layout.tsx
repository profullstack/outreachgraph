import type { Metadata, Viewport } from 'next';
import { BottomNav } from '../components/bottom-nav';
import { ServiceWorkerRegistrar } from '../components/service-worker-registrar';
import './globals.css';

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-surface text-ink min-h-dvh antialiased">
        <ServiceWorkerRegistrar />
        {/* pb-28 reserves room for the fixed bottom nav plus the home indicator. */}
        <main className="mx-auto w-full max-w-2xl px-4 pt-[env(safe-area-inset-top)] pb-28">
          {children}
        </main>
        <BottomNav />
      </body>
    </html>
  );
}
