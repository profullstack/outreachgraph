'use client';

import { useEffect, useState } from 'react';

/**
 * Registers the service worker and surfaces updates (PRD §1.1 PWA
 * requirements: "update notification when a new service worker is available").
 *
 * The prompt is deliberate rather than automatic: reloading underneath someone
 * mid-approval would lose their edited draft.
 */
export function ServiceWorkerRegistrar() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;

    let cancelled = false;

    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        if (cancelled) return;

        if (registration.waiting) setWaiting(registration.waiting);

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;

          installing.addEventListener('statechange', () => {
            // `controller` is null on the very first install — that is a fresh
            // page load, not an update, and must not prompt.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              setWaiting(installing);
            }
          });
        });
      })
      .catch(() => {
        // A failed registration must not break the app; it just means no
        // offline support this session.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!waiting) return null;

  return (
    <div
      role="status"
      className="border-border bg-surface-raised fixed inset-x-3 top-3 z-[60] flex items-center gap-3 rounded-xl border p-3 shadow-lg"
      style={{ top: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
    >
      <p className="flex-1 text-sm">A new version is ready.</p>
      <button
        type="button"
        onClick={() => {
          waiting.postMessage({ type: 'SKIP_WAITING' });
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            window.location.reload();
          });
        }}
        className="bg-accent rounded-lg px-3 text-sm font-medium text-white"
      >
        Reload
      </button>
    </div>
  );
}
