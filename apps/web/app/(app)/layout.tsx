import Link from 'next/link';
import { BottomNav } from '../../components/bottom-nav';
import { BrandLockup } from '../../components/brand';

/**
 * The signed-in app shell: a narrow reading column and the bottom nav.
 *
 * Marketing routes deliberately do not get this — a landing page inside a
 * 672px app column under a tab bar reads as a broken deployment.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/*
       * A slim brand row, not a title bar: every page already owns its own <h1>,
       * so this stays one line tall and only says which app you are in — the
       * thing an installed PWA loses when the browser chrome goes away.
       */}
      <div className="mx-auto w-full max-w-2xl px-4 pt-[env(safe-area-inset-top)]">
        <Link href="/today" aria-label="OutreachGraph home" className="inline-flex py-3">
          <BrandLockup size="sm" />
        </Link>
      </div>

      {/* pb-28 reserves room for the fixed bottom nav plus the home indicator. */}
      <main className="mx-auto w-full max-w-2xl px-4 pb-28">{children}</main>
      <BottomNav />
    </>
  );
}
