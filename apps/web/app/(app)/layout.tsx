import { BottomNav } from '../../components/bottom-nav';

/**
 * The signed-in app shell: a narrow reading column and the bottom nav.
 *
 * Marketing routes deliberately do not get this — a landing page inside a
 * 672px app column under a tab bar reads as a broken deployment.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* pb-28 reserves room for the fixed bottom nav plus the home indicator. */}
      <main className="mx-auto w-full max-w-2xl px-4 pt-[env(safe-area-inset-top)] pb-28">
        {children}
      </main>
      <BottomNav />
    </>
  );
}
