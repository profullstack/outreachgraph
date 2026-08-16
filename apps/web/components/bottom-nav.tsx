'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Phone-first bottom navigation (PRD §1.1 "Mobile Navigation").
 *
 * Thumb-reachable destinations sitting above the home indicator. The desktop
 * layout expands this into the full §25 navigation.
 *
 * Ordered along the funnel — start a run, watch what comes back, work the
 * list, approve — because the first question a new account has is "where do I
 * begin", and the answer has to be a tab rather than a form buried at the top
 * of another screen.
 *
 * Signals moved to More to make room for Funnel. Six is already the most
 * labels that fit a 375px phone without wrapping, and between "the raw
 * observations we collected" and "where every lead stands", the second is the
 * one someone opens the app to see. Signals is still a route and still linked.
 */
const TABS = [
  { href: '/today', label: 'Today', icon: SunIcon },
  { href: '/outreach', label: 'Outreach', icon: SendIcon },
  { href: '/funnel', label: 'Funnel', icon: FunnelIcon },
  { href: '/prospects', label: 'Prospects', icon: PeopleIcon },
  { href: '/approvals', label: 'Approvals', icon: CheckIcon },
  { href: '/more', label: 'More', icon: DotsIcon },
] as const;

/** Public routes: the app chrome would be meaningless before signing in. */
const PUBLIC_ROUTES = ['/', '/login', '/offline'];

export function BottomNav() {
  const pathname = usePathname();

  if (PUBLIC_ROUTES.includes(pathname)) return null;

  return (
    <nav
      aria-label="Primary"
      className="border-border bg-surface/95 fixed inset-x-0 bottom-0 z-50 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto flex w-full max-w-2xl">
        {TABS.map((tab) => {
          // Exact match, or a nested route beneath this tab.
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          const Icon = tab.icon;

          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                // 10px rather than 11: six labels have to clear "Prospects" and
                // "Approvals" on a 375px phone without wrapping to two lines.
                className={`flex min-h-[56px] flex-col items-center justify-center gap-1 text-[10px] leading-none font-medium ${
                  active ? 'text-accent' : 'text-ink-muted'
                }`}
              >
                <Icon />
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

function SunIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M21.5 2.5 11 13" />
      <path d="M21.5 2.5 15 21l-4-8-8-4 18.5-6.5z" />
    </svg>
  );
}

function FunnelIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 4h18l-7 8v7l-4 2v-9L3 4z" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
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

function DotsIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </svg>
  );
}
