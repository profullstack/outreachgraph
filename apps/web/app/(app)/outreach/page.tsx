import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CampaignIntake } from '../../../components/campaign-intake';
import { CampaignList } from '../../../components/campaign-list';
import { BulkUrlIntake } from '../../../components/bulk-url-intake';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchCampaignSummaries,
  fetchMe,
  fetchProfile,
  type CampaignSummaryView,
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
  let campaigns: CampaignSummaryView[] = [];
  let offline = false;

  try {
    [me, profile, campaigns] = await Promise.all([
      fetchMe(),
      fetchProfile(),
      fetchCampaignSummaries(),
    ]);
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

          <CampaignIntake />

          {/* Still here, and still useful — but no longer the front door. Most
              people are starting from a market rather than from a list they
              have already built, and the box above takes both. */}
          <details className="border-border bg-surface-raised mt-4 rounded-2xl border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Already have a list of companies?
            </summary>
            <p className="text-ink-muted mt-1 mb-3 text-[13px] leading-relaxed">
              Paste or upload up to a hundred URLs at once. They join your existing campaign.
            </p>
            <BulkUrlIntake />
          </details>

          {/*
            Every campaign, not just the one being started.

            Running several markets at once was already possible — the intake
            creates a new campaign each time — but nothing in the interface
            showed the others, so a second campaign was indistinguishable from a
            first one that had lost its work.
          */}
          <section className="mt-6">
            <h2 className="text-ink-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
              Your campaigns
            </h2>
            <CampaignList initial={campaigns} />
          </section>

          <p className="text-ink-muted mt-4 text-center text-sm">
            Watch what comes back on the <Link href="/funnel">Funnel</Link>.
          </p>
        </>
      )}
    </div>
  );
}
