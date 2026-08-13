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
       * The brand row. It gets the full `lg` lockup rather than the compact one:
       * unlike the marketing nav it has the row to itself — nothing shares the
       * line — so it can take the same size as the sign-in page without pushing
       * anything off a narrow screen.
       */}
      <div className="mx-auto w-full max-w-2xl px-4 pt-[env(safe-area-inset-top)]">
        <Link href="/today" aria-label="OutreachGraph home" className="inline-flex py-4">
          <BrandLockup size="lg" />
        </Link>
      </div>

      {/* pb-28 reserves room for the fixed bottom nav plus the home indicator. */}
      <main className="mx-auto w-full max-w-2xl px-4 pb-28">{children}</main>
      <BottomNav />
    </>
  );
}
