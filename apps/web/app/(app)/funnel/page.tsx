import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FunnelChart, LeadTimelineChart } from '../../../components/funnel-chart';
import { PageGuide } from '../../../components/page-guide';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchAnalytics,
  fetchCampaigns,
  fetchTimeline,
  type AnalyticsView,
  type CampaignRow,
  type LeadTimelineView,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Funnel · OutreachGraph' };

/**
 * The sales view (PRD §25).
 *
 * Everything else in this app is arranged around the machinery — signals,
 * prospects, approvals. This page is arranged around the question a
 * salesperson actually opens a tool to ask: how many are in play, where are
 * they stuck, and what has gone out this week.
 *
 * It reads from the stage event log rather than from current status, which is
 * what makes "reached" a real number rather than a snapshot of who happens to
 * be sitting in a stage right now.
 */
export default async function FunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const { campaign } = await searchParams;

  let analytics: AnalyticsView | undefined;
  let leads: LeadTimelineView[] = [];
  let campaigns: CampaignRow[] = [];
  let offline = false;

  try {
    [analytics, leads, campaigns] = await Promise.all([
      fetchAnalytics(campaign),
      fetchTimeline(campaign),
      fetchCampaigns(),
    ]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  if (offline || !analytics) {
    return (
      <div className="pt-4">
        <h1 className="text-xl font-semibold">Funnel</h1>
        <p className="border-border text-ink-muted mt-4 rounded-2xl border border-dashed p-8 text-center text-sm">
          Waiting for the API.
        </p>
      </div>
    );
  }

  const selected = campaigns.find((row) => row.id === campaign);

  return (
    <div className="pt-4">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Funnel</h1>
        <p className="text-ink-muted text-sm">
          {selected ? selected.name : 'Every campaign in this workspace'}
        </p>
      </header>

      <PageGuide page="funnel" />

      {campaigns.length > 1 ? (
        <nav className="mb-4 flex flex-wrap gap-2">
          <FilterChip href="/funnel" active={!campaign} label="All" />
          {campaigns.slice(0, 8).map((row) => (
            <FilterChip
              key={row.id}
              href={`/funnel?campaign=${encodeURIComponent(row.id)}`}
              active={campaign === row.id}
              label={row.name}
              autopilot={row.approval_mode === 'trusted_automation'}
            />
          ))}
        </nav>
      ) : null}

      <section className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Sent this week" value={analytics.sentThisWeek} />
        <Stat label="Replies" value={analytics.repliesThisWeek} />
        <Stat label="Awaiting you" value={analytics.awaitingApproval} />
        <Stat
          label="On autopilot"
          value={`${analytics.autopilotCampaigns}/${analytics.activeCampaigns}`}
        />
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold">Stages</h2>
        <FunnelChart stages={analytics.funnel.stages} lost={analytics.funnel.lost} />

        {analytics.medianHoursToContact !== undefined ? (
          <p className="text-ink-muted mt-3 text-xs">
            Typically {formatHours(analytics.medianHoursToContact)} from finding someone to writing
            to them.
          </p>
        ) : null}
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold">Each lead, over time</h2>
        <p className="text-ink-muted mb-3 text-xs">
          One row per lead. Width is time spent in a stage, so anything stalled is visibly wide.
        </p>
        <LeadTimelineChart leads={leads} />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border-border bg-surface-raised rounded-2xl border p-3">
      <p className="text-ink-muted text-xs">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function FilterChip({
  href,
  active,
  label,
  autopilot,
}: {
  href: string;
  active: boolean;
  label: string;
  autopilot?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1.5 text-xs ${
        active ? 'border-accent bg-accent/10 text-accent' : 'border-border text-ink-muted'
      }`}
    >
      {autopilot ? '● ' : ''}
      {label}
    </Link>
  );
}

function formatHours(hours: number): string {
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}
