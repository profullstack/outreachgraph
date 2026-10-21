'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * One low-profile CrawlProof ad unit (the text_link line). Not used on the
 * homepage, which carries no ad.
 * Manage the slot at https://crawlproof.com/ads/slots
 */
const AD_SLOT = '121bb0bc-5e2e-4056-beeb-3c5166283991';

/** Account, auth and checkout pages carry no ad. */
const EXCLUDED_PREFIXES = ['/login', '/join', '/verify', '/reset', '/forgot'];

const SCAN_RETRY_MS = 200;
const SCAN_MAX_TRIES = 25;

declare global {
  interface Window {
    crawlproofAds?: { scan: () => void };
  }
}

function isExcluded(pathname: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function AdUnit() {
  const pathname = usePathname() ?? '/';
  if (isExcluded(pathname)) return null;
  // Keyed by path so each client-side navigation gets a fresh unit: ad.js
  // marks a filled element and never refills it in place.
  return <AdSlot key={pathname} />;
}

function AdSlot() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The server renders the element without data-slot, so ad.js's own
    // DOMContentLoaded pass skips it; the unit fills exactly once.
    el.dataset.format = 'text_link';
    el.dataset.slot = AD_SLOT;

    // ad.js scans once at DOMContentLoaded and may not have loaded yet, so
    // retry briefly; give up after ~5s so an ad blocker leaves no timer.
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (window.crawlproofAds) {
        window.crawlproofAds.scan();
        return;
      }
      if (++tries > SCAN_MAX_TRIES) return;
      timer = setTimeout(tick, SCAN_RETRY_MS);
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);

  return <div ref={ref} data-cp-ad="" className="cp-ad" />;
}
