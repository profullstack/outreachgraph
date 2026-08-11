import Link from 'next/link';
import {
  ApiAuthError,
  ApiUnavailableError,
  fetchApprovals,
  fetchSignals,
  relativeTime,
} from '../lib/api';

export const dynamic = 'force-dynamic';

/**
 * Today — the prospecting inbox (PRD §25.1).
 *
 * Answers one question on open: what deserves my attention right now?
 */
export default async function TodayPage() {
  let approvals: Awaited<ReturnType<typeof fetchApprovals>> = [];
  let signals: Awaited<ReturnType<typeof fetchSignals>> = [];
  let offline = false;
  let unauthorized = false;

  try {
    [approvals, signals] = await Promise.all([fetchApprovals(), fetchSignals()]);
  } catch (error) {
    // A misconfigured deployment should explain itself, not return a 500.
    if (error instanceof ApiUnavailableError) offline = true;
    else if (error instanceof ApiAuthError) unauthorized = true;
    else throw error;
  }

  if (unauthorized) {
    return (
      <div className="pt-8">
        <h1 className="text-xl font-semibold">Not authorized</h1>
        <p className="text-ink-muted mt-2 text-sm">
          The API rejected this deployment&apos;s credentials. Check that{' '}
          <code className="text-ink">API_TOKEN</code>,{' '}
          <code className="text-ink">WORKSPACE_ID</code> and{' '}
          <code className="text-ink">ORGANIZATION_ID</code> are set on the web service and match the
          API.
        </p>
      </div>
    );
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
