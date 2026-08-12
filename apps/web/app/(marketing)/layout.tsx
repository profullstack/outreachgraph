/**
 * Public pages: full-bleed, no app chrome.
 *
 * Sections manage their own horizontal padding so a band can paint edge to
 * edge while its content stays on the same measure as everything else.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <main className="pt-[env(safe-area-inset-top)]">{children}</main>;
}
