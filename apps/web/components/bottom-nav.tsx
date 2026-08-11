'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Phone-first bottom navigation (PRD §1.1 "Mobile Navigation").
 *
 * Five destinations, thumb-reachable, sitting above the home indicator. The
 * desktop layout expands this into the full §25 navigation.
 */
const TABS = [
  { href: '/', label: 'Today', icon: SunIcon },
  { href: '/signals', label: 'Signals', icon: BoltIcon },
  { href: '/prospects', label: 'Prospects', icon: PeopleIcon },
  { href: '/approvals', label: 'Approvals', icon: CheckIcon },
  { href: '/more', label: 'More', icon: DotsIcon },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="border-border bg-surface/95 fixed inset-x-0 bottom-0 z-50 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto flex w-full max-w-2xl">
        {TABS.map((tab) => {
          const active = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href);
          const Icon = tab.icon;

          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-[56px] flex-col items-center justify-center gap-1 text-[11px] font-medium ${
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

function BoltIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
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
