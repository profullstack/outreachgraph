import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ApiUnavailableError,
  NotAuthenticatedError,
  fetchApprovals,
  fetchSignals,
  relativeTime,
} from '../../lib/api';

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
  let offline = false;

  try {
    [approvals, signals] = await Promise.all([fetchApprovals(), fetchSignals()]);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) redirect('/login');
    if (error instanceof ApiUnavailableError) offline = true;
    else throw error;
  }

  const top = approvals[0];

  return (
    <div className="pt-4">
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

      {!offline && approvals.length === 0 ? (
        <p className="border-border text-ink-muted rounded-2xl border border-dashed p-8 text-center text-sm">
          Nothing waiting. Recommendations appear as fresh signals arrive.
        </p>
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
