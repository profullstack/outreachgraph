'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Phone-first bottom navigation (PRD §1.1 "Mobile Navigation").
 *
 * Five tabs, in the order the work actually happens once a workspace is set
 * up: read what came back, approve what is waiting, look after the products,
 * see the numbers, change a setting. It used to follow the pipeline —
 * Today, Outreach, Funnel, Prospects, Approvals, More — which is how the
 * machine is built rather than how anyone uses it, and it left the Inbox, the
 * page opened most, behind "More".
 *
 * Everything that lost its tab is still a route, and Settings lists it.
 * Import got its tab back: behind More, nobody could find it.
 */
const TABS = [
  { href: '/inbox', label: 'Inbox', icon: InboxIcon, badge: true },
  { href: '/approvals', label: 'Approve', icon: CheckIcon },
  { href: '/products', label: 'Products', icon: BoxIcon },
  { href: '/funnel', label: 'Results', icon: FunnelIcon },
  { href: '/import', label: 'Import', icon: UploadIcon },
  { href: '/settings', label: 'Settings', icon: GearIcon },
] as const;

/** Routes that belong to a tab without sharing its path. */
const OWNED_BY: Record<string, string> = {
  '/setup': '/products',
  '/outreach': '/products',
  '/jobs': '/products',
  '/today': '/settings',
  '/more': '/settings',
  '/team': '/settings',
  '/billing': '/settings',
  '/cadences': '/settings',
  '/rules': '/settings',
  '/research': '/settings',
  '/signals': '/settings',
  '/prospects': '/settings',
};

/** Public routes: the app chrome would be meaningless before signing in. */
const PUBLIC_ROUTES = ['/', '/login', '/offline'];

const UNREAD_POLL_MS = 60_000;

/**
 * People waiting on a reply, for the Inbox badge.
 *
 * Fetched here rather than by each page so the badge is right on every tab,
 * and quietly: a failed count shows no badge, never an error.
 */
function useUnread(enabled: boolean): string | undefined {
  const [count, setCount] = useState<string | undefined>();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const response = await fetch('/api/v1/inbox/unread', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as { needReply?: number; capped?: boolean };
        const n = Number(body.needReply ?? 0);
        setCount(n === 0 ? undefined : body.capped ? '99+' : String(n));
      } catch {
        // No badge is the right answer when the count cannot be had.
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), UNREAD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled]);

  return count;
}

export function BottomNav() {
  const pathname = usePathname();
  const hidden = PUBLIC_ROUTES.includes(pathname);
  const unread = useUnread(!hidden);

  if (hidden) return null;

  const section = '/' + (pathname.split('/')[1] ?? '');
  const owner = OWNED_BY[section] ?? section;

  return (
    <nav
      aria-label="Primary"
      className="border-border bg-surface/95 fixed inset-x-0 bottom-0 z-50 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto flex w-full max-w-2xl">
        {TABS.map((tab) => {
          const active = owner === tab.href;
          const Icon = tab.icon;
          const badge = 'badge' in tab && tab.badge ? unread : undefined;

          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={`relative flex min-h-[56px] flex-col items-center justify-center gap-1 text-[11px] leading-none font-medium ${
                  active ? 'text-accent' : 'text-ink-muted'
                }`}
              >
                <span className="relative">
                  <Icon />
                  {badge ? (
                    <span
                      aria-label={`${badge} waiting for a reply`}
                      className="bg-accent absolute -top-1.5 left-3.5 min-w-[18px] rounded-full px-1 text-center text-[10px] leading-[18px] font-semibold text-white"
                    >
                      {badge}
                    </span>
                  ) : null}
                </span>
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const ICON_PROPS = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

function FunnelIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 4h18l-7 8v7l-4 2v-9L3 4z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="m9 11 3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function BoxIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8z" />
      <path d="m3 8 9 5 9-5M12 13v8" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5M12 3v12" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
