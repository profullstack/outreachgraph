import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BulkUrlIntake } from '../../../components/bulk-url-intake';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchMe,
  fetchProfile,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Outreach · OutreachGraph' };

/**
 * Outreach — where a run starts (PRD §8).
 *
 * Its own destination because the intake had been living at the top of the
 * prospect list, called "Add from company websites", and anyone looking for
 * somewhere to begin outreach never found it. The funnel now has a front door
 * with the name people go looking for.
 */
export default async function OutreachPage() {
  let me;
  let profile;
  let offline = false;

  try {
    [me, profile] = await Promise.all([fetchMe(), fetchProfile()]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  const verified = me?.emailVerified ?? false;

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Outreach</h1>
        <p className="text-ink-muted text-sm">
          Paste the companies you want to reach. Everything downstream starts here.
        </p>
      </header>

      {offline ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <>
          {/* Both of these change what a run produces rather than whether it
              runs, so they are said here and not enforced here — the API is
              what actually gates the spend. */}
          {!verified ? (
            <p className="border-border bg-surface-raised mb-3 rounded-2xl border p-4 text-sm">
              Confirm your email address first — we check it before running anything that costs
              money. The link is in your inbox.
            </p>
          ) : null}

          {verified && profile && !profile.configured ? (
            <Link
              href="/setup"
              className="border-accent/40 bg-accent/5 mb-3 block rounded-2xl border p-4"
            >
              <span className="text-sm font-medium">Tell us what you sell first</span>
              <span className="text-ink-muted mt-1 block text-[13px] leading-relaxed">
                Until you do, every draft is grounded in placeholder text and the scoring has no
                idea who a good fit is.
              </span>
            </Link>
          ) : null}

          <BulkUrlIntake />

          <p className="text-ink-muted mt-4 text-center text-sm">
            Chasing one person instead? <Link href="/prospects">Add them by GitHub handle</Link>.
          </p>
        </>
      )}
    </div>
  );
}
