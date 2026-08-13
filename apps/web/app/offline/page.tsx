import { BrandMark } from '../../components/brand';

export const metadata = { title: 'Offline · OutreachGraph' };

/**
 * Offline fallback (PRD §1.1 "offline/error fallback screens").
 *
 * Pre-cached at install time, so it is available precisely when the network is
 * not. It stays deliberately static — anything dynamic here would need the
 * network it is apologising for.
 */
export default function OfflinePage() {
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center text-center">
      {/* Pre-cached with this page by the service worker, so it renders with no network. */}
      <BrandMark className="mb-5 h-16 w-16" />
      <h1 className="text-xl font-semibold">You are offline</h1>
      <p className="text-ink-muted mt-2 max-w-xs text-sm">
        Prospect data and the approval queue need a connection — approvals are never served from a
        stale cache.
      </p>
      <p className="text-ink-muted mt-6 text-xs">This page will work again once you reconnect.</p>
    </div>
  );
}
