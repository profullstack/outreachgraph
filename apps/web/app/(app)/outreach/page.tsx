import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CampaignIntake } from '../../../components/campaign-intake';
import { CampaignList } from '../../../components/campaign-list';
import { BulkUrlIntake } from '../../../components/bulk-url-intake';
import { PageGuide } from '../../../components/page-guide';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchCampaignSummaries,
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
  let campaigns: CampaignSummaryView[] = [];
  let offline = false;

  try {
    // Only the campaign list is read here now. The signed-in user and the
    // profile were fetched for the two banners the guide has taken over, and
    // the guide reads them through the same memoized client.
    campaigns = await fetchCampaignSummaries();
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Outreach</h1>
        <p className="text-ink-muted text-sm">
          Paste the companies you want to reach. Everything downstream starts here.
        </p>
      </header>

      {/*
        Both prerequisites for a useful run — a confirmed address and a filled
        in profile — used to be two bespoke banners here. They are computed
        action items now, which means they read the same on this page as on
        every other one and disappear on their own once satisfied. Neither was
        ever enforced here in any case: the API is what gates the spend.

        `campaign` is suppressed because the box that starts one is directly
        below; telling someone to go to the page they are reading is noise.
      */}
      <PageGuide page="outreach" suppress={['campaign']} />

      {offline ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      ) : (
        <>
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
