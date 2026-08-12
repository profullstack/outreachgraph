import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SignOutButton } from '../../../components/sign-out-button';
import { ApiUnavailableError, NotAuthenticatedError, fetchMe } from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'More · OutreachGraph' };

const SECTIONS = [
  { label: 'Campaigns', hint: 'Wizard not built yet' },
  { label: 'Conversations', hint: 'Interaction tracking only' },
  { label: 'Integrations', hint: 'GitHub only so far' },
  { label: 'Usage', hint: 'Metering recorded, not enforced' },
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
