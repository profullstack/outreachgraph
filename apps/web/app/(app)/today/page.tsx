import Link from 'next/link';
import { redirect } from 'next/navigation';
import { VerifyBanner } from '../../../components/verify-banner';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchApprovals,
  fetchMe,
  fetchProfile,
  fetchSignals,
  relativeTime,
} from '../../../lib/api';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Today · OutreachGraph' };

/**
 * Today — the prospecting inbox (PRD §25.1).
 *
 * Answers one question on open: what deserves my attention right now? This is
 * the signed-in home; `/` is the public landing page.
 */
export default async function TodayPage() {
  let approvals: Awaited<ReturnType<typeof fetchApprovals>> = [];
  let signals: Awaited<ReturnType<typeof fetchSignals>> = [];
  let me: Awaited<ReturnType<typeof fetchMe>> | undefined;
  let profile: Awaited<ReturnType<typeof fetchProfile>> | undefined;
  let offline = false;

  try {
    [approvals, signals, me, profile] = await Promise.all([
      fetchApprovals(),
      fetchSignals(),
      fetchMe(),
      fetchProfile(),
    ]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  const top = approvals[0];

  return (
    <div className="pt-4">
      {me && !me.emailVerified ? <VerifyBanner email={me.user.email} /> : null}

      {/* Until this is done every draft is grounded in placeholder text, so it
          is worth interrupting for once rather than hiding in a settings page. */}
      {me?.emailVerified && profile && !profile.configured ? (
        <Link
          href="/setup"
          className="border-accent/40 bg-accent/5 mb-4 block rounded-2xl border p-4"
        >
          <span className="text-sm font-medium">Tell us what you sell</span>
          <span className="text-ink-muted mt-1 block text-[13px] leading-relaxed">
            Paste your website and we will draft your profile — what you sell, who buys it, and
            where to find them. Outreach is grounded in it.
          </span>
        </Link>
      ) : null}

      <header className="mb-5">
        <h1 className="text-xl font-semibold">Today</h1>
        <p className="text-ink-muted text-sm">
          {offline ? 'Waiting for the API' : `${approvals.length} to review`}
        </p>
      </header>

      <div className="mb-5 grid grid-cols-2 gap-3">
        <Stat
          label="Awaiting approval"
          value={offline ? '—' : String(approvals.length)}
          href="/approvals"
        />
        <Stat
          label="Recent signals"
          value={offline ? '—' : String(signals.length)}
          href="/signals"
        />
      </div>

      {top ? (
        <section>
          <h2 className="text-ink-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
            Highest opportunity
          </h2>
          <Link
            href="/approvals"
            className="border-border bg-surface-raised block rounded-2xl border p-4"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate font-semibold">{top.display_name}</span>
              <span className="text-accent font-semibold tabular-nums">
                {top.opportunity ?? '—'}
              </span>
            </div>
            <p className="text-ink-muted mt-1 truncate text-sm">{top.current_title ?? '—'}</p>
            {top.signal_summary ? (
              <p className="mt-3 text-sm">
                {top.signal_summary}
                <span className="text-ink-muted"> · {relativeTime(top.signal_at)}</span>
              </p>
            ) : null}
          </Link>
        </section>
      ) : null}

      {/*
        An empty queue has two very different causes, and telling them apart
        is the difference between a working product and a broken-looking one.
        With no prospects at all there is nothing for the pipeline to act on,
        so the only useful thing to say is "add one" — the old copy promised
        signals that could never arrive.
      */}
      {!offline && approvals.length === 0 ? (
        <div className="border-border rounded-2xl border border-dashed p-8 text-center">
          <p className="text-sm font-medium">Nothing waiting.</p>
          <p className="text-ink-muted mt-1 text-sm">
            {signals.length === 0
              ? 'Add a prospect and the pipeline will research them, collect public signals and score the opportunity.'
              : 'Signals are arriving; recommendations appear when one is worth acting on.'}
          </p>
          <Link
            href="/outreach"
            className="bg-accent mt-4 inline-flex items-center justify-center rounded-xl px-5 py-3 text-sm font-medium text-white"
          >
            Start outreach
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <Link href={href} className="border-border bg-surface-raised rounded-2xl border p-4">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-ink-muted mt-1 text-xs">{label}</div>
    </Link>
  );
}
