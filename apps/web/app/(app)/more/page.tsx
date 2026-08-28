import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageGuide } from '../../../components/page-guide';
import { SignOutButton } from '../../../components/sign-out-button';
import { WorkspaceSwitcher } from '../../../components/workspace-switcher';
import { ApiUnavailableError, NotAuthenticatedError, fetchMe } from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'More · OutreachGraph' };

/** Real destinations, listed above the things that are still placeholders. */
const LINKS = [
  {
    href: '/products',
    label: 'Products',
    hint: 'Everything you sell — each with its own buyers, voice and campaign',
  },
  {
    href: '/team',
    label: 'Team',
    hint: 'Invite colleagues, and see who already has access',
  },
  {
    href: '/settings',
    label: 'Settings',
    hint: 'Your sending mailbox, Bluesky, alerts, link tracking, autopilot limits',
  },
  {
    href: '/import',
    label: 'Import contacts',
    hint: 'A CSV of people who already know you — cleaned and checked on the way in',
  },
  {
    href: '/billing',
    label: 'Billing',
    hint: 'Your plan, what is left of it this month, and prospect credits',
  },
  {
    href: '/cadences',
    label: 'Plans',
    hint: 'A sequence of touches over days, not one message and silence',
  },
  {
    href: '/research',
    label: 'Research',
    hint: 'Ask the same questions of a whole list, answered into a table',
  },
  { href: '/rules', label: 'Rules', hint: 'When this happens do that — and what it has cost' },
  { href: '/signals', label: 'Signals', hint: 'The raw observations behind every score' },
  {
    href: '/setup',
    label: 'Setup',
    hint: 'Describe one product: its claims, its buyers, its voice',
  },
  { href: '/funnel', label: 'Funnel', hint: 'Stages, conversion and each lead over time' },
] as const;

const SECTIONS = [
  { label: 'Conversations', hint: 'Replies are read and scored; no threaded view yet' },
  { label: 'CRM integrations', hint: 'Website and GitHub are sources; the mailbox is in Settings' },
  { label: 'Scheduling links', hint: 'Needs a calendar connection we do not have yet' },
] as const;

/** Desktop expands the bottom nav into the full §25 navigation. */
export default async function MorePage() {
  let me;

  try {
    me = await fetchMe();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (!(error instanceof ApiUnavailableError)) throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">More</h1>
        {me ? (
          <p className="text-ink-muted text-sm">
            Signed in as {me.user.email} · {me.role}
          </p>
        ) : null}
      </header>

      <PageGuide page="more" />

      {/* Renders nothing for the ordinary case: one workspace, and no
          permission to add another. */}
      {me ? (
        <WorkspaceSwitcher
          workspaces={me.workspaces ?? []}
          currentId={me.workspaceId}
          canCreate={me.role === 'owner' || me.role === 'admin'}
        />
      ) : null}

      <ul className="border-border divide-border mb-6 divide-y overflow-hidden rounded-2xl border">
        {LINKS.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className="bg-surface-raised block p-4">
              <div className="font-medium">{link.label}</div>
              <div className="text-ink-muted text-xs">{link.hint}</div>
            </Link>
          </li>
        ))}
      </ul>

      <p className="text-ink-muted mb-2 text-xs">Not built yet</p>

      <ul className="border-border divide-border divide-y overflow-hidden rounded-2xl border">
        {SECTIONS.map((section) => (
          <li key={section.label} className="bg-surface-raised p-4">
            <div className="font-medium">{section.label}</div>
            <div className="text-ink-muted text-xs">{section.hint}</div>
          </li>
        ))}
      </ul>

      <div className="mt-6">
        <SignOutButton />
      </div>

      <p className="text-ink-muted mt-6 text-center text-xs">
        <Link href="/today" className="underline">
          Back to Today
        </Link>
      </p>
    </div>
  );
}
